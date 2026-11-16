'use strict';
// Chat view: renders a session's transcript like the Claude app does —
// markdown, highlighted code with Copy, tables, KaTeX math, images, and
// collapsed tool calls. Polls /api/chat; keeps the scroll at the bottom
// unless the user scrolled up.

const params = new URLSearchParams(location.search);
const win = params.get('win') || '';
// the app's Website look (Theme.swift, Thoth > Appearance): chat.css styles html.website
if (params.get('look') === 'website') document.documentElement.classList.add('website');
const log = document.getElementById('log');
const jump = document.getElementById('jump');
const working = document.getElementById('working');
const lightbox = document.getElementById('lightbox');

// ---------- markdown ----------
marked.use(markedKatex({ throwOnError: false, nonStandard: true }));
marked.use({ gfm: true, breaks: false });

// mermaid diagrams (```mermaid blocks), themed like the page
const dark = !document.documentElement.classList.contains('website') && matchMedia('(prefers-color-scheme: dark)').matches;
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
let diagramSeq = 0;
async function renderDiagram(holder, source) {
  try {
    const { svg } = await mermaid.render(`mmd-${++diagramSeq}`, source);
    holder.innerHTML = svg;
    holder.classList.add('diagram-ok');
  } catch {
    holder.classList.add('diagram-failed');
    holder.textContent = 'Could not draw this diagram.'; // the source stays below
    holder.parentElement?.querySelector('details')?.setAttribute('open', '');
  }
}

// Native bridge (WKScriptMessageHandler "panel"): clipboard and downloads go
// through the app, because page clipboard/download APIs are limited in WKWebView.
function toNative(msg) {
  const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.panel;
  if (h) { h.postMessage(msg); return true; }
  return false;
}
function copyText(text) {
  if (!toNative({ type: 'copy', text })) navigator.clipboard?.writeText(text);
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function renderMarkdown(text) {
  // \( \) and \[ \] delimiters, as the Claude app supports them
  const src = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `$$${m}$$`).replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => `$${m}$`);
  // keep KaTeX's MathML source (<semantics>/<annotation encoding>) so formulas can be named by their TeX
  const html = DOMPurify.sanitize(marked.parse(src), { ADD_ATTR: ['target', 'encoding'], ADD_TAGS: ['semantics', 'annotation'] });
  const box = document.createElement('div');
  box.className = 'md';
  box.innerHTML = html;
  for (const pre of box.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    const lang = ((code && code.className.match(/language-([\w+-]+)/)) || [])[1] || '';
    if (lang === 'mermaid' && code) {
      const fig = document.createElement('figure');
      fig.className = 'diagram';
      fig.setAttribute('role', 'img');
      fig.setAttribute('aria-label', 'Mermaid diagram');
      const holder = document.createElement('div');
      const src = document.createElement('details');
      src.innerHTML = '<summary>Diagram source</summary>';
      const srcPre = document.createElement('pre');
      srcPre.textContent = code.textContent;
      src.appendChild(srcPre);
      fig.append(holder, src);
      pre.replaceWith(fig);
      renderDiagram(holder, code.textContent);
      continue;
    }
    if (code) shiki(pre, code.textContent, lang);
    const wrap = document.createElement('div');
    wrap.className = 'code';
    wrap.innerHTML = `<div class="code-head"><span>${esc(lang || 'code')}</span><button type="button" aria-label="Copy code">Copy</button></div>`;
    pre.replaceWith(wrap);
    wrap.appendChild(pre);
    wrap.querySelector('button').onclick = (e) => {
      copyText(code ? code.textContent : pre.textContent);
      e.target.textContent = 'Copied';
      setTimeout(() => { e.target.textContent = 'Copy'; }, 1200);
    };
  }
  for (const t of box.querySelectorAll('table')) {
    const w = document.createElement('div');
    w.className = 'table-wrap';
    t.replaceWith(w);
    w.appendChild(t);
  }
  for (const a of box.querySelectorAll('a')) a.target = '_blank';
  // formulas: one accessible element named after their TeX source
  for (const k of box.querySelectorAll('.katex')) {
    const tex = k.querySelector('annotation');
    k.setAttribute('role', 'img');
    k.setAttribute('aria-label', `Formula: ${tex ? tex.textContent.trim() : k.textContent}`);
  }
  return box;
}

