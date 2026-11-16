// Brief: background for a NEW session, taken from other sessions' conversations.
// Used when the router starts a new session (for example because the matching session is busy
// with a long queue): the new session has no history, so the panel reads the recent dialogue of
// the related sessions and has one headless Claude call write what the new session must know.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// A session with this many messages waiting in the panel's delivery queue is busy:
// the router does not add more to it and starts a new session instead.
const BUSY_QUEUE = Number(process.env.CC_BUSY_QUEUE) || 2;

/** Text of one transcript message, or '' for tool calls, tool results and panel/system noise. */
function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join('\n');
}

/**
 * The user/assistant dialogue in a transcript (JSONL text), newest last.
 * @returns {{role: 'user'|'assistant', text: string}[]} at most maxTurns entries,
 *   each cut to maxChars, the whole set cut to totalChars (oldest dropped first)
 */
function parseDialogue(jsonl, { maxTurns = 30, maxChars = 800, totalChars = 12000 } = {}) {
  const out = [];
  for (const line of String(jsonl || '').split('\n')) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    if ((j.type !== 'user' && j.type !== 'assistant') || j.isMeta || j.isSidechain || !j.message) continue;
    let text = messageText(j.message.content).trim();
    // command wrappers, reminders and hook output start with a tag; they are not the dialogue
    if (!text || /^<[a-z-]+[ >]/i.test(text)) continue;
    text = text.replace(/\s+/g, ' ');
    if (text.length > maxChars) text = text.slice(0, maxChars) + '…';
    out.push({ role: j.type, text });
  }
  let turns = out.slice(-maxTurns);
  while (turns.length > 1 && turns.reduce((a, t) => a + t.text.length, 0) > totalChars) turns = turns.slice(1);
  return turns;
}

/** The last `bytes` of a file as text ('' when it cannot be read). */
function readTail(file, bytes = 2 * 1024 * 1024) {
  let fd;
  try {
    const size = fs.statSync(file).size, len = Math.min(size, bytes);
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** The recent dialogue of a session from its transcript file (reads the last 2 MB). */
function readDialogue(file, opts) { return parseDialogue(readTail(file), opts); }

/**
 * Messages waiting in Claude Code's OWN queue (typed into the session while Claude works).
 * Claude Code writes {"type":"queue-operation","operation":"enqueue"|"dequeue"|"remove"} lines.
 * Only meaningful while the session works: an idle Claude has taken every queued message.
 */
function claudeQueue(jsonl) {
  let n = 0;
  for (const line of String(jsonl || '').split('\n')) {
    if (!line.includes('"queue-operation"')) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type !== 'queue-operation') continue;
    if (j.operation === 'enqueue') n++;
    else if (j.operation === 'dequeue' || j.operation === 'remove') n = Math.max(0, n - 1);
  }
  return n;
}

/** The language to write the brief in: the request's, not the conversations' (eval: english-request). */
function requestLanguage(text) { return /[\u4e00-\u9fff]/.test(text) ? 'Chinese' : 'English'; }

/**
 * @param {string} text the user's request
 * @param {{name: string, folder: string, queued?: number, dialogue: {role, text}[]}[]} sources
 */
function buildBriefPrompt(text, sources) {
  const blocks = sources.map((s) => `<session name=${JSON.stringify(s.name)} folder=${JSON.stringify(s.folder)}>\n` +
    s.dialogue.map((t) => `${t.role === 'user' ? 'USER' : 'CLAUDE'}: ${t.text}`).join('\n') + '\n</session>').join('\n\n');
  return `A user's request goes to a NEW Claude Code session. It has no history. Below are the recent conversations of the user's other sessions.

${blocks}

<request>
${text}
</request>

Write the background the new session needs to do this request well: the goal, facts, decisions the user made, file paths, commands, the current state, and open problems. Take only what is relevant to the request, from the conversations above. Do not invent anything. Do not answer or plan the request.
State only what the conversations show. Do not claim that something was NOT done or does not exist; you only see part of each conversation (write "the conversation does not say" instead).
Use short sentences, at most about 200 words. Write in ${requestLanguage(text)}, the language of the request, even when the conversations use another language.
If nothing in the conversations is relevant to the request, reply exactly: NONE`;
}

/** One headless Claude call -> the brief text, or '' when nothing is relevant or the call fails. */
function runBrief(text, sources, { model, cwd } = {}) {
  const usable = sources.filter((s) => s.dialogue && s.dialogue.length);
  if (!usable.length) return Promise.resolve('');
  return new Promise((resolve) => {
    const args = ['-p', buildBriefPrompt(text, usable), '--model', model || process.env.CC_BRIEF_MODEL || 'sonnet',
      '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} }),
      '--disallowedTools', 'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit,TodoWrite,Agent'];
    const dir = cwd || path.join(require('./instance').instance().home, 'router');
    fs.mkdirSync(dir, { recursive: true });
    execFile('claude', args, { cwd: dir, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      let r = '';
      try { r = String(JSON.parse(out).result || '').trim(); } catch { r = ''; }
      resolve(!r || /^NONE\.?$/i.test(r) ? '' : r);
    });
  });
}

/** The message the new session gets: the background first, then the request. */
function withBrief(text, brief, names) {
  if (!brief) return text;
  return `[Background from the session${names.length > 1 ? 's' : ''} ${names.map((n) => `"${n}"`).join(', ')}, prepared by Thoth] ${brief}\n\n[Request] ${text}`;
}

module.exports = { requestLanguage, BUSY_QUEUE, parseDialogue, readTail, readDialogue, claudeQueue, buildBriefPrompt, runBrief, withBrief };
