// Turns a Claude Code transcript (.jsonl) into chat items for the chat view.
// Pure: input is the transcript text, output is plain objects. Tested in
// a test against a real transcript excerpt.
//
// Item shapes:
//   { id, role: 'user', ts, text, images: [{src}|{path}], files: [{path, name, ext}] }
//   { id, role: 'assistant', ts, blocks: [ {type:'text', text} | {type:'thinking', text, seconds, key}
//                                          | {type:'tool', id, name, summary, status, result, images, sent?} ] }
//   sent (only on a SendUserFile tool): { caption, images: [{path}] } — the images Claude sent to the user,
//   absolute paths. The chat view shows them in the message; the server serves only these paths.
'use strict';
const path = require('path');

const HIDDEN_USER = /^\s*(<command-|<local-command|<system-reminder|<bash-|<agent-message|<task-notification|<user-prompt-submit-hook|Caveat: The messages below)/;
const IMAGE_RE = /\.(?:png|jpe?g|gif|webp|heic)$/i;
// attachment paths in a user message: images and the documents Claude Code can read
const ATTACH_RE = /(\/[^\s'"]+\.(?:png|jpe?g|gif|webp|heic|pdf|txt|md|csv|tsv|json|ya?ml|xml|html?|log|ipynb|py|js|ts|swift|java|go|rs|c|cpp|h|rb|sh|sql))(?=\s|$)/gi;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
}

function imageSrc(block) {
  const s = block && block.source;
  if (s && s.type === 'base64' && s.data) return { src: `data:${s.media_type || 'image/png'};base64,${s.data}` };
  if (s && s.type === 'url' && s.url) return { src: s.url };
  return null;
}

// Images that Claude sent with the SendUserFile tool. Relative paths are relative to the session's folder.
function sentFiles(block, cwd) {
  const input = block.input || {};
  if (block.name !== 'SendUserFile' || !Array.isArray(input.files)) return null;
  const images = input.files
    .filter((f) => typeof f === 'string' && IMAGE_RE.test(f))
    .map((f) => ({ path: path.resolve(cwd || '/', f) }));
  if (!images.length) return null;
  return { caption: typeof input.caption === 'string' ? input.caption.trim() : '', images };
}

function summarizeTool(name, input = {}) {
  const pick = (...keys) => keys.map((k) => input[k]).find((v) => typeof v === 'string' && v.trim());
  let s;
  switch (name) {
    case 'Bash': s = pick('command'); break;
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': s = pick('file_path', 'notebook_path'); break;
    case 'Glob': case 'Grep': s = pick('pattern'); break;
    case 'WebFetch': s = pick('url'); break;
    case 'WebSearch': s = pick('query'); break;
    case 'Task': case 'Agent': s = pick('description', 'prompt'); break;
    case 'TodoWrite': s = Array.isArray(input.todos) ? `${input.todos.length} todos` : ''; break;
    default: s = pick('description', 'command', 'file_path', 'url', 'query', 'path', 'name');
  }
  if (!s) { try { s = JSON.stringify(input); } catch { s = ''; } }
  return String(s).replace(/\s+/g, ' ').slice(0, 160);
}

/**
 * @param {string} jsonl transcript text
 * @param {{ limit?: number }} opts keep only the last `limit` items
 */
function parseTranscript(jsonl, { limit = 200 } = {}) {
  const items = [];
  const tools = new Map(); // tool_use id -> tool block
  let current = null; // assistant item being built (same message id)
  let lastTs = null;   // time of the previous record: a thinking block runs from there to its own time

  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.isMeta || j.isSidechain) continue;
    // a message typed while Claude was busy is stored as a queued_command attachment
    const att = j.type === 'attachment' && j.attachment && j.attachment.type === 'queued_command' ? j.attachment : null;
    if (att) {
      const text = textOf(att.prompt).trim();
      if (text && !HIDDEN_USER.test(text)) {
        const files = [];
        const images = [];
        for (const p of text.match(ATTACH_RE) || []) {
          if (IMAGE_RE.test(p)) images.push({ path: p });
          else files.push({ path: p, name: p.split('/').pop(), ext: p.split('.').pop().toLowerCase() });
        }
        items.push({ id: j.uuid, role: 'user', ts: j.timestamp, text, images, files, queued: true });
        current = null;
      }
      if (j.timestamp) lastTs = j.timestamp;
      continue;
    }
    const m = j.message;
    if (!m) continue;
    const prevTs = lastTs;
    if (j.timestamp) lastTs = j.timestamp;

    if (j.type === 'user') {
      const content = m.content;
      // tool results come back as user messages
      if (Array.isArray(content) && content.some((b) => b && b.type === 'tool_result')) {
        for (const b of content) {
          if (!b || b.type !== 'tool_result') continue;
          const t = tools.get(b.tool_use_id);
          if (!t) continue;
          t.status = b.is_error ? 'error' : 'done';
          if (t.owner && j.timestamp) t.owner.endTs = j.timestamp;
          const parts = Array.isArray(b.content) ? b.content : [{ type: 'text', text: String(b.content || '') }];
          t.result = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n').slice(0, 2000);
          t.images = parts.filter((p) => p.type === 'image').map(imageSrc).filter(Boolean);
        }
        continue;
      }
      const text = textOf(content).trim();
      if (!text && !(Array.isArray(content) && content.some((b) => b && b.type === 'image'))) continue;
      if (HIDDEN_USER.test(text)) continue;
      const images = Array.isArray(content) ? content.filter((b) => b && b.type === 'image').map(imageSrc).filter(Boolean) : [];
      const files = [];
      for (const p of text.match(ATTACH_RE) || []) {
        if (IMAGE_RE.test(p)) images.push({ path: p });
        else files.push({ path: p, name: p.split('/').pop(), ext: p.split('.').pop().toLowerCase() });
      }
      items.push({ id: j.uuid, role: 'user', ts: j.timestamp, text, images, files });
      current = null;
      continue;
    }

    if (j.type === 'assistant' && Array.isArray(m.content)) {
      if (!current || current.msgId !== m.id) {
        current = { id: j.uuid, msgId: m.id, role: 'assistant', ts: j.timestamp, endTs: j.timestamp, blocks: [] };
        items.push(current);
      }
      if (j.timestamp) current.endTs = j.timestamp;
      for (const b of m.content) {
        if (b.type === 'text' && b.text && b.text.trim()) current.blocks.push({ type: 'text', text: b.text });
        else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
          // empty text = Claude Code did not ask for summaries (showThinkingSummaries off)
          const text = b.type === 'thinking' ? String(b.thinking || '').trim() : '';
          const ms = prevTs && j.timestamp ? Date.parse(j.timestamp) - Date.parse(prevTs) : null;
          current.blocks.push({ type: 'thinking', text, seconds: ms > 0 ? Math.max(1, Math.round(ms / 1000)) : null, key: `${j.uuid}:${current.blocks.length}` });
        }
        else if (b.type === 'tool_use') {
          const t = { type: 'tool', id: b.id, name: b.name, summary: summarizeTool(b.name, b.input), status: 'running', result: '', images: [] };
          const sent = sentFiles(b, j.cwd);
          if (sent) t.sent = sent;
          tools.set(b.id, t);
          Object.defineProperty(t, 'owner', { value: current, enumerable: false });
          current.blocks.push(t);
        }
      }
    }
  }
  // Empty thinking (no summary saved) is not shown, as in the Claude app.
  for (const it of items) if (it.role === 'assistant') it.blocks = it.blocks.filter((b) => b.type !== 'thinking' || b.text);
  const out = items.filter((it) => it.role === 'user' || it.blocks.length);
  // One rough time per turn (user message -> last assistant item before the next
  // user message), shown once at the end instead of a time on every step.
  let turnStart = null;
  out.forEach((it, i) => {
    if (it.role === 'user') { turnStart = it.ts; return; }
    const next = out[i + 1];
    it.endsTurn = !next || next.role === 'user';
    if (it.endsTurn && turnStart && it.endTs) {
      const secs = Math.round((Date.parse(it.endTs) - Date.parse(turnStart)) / 1000);
      if (secs > 0) it.turnSeconds = secs;
    }
    delete it.msgId;
  });
  return out.slice(-limit);
}