// shiki runs on the server (same highlighter as the Claude app); plain text until it answers
async function shiki(pre, text, lang) {
  try {
    const r = await fetch('/api/highlight', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: text, lang }) });
    if (!r.ok) return;
    const { html } = await r.json();
    const tmp = document.createElement('div');
    tmp.innerHTML = DOMPurify.sanitize(html);
    const out = tmp.firstElementChild;
    if (out && pre.isConnected) { out.setAttribute('aria-label', `Code (${lang || 'text'}), highlighted`); pre.replaceWith(out); }
  } catch { /* keep plain text */ }
}

// Images: shown at their own aspect ratio (bigger when alone), open in a
// preview with Download, like the Claude app.
function imgEl(im) {
  const src = im.src || `/api/attachment?path=${encodeURIComponent(im.path)}`;
  const name = im.path ? im.path.split('/').pop() : 'image';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'thumb';
  btn.setAttribute('aria-label', `Open image ${name}`);
  const el = document.createElement('img');
  el.src = src;
  el.alt = name;
  el.onerror = () => btn.remove(); // a path outside the attachments folder is not served
  btn.appendChild(el);
  btn.onclick = () => openPreview(src, name);
  return btn;
}

let previewSrc = '', previewName = '';
function openPreview(src, name) {
  previewSrc = src; previewName = name;
  lightbox.querySelector('img').src = src;
  lightbox.classList.remove('hidden');
  document.getElementById('lb-close').focus();
}
function closePreview() { lightbox.classList.add('hidden'); }
lightbox.onclick = (e) => { if (e.target === lightbox) closePreview(); };
document.getElementById('lb-close').onclick = closePreview;
document.getElementById('lb-download').onclick = () => {
  const abs = new URL(previewSrc, location.href).href;
  if (!toNative({ type: 'saveImage', src: abs, name: previewName })) {
    const a = document.createElement('a'); a.href = abs; a.download = previewName; a.click();
  }
};
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePreview(); });

const FILE_ICON = { pdf: '📕', csv: '📊', tsv: '📊', json: '🧾', md: '📝', txt: '📄', log: '📄', ipynb: '📓' };
function fileGroup(files) {
  const box = document.createElement('div');
  box.className = 'files';
  for (const f of files) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'file';
    const shown = f.name.replace(/^\d{10,}-/, ''); // copies are named "<millis>-<original>"
    b.setAttribute('aria-label', `Open file ${shown}`);
    b.innerHTML = `<span class="ficon">${FILE_ICON[f.ext] || '📄'}</span><span class="fname">${esc(shown)}</span><span class="fext">${esc(f.ext.toUpperCase())}</span>`;
    if (f.ext === 'pdf') {
      // a sharp first-page preview (rendered at 2x by Quick Look on the server)
      b.classList.add('with-preview');
      const img = document.createElement('img');
      img.className = 'fpreview';
      img.alt = `Preview of ${shown}`;
      img.src = `/api/thumb?path=${encodeURIComponent(f.path)}&size=${Math.round(220 * (window.devicePixelRatio || 2))}`;
      img.onerror = () => { img.remove(); b.classList.remove('with-preview'); };
      // inside a button the image is merged into the button for accessibility; say it loaded
      img.onload = () => b.setAttribute('aria-label', `Open file ${shown}, with preview`);
      b.prepend(img);
    }
    b.onclick = () => toNative({ type: 'openFile', path: f.path });
    box.appendChild(b);
  }
  return box;
}

function imageGroup(images) {
  const box = document.createElement('div');
  box.className = images.length === 1 ? 'imgs single' : 'imgs grid';
  images.forEach((im) => box.appendChild(imgEl(im)));
  return box;
}

// ---------- thinking (like the Claude app's "Thought process" step) ----------
// Open by default; the user's choice is remembered per block. Hover shows
// "Copy as quote". Without a summary only "Thought for Ns" is shown.
function stepOpen(key) {
  try { const v = localStorage.getItem(`think:${key}`); return v === null ? true : v === '1'; } catch { return true; }
}
function rememberStep(key, open) { try { localStorage.setItem(`think:${key}`, open ? '1' : '0'); } catch { /* private */ } }
const SPARK = '<svg class="step-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l1.4 3.6 3.6 1.4-3.6 1.4L8 11.5 6.6 7.9 3 6.5l3.6-1.4z" fill="currentColor"/></svg>';
const CHEVRON = '<svg class="step-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function thinkingStep(b) {
  const step = document.createElement('div');
  step.className = 'step thinking';
  const open = stepOpen(b.key);
  step.classList.toggle('open', open);
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'step-head';
  head.setAttribute('aria-expanded', String(open));
  head.setAttribute('aria-label', 'Thought process');
  head.innerHTML = `${SPARK}<span class="step-label">Thought process</span>${CHEVRON}`;
  const actions = document.createElement('div');
  actions.className = 'step-actions';
  actions.setAttribute('aria-label', 'Thinking actions');
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'act';
  copy.textContent = 'Copy as quote';
  copy.setAttribute('aria-label', 'Copy as quote');
  copy.onclick = () => { copyText(asQuote(b.text)); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy as quote'; }, 1200); };
  actions.appendChild(copy);
  const body = renderMarkdown(b.text);
  body.classList.add('step-body');
  head.onclick = () => {
    const now = !step.classList.contains('open');
    step.classList.toggle('open', now);
    head.setAttribute('aria-expanded', String(now));
    rememberStep(b.key, now);
  };
  const row = document.createElement('div');
  row.className = 'step-row';
  row.append(head, actions);
  step.append(row, body);
  return step;
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString([], today ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// hover bar under each message: time + Copy (like the Claude app)
function actions(it) {
  const bar = document.createElement('div');
  bar.className = 'actions';
  const text = it.role === 'user' ? it.text : it.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
  bar.innerHTML = `<span class="time">${esc(fmtTime(it.ts))}</span>`;
  if (it.role === 'assistant' && it.turnSeconds) {
    const w = document.createElement('span');
    w.className = 'worked';
    w.textContent = `Worked for ${roughDuration(it.turnSeconds)}`;
    bar.prepend(w);
  }
  if (text.trim()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'act';
    b.setAttribute('aria-label', 'Copy message');
    b.title = 'Copy message';
    b.textContent = 'Copy';
    b.onclick = () => { copyText(text); b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1200); };
    bar.appendChild(b);
  }
  return bar;
}

function renderItem(it) {
  const el = document.createElement('section');
  el.className = `msg ${it.role}`;
  el.dataset.id = it.id;
  if (it.role === 'user') {
    if (it.images && it.images.length) el.appendChild(imageGroup(it.images));
    if (it.files && it.files.length) el.appendChild(fileGroup(it.files));
    const shown = new Set([...(it.images || []).map((i) => i.path), ...(it.files || []).map((f) => f.path)]);
    const text = it.text.split(/(\s+)/).filter((w) => !shown.has(w)).join('').trim();
    if (text) {
      const b = document.createElement('div');
      b.className = 'bubble';
      b.textContent = text;
      el.appendChild(b);
    }
    el.appendChild(actions(it));
    return el;
  }
  for (const b of it.blocks) {
    if (b.type === 'text') { el.appendChild(renderMarkdown(b.text)); continue; }
    if (b.type === 'thinking') { el.appendChild(thinkingStep(b)); continue; }
    const d = document.createElement('details');
    d.className = 'tool';
    d.innerHTML = `<summary><span class="st ${esc(b.status)}"></span><span class="name">${esc(b.name)}</span><span class="sum">${esc(b.summary)}</span></summary>`;
    if (b.result) { const pre = document.createElement('pre'); pre.textContent = b.result; d.appendChild(pre); }
    if (b.images && b.images.length) {
      d.appendChild(imageGroup(b.images));
      d.open = true;
    }
    el.appendChild(d);
    // images Claude sent with SendUserFile are part of the message, not hidden in the tool row
    if (b.sent && b.status === 'done') {
      if (b.sent.caption) { const c = document.createElement('p'); c.className = 'sent-caption'; c.textContent = b.sent.caption; el.appendChild(c); }
      const g = imageGroup(b.sent.images.map((im) => ({ path: im.path, src: `/api/sent?win=${encodeURIComponent(win)}&path=${encodeURIComponent(im.path)}` })));
      g.classList.add('sent');
      el.appendChild(g);
    }
  }
  if (it.endsTurn) el.appendChild(actions(it)); // one bar per turn, not under every step
  return el;
}

// ---------- updates ----------
let mtime = 0;
let thinkingSince = null, thinkingEnded = null, lastThinkingSecs = 0;
const rendered = new Map(); // id -> json of last render
function atBottom() { return window.innerHeight + window.scrollY >= document.body.scrollHeight - 40; }

function apply(items) {
  const stick = atBottom() || rendered.size === 0;
  if (!items.length) { log.innerHTML = '<p class="empty">No messages yet.</p>'; rendered.clear(); pendingKey = ''; return; }
  if (rendered.size === 0) { log.innerHTML = ''; pendingKey = ''; }
  const ids = new Set(items.map((i) => i.id));
  for (const [id] of rendered) if (!ids.has(id)) { log.querySelector(`[data-id="${CSS.escape(id)}"]`)?.remove(); rendered.delete(id); }
  let prev = null;
  for (const it of items) {
    const key = JSON.stringify(it);
    let el = log.querySelector(`[data-id="${CSS.escape(it.id)}"]`);
    if (rendered.get(it.id) !== key) {
      const fresh = renderItem(it);
      // keep open tool details open across re-renders
      if (el) {
        const open = [...el.querySelectorAll('details')].map((d) => d.open);
        fresh.querySelectorAll('details').forEach((d, i) => { if (open[i]) d.open = true; });
        el.replaceWith(fresh);
      } else if (prev) prev.after(fresh); else log.prepend(fresh);
      el = fresh;
      rendered.set(it.id, key);
    }
    prev = el;
  }
  if (stick) window.scrollTo(0, document.body.scrollHeight);
}

// Messages sent from the composer that the transcript does not have yet (server.js echoes):
// Claude Code writes a prompt only after its prompt hooks, and the brain's takes seconds.
// They show at the end of the log, marked "Sending…", until the real message arrives.
let pendingKey = '';
let pending = [];
const PHASE = {
  sending: 'Sending…',
  brain: 'Searching the brain for related context…',
  working: 'Claude is working…',
};
function applyPending(list) {
  pending = list;
  const key = JSON.stringify(list.map((p) => [p.at, p.text]));
  if (key === pendingKey) return;
  pendingKey = key;
  const stick = atBottom();
  log.querySelectorAll('.msg.pending').forEach((e) => e.remove());
  if (list.length) log.querySelector('.empty')?.remove();
  for (const p of list) {
    const el = document.createElement('section');
    el.className = 'msg user pending';
    const b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = p.text;
    const note = document.createElement('div');
    note.className = 'actions';
    note.innerHTML = '<span class="time">Sending…</span>';
    el.append(b, note);
    log.appendChild(el);
  }
  if (stick) window.scrollTo(0, document.body.scrollHeight);
}

let polling = false, pollAgain = false, pollTimer = null;
async function poll() {
  if (polling) { pollAgain = true; return; }
  polling = true;
  clearTimeout(pollTimer);
  try {
    const r = await fetch(`/api/chat?win=${encodeURIComponent(win)}&since=${mtime}`);
    if (r.ok) {
      const j = await r.json();
      if (!j.unchanged) { mtime = j.mtime; apply(j.items || []); }
      applyPending(j.pending || []);
    }
    const st = await (await fetch('/api/state')).json();
    const s = (st.sessions || []).find((x) => x.id === win);
    const busy = !!s && s.state === 'working';
    log.classList.toggle('busy', busy); // the running turn has no final time yet
    // the live spinner line from Claude's terminal (transcripts are written per block, so there is no token stream)
    let text = busy ? (s.live || 'Claude is working…') : '';
    const secs = busy ? liveThinkingSeconds(s.live) : null;
    const now = Date.now();
    if (secs !== null) {
      if (!thinkingSince) thinkingSince = now - secs * 1000;
      lastThinkingSecs = secs;
      text = `${thinkingLabel(secs)} ${s.live.replace(/^.*?…\s*/, '')}`; // e.g. "Still thinking… (18s · thinking with high effort)"
    } else if (thinkingSince) {
      // the Claude app keeps the active label ≥ 2 s, then shows "Thought for Ns" for 2 s
      if (!thinkingEnded) thinkingEnded = now;
      const activeFor = now - thinkingSince;
      if (now < thinkingEnded + Math.max(0, MIN_ACTIVE_MS - activeFor)) text = thinkingLabel(lastThinkingSecs);
      else if (now < thinkingEnded + Math.max(0, MIN_ACTIVE_MS - activeFor) + DONE_SHOW_MS) text = thoughtFor(lastThinkingSecs);
      else { thinkingSince = thinkingEnded = null; }
    }
    // a sent message not in the transcript yet: say which step it is in
    if (pending.length) text = PHASE[pending[pending.length - 1].phase] || PHASE.sending;
    working.classList.toggle('hidden', !text);
    if (text) {
      working.querySelector('.live').textContent = text;
      working.setAttribute('aria-label', `Claude is working: ${text}`);
    }
  } catch { /* server restarting */ }
  polling = false;
  pollTimer = setTimeout(poll, pollAgain ? 0 : pending.length ? 300 : 1000);
  pollAgain = false;
}
// the app calls this right after a send, so the message shows without waiting for the next poll
window.pollNow = () => { poll(); };

window.addEventListener('scroll', () => jump.classList.toggle('hidden', atBottom()));
jump.onclick = () => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
poll();