// true when `file` is an image that this transcript's SendUserFile calls sent without an error
function wasSent(items, file) {
  return items.some((it) => it.role === 'assistant' && it.blocks.some((b) =>
    b.sent && b.status === 'done' && b.sent.images.some((im) => im.path === file)));
}

/**
 * Messages sent from the chat composer that the transcript does not show yet.
 * Claude Code writes a prompt to the transcript only after its UserPromptSubmit hooks end; the
 * brain hook takes about 13 s (median, 2026-11-10), so the chat shows the message itself until then.
 *   echoes: [{ text, at, phase }] (at: ms when sent), items: parseTranscript() result
 * A message has arrived when a user item from `at` - 2 s on contains its text (the transcript text
 * also has the attachment paths). One user item matches one message. After maxAge it is dropped.
 * Returns the messages still pending; the input is not changed.
 */
function pendingEchoes(echoes, items, now = Date.now(), maxAge = 120000) {
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const users = (items || []).filter((it) => it.role === 'user');
  const used = new Set();
  return (echoes || []).filter((e) => {
    if (now - e.at > maxAge) return false;
    const want = norm(e.text).slice(0, 80);
    const hit = users.find((u) => !used.has(u) && !(Date.parse(u.ts) < e.at - 2000) && norm(u.text).includes(want));
    if (hit) { used.add(hit); return false; }
    return true;
  });
}

module.exports = { parseTranscript, summarizeTool, wasSent, pendingEchoes };
