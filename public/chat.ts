// Chat view: renders a session's transcript like the Claude app does —
// markdown, highlighted code with Copy, tables, KaTeX math, images, and
// collapsed tool calls. Polls /api/chat; keeps the scroll at the bottom
// unless the user scrolled up.
import {
  DONE_SHOW_MS,
  MIN_ACTIVE_MS,
  asQuote,
  liveThinkingSeconds,
  roughDuration,
  thinkingLabel,
  thoughtFor,
} from './thinking.js';

// ---------- the items of /api/chat (lib/chat.ts) ----------
interface ImageRef {
  src?: string;
  path?: string;
}
interface FileRef {
  path: string;
  name: string;
  ext: string;
}
interface TextBlock {
  type: 'text';
  text: string;
}
interface ThinkingBlock {
  type: 'thinking';
  text: string;
  key: string;
}
interface ToolBlock {
  type: 'tool';
  name: string;
  summary: string;
  status: string;
  result?: string;
  images?: ImageRef[];
  sent?: { caption?: string; images: { path: string }[]; files?: FileRef[] };
}
type Block = TextBlock | ThinkingBlock | ToolBlock;
interface UserItem {
  id: string;
  role: 'user';
  ts?: string | number;
  text: string;
  images?: ImageRef[];
  files?: FileRef[];
}
interface AssistantItem {
  id: string;
  role: 'assistant';
  ts?: string | number;
  blocks: Block[];
  turnSeconds?: number;
  endsTurn?: boolean;
}
type Item = UserItem | AssistantItem;
interface Pending {
  at: number;
  text: string;
  phase?: string;
}
interface ChatAnswer {
  unchanged?: boolean;
  mtime: number;
  items?: Item[];
  pending?: Pending[];
}
interface StateAnswer {
  sessions?: { id: string; state: string; live?: string }[];
}

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing`);
  return el;
}

const params = new URLSearchParams(location.search);
const win = params.get('win') ?? '';
// the app's Website look (Theme.swift, Thoth > Appearance): chat.css styles html.website
if (params.get('look') === 'website') document.documentElement.classList.add('website');
const log = byId('log');
const jump = byId('jump');
const working = byId('working');
const lightbox = byId('lightbox');

// ---------- markdown ----------
marked.use(markedKatex({ throwOnError: false, nonStandard: true }));
marked.use({ gfm: true, breaks: false });

// mermaid diagrams (```mermaid blocks), themed like the page
const dark =
  !document.documentElement.classList.contains('website') && matchMedia('(prefers-color-scheme: dark)').matches;
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
let diagramSeq = 0;
async function renderDiagram(holder: HTMLElement, source: string): Promise<void> {
  try {
    const { svg } = await mermaid.render(`mmd-${String(++diagramSeq)}`, source);
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
function toNative(msg: Record<string, string>): boolean {
  const h = window.webkit?.messageHandlers?.panel;
  if (h) {
    h.postMessage(msg);
    return true;
  }
  return false;
}
function copyText(text: string): void {
  // WKWebView may have no clipboard API at all
  const clip = navigator.clipboard as Clipboard | undefined;
  if (!toNative({ type: 'copy', text }) && clip) void clip.writeText(text);
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s: unknown): string {
  return String(s).replaceAll(/[&<>"']/g, (c) => ESC[c] ?? c);
}

function renderMarkdown(text: string): HTMLDivElement {
  // \( \) and \[ \] delimiters, as the Claude app supports them
  const src = text
    .replaceAll(/\\\[([\s\S]+?)\\\]/g, (_, m: string) => `$$${m}$$`)
    .replaceAll(/\\\(([\s\S]+?)\\\)/g, (_, m: string) => `$${m}$`);
  // keep KaTeX's MathML source (<semantics>/<annotation encoding>) so formulas can be named by their TeX
  const html = DOMPurify.sanitize(marked.parse(src, { async: false }), {
    ADD_ATTR: ['target', 'encoding'],
    ADD_TAGS: ['semantics', 'annotation'],
  });
  const box = document.createElement('div');
  box.className = 'md';
  box.innerHTML = html;
  for (const pre of box.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    const lang = (code ? /language-([\w+-]+)/.exec(code.className) : null)?.[1] ?? '';
    if (lang === 'mermaid' && code) {
      const fig = document.createElement('figure');
      fig.className = 'diagram';
      fig.setAttribute('role', 'img');
      fig.setAttribute('aria-label', 'Mermaid diagram');
      const holder = document.createElement('div');
      const source = document.createElement('details');
      source.innerHTML = '<summary>Diagram source</summary>';
      const srcPre = document.createElement('pre');
      srcPre.textContent = code.textContent;
      source.append(srcPre);
      fig.append(holder, source);
      pre.replaceWith(fig);
      void renderDiagram(holder, code.textContent);
      continue;
    }
    if (code) void shiki(pre, code.textContent, lang);
    const wrap = document.createElement('div');
    wrap.className = 'code';
    wrap.innerHTML = `<div class="code-head"><span>${esc(lang || 'code')}</span><button type="button" aria-label="Copy code">Copy</button></div>`;
    pre.replaceWith(wrap);
    wrap.append(pre);
    const button = wrap.querySelector('button');
    if (button)
      button.addEventListener('click', () => {
        copyText(code ? code.textContent : pre.textContent);
        button.textContent = 'Copied';
        setTimeout(() => {
          button.textContent = 'Copy';
        }, 1200);
      });
  }
  for (const t of box.querySelectorAll('table')) {
    const w = document.createElement('div');
    w.className = 'table-wrap';
    t.replaceWith(w);
    w.append(t);
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
async function shiki(pre: HTMLPreElement, text: string, lang: string): Promise<void> {
  try {
    const r = await fetch('/api/highlight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: text, lang }),
    });
    if (!r.ok) return;
    const { html } = (await r.json()) as { html: string };
    const tmp = document.createElement('div');
    tmp.innerHTML = DOMPurify.sanitize(html);
    const out = tmp.firstElementChild;
    if (out && pre.isConnected) {
      out.setAttribute('aria-label', `Code (${lang || 'text'}), highlighted`);
      pre.replaceWith(out);
    }
  } catch {
    /* keep plain text */
  }
}

// Images: shown at their own aspect ratio (bigger when alone), open in a
// preview with Download, like the Claude app.
function imgEl(im: ImageRef): HTMLButtonElement {
  const src = im.src ?? `/api/attachment?path=${encodeURIComponent(im.path ?? '')}`;
  const name = im.path === undefined ? 'image' : (im.path.split('/').pop() ?? '');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'thumb';
  btn.setAttribute('aria-label', `Open image ${name}`);
  const el = document.createElement('img');
  el.src = src;
  el.alt = name;
  el.addEventListener('error', () => {
    btn.remove(); // a path outside the attachments folder is not served
  });
  btn.append(el);
  btn.addEventListener('click', () => {
    openPreview(src, name);
  });
  return btn;
}

let previewSrc = '',
  previewName = '';
function openPreview(src: string, name: string): void {
  previewSrc = src;
  previewName = name;
  const img = lightbox.querySelector('img');
  if (img) img.src = src;
  lightbox.classList.remove('hidden');
  byId('lb-close').focus();
}
function closePreview(): void {
  lightbox.classList.add('hidden');
}
lightbox.addEventListener('click', (e) => {
  if (e.target === lightbox) closePreview();
});
byId('lb-close').addEventListener('click', closePreview);
byId('lb-download').addEventListener('click', () => {
  const abs = new URL(previewSrc, location.href).href;
  if (!toNative({ type: 'saveImage', src: abs, name: previewName })) {
    const a = document.createElement('a');
    a.href = abs;
    a.download = previewName;
    a.click();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePreview();
});

const FILE_ICON: Record<string, string> = {
  pdf: '📕',
  csv: '📊',
  tsv: '📊',
  json: '🧾',
  md: '📝',
  txt: '📄',
  log: '📄',
  ipynb: '📓',
};
// sent: files Claude sent with SendUserFile. /api/file checks them against this session's
// transcript; the attachments-only routes (/api/thumb, openFile) do not serve them.
function fileGroup(files: FileRef[], { sent = false }: { sent?: boolean } = {}): HTMLDivElement {
  const box = document.createElement('div');
  box.className = 'files';
  for (const f of files) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'file';
    const shown = f.name.replace(/^\d{10,}-/, ''); // copies are named "<millis>-<original>"
    b.setAttribute('aria-label', `Open file ${shown}`);
    b.innerHTML = `<span class="ficon">${FILE_ICON[f.ext] ?? '📄'}</span><span class="fname">${esc(shown)}</span><span class="fext">${esc(f.ext.toUpperCase())}</span>`;
    if (f.ext === 'pdf') {
      // a sharp first-page preview (rendered at 2x by Quick Look on the server)
      b.classList.add('with-preview');
      const img = document.createElement('img');
      img.className = 'fpreview';
      img.alt = `Preview of ${shown}`;
      const px = String(Math.round(220 * (window.devicePixelRatio || 2)));
      img.src = sent
        ? `/api/file?win=${encodeURIComponent(win)}&path=${encodeURIComponent(f.path)}&thumb=${px}`
        : `/api/thumb?path=${encodeURIComponent(f.path)}&size=${px}`;
      img.addEventListener('error', () => {
        img.remove();
        b.classList.remove('with-preview');
      });
      // inside a button the image is merged into the button for accessibility; say it loaded
      img.addEventListener('load', () => {
        b.setAttribute('aria-label', `Open file ${shown}, with preview`);
      });
      b.prepend(img);
    }
    b.addEventListener('click', () => {
      if (!sent) {
        toNative({ type: 'openFile', path: f.path });
        return;
      }
      const q = `win=${encodeURIComponent(win)}&path=${encodeURIComponent(f.path)}`;
      if (!toNative({ type: 'openSent', win, path: f.path })) window.open(`/api/file?${q}`, '_blank');
    });
    box.append(b);
  }
  return box;
}

function imageGroup(images: ImageRef[]): HTMLDivElement {
  const box = document.createElement('div');
  box.className = images.length === 1 ? 'imgs single' : 'imgs grid';
  for (const im of images) box.append(imgEl(im));
  return box;
}

// ---------- thinking (like the Claude app's "Thought process" step) ----------
// Open by default; the user's choice is remembered per block. Hover shows
// "Copy as quote". Without a summary only "Thought for Ns" is shown.
function stepOpen(key: string): boolean {
  try {
    const v = localStorage.getItem(`think:${key}`);
    return v === null ? true : v === '1';
  } catch {
    return true;
  }
}
function rememberStep(key: string, open: boolean): void {
  try {
    localStorage.setItem(`think:${key}`, open ? '1' : '0');
  } catch {
    /* private */
  }
}
const SPARK =
  '<svg class="step-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l1.4 3.6 3.6 1.4-3.6 1.4L8 11.5 6.6 7.9 3 6.5l3.6-1.4z" fill="currentColor"/></svg>';
const CHEVRON =
  '<svg class="step-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function thinkingStep(b: ThinkingBlock): HTMLDivElement {
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
  const acts = document.createElement('div');
  acts.className = 'step-actions';
  acts.setAttribute('aria-label', 'Thinking actions');
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'act';
  copy.textContent = 'Copy as quote';
  copy.setAttribute('aria-label', 'Copy as quote');
  copy.addEventListener('click', () => {
    copyText(asQuote(b.text));
    copy.textContent = 'Copied';
    setTimeout(() => {
      copy.textContent = 'Copy as quote';
    }, 1200);
  });
  acts.append(copy);
  const body = renderMarkdown(b.text);
  body.classList.add('step-body');
  head.addEventListener('click', () => {
    const now = !step.classList.contains('open');
    step.classList.toggle('open', now);
    head.setAttribute('aria-expanded', String(now));
    rememberStep(b.key, now);
  });
  const row = document.createElement('div');
  row.className = 'step-row';
  row.append(head, acts);
  step.append(row, body);
  return step;
}

function fmtTime(ts: string | number | undefined): string {
  if (ts === undefined || ts === '' || ts === 0) return '';
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString(
    [],
    today
      ? { hour: '2-digit', minute: '2-digit' }
      : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  );
}

// hover bar under each message: time + Copy (like the Claude app)
function actions(it: Item): HTMLDivElement {
  const bar = document.createElement('div');
  bar.className = 'actions';
  const text =
    it.role === 'user'
      ? it.text
      : it.blocks
          .filter((b): b is TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n\n');
  bar.innerHTML = `<span class="time">${esc(fmtTime(it.ts))}</span>`;
  if (it.role === 'assistant' && it.turnSeconds !== undefined && it.turnSeconds !== 0) {
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
    b.addEventListener('click', () => {
      copyText(text);
      b.textContent = 'Copied';
      setTimeout(() => {
        b.textContent = 'Copy';
      }, 1200);
    });
    bar.append(b);
  }
  return bar;
}

function renderItem(it: Item): HTMLElement {
  const el = document.createElement('section');
  el.className = `msg ${it.role}`;
  el.dataset['id'] = it.id;
  if (it.role === 'user') {
    const images = it.images ?? [],
      files = it.files ?? [];
    if (images.length > 0) el.append(imageGroup(images));
    if (files.length > 0) el.append(fileGroup(files));
    const shown = new Set<string | undefined>([...images.map((i) => i.path), ...files.map((f) => f.path)]);
    const text = it.text
      .split(/(\s+)/)
      .filter((w) => !shown.has(w))
      .join('')
      .trim();
    if (text) {
      const b = document.createElement('div');
      b.className = 'bubble';
      b.textContent = text;
      el.append(b);
    }
    el.append(actions(it));
    return el;
  }
  for (const b of it.blocks) {
    if (b.type === 'text') {
      el.append(renderMarkdown(b.text));
      continue;
    }
    if (b.type === 'thinking') {
      el.append(thinkingStep(b));
      continue;
    }
    const d = document.createElement('details');
    d.className = 'tool';
    d.innerHTML = `<summary><span class="st ${esc(b.status)}"></span><span class="name">${esc(b.name)}</span><span class="sum">${esc(b.summary)}</span></summary>`;
    if (b.result !== undefined && b.result !== '') {
      const pre = document.createElement('pre');
      pre.textContent = b.result;
      d.append(pre);
    }
    if (b.images && b.images.length > 0) {
      d.append(imageGroup(b.images));
      d.open = true;
    }
    el.append(d);
    // what Claude sent with SendUserFile is part of the message, not hidden in the tool row
    if (b.sent && b.status === 'done') {
      if (b.sent.caption !== undefined && b.sent.caption !== '') {
        const c = document.createElement('p');
        c.className = 'sent-caption';
        c.textContent = b.sent.caption;
        el.append(c);
      }
      if (b.sent.images.length > 0) {
        const g = imageGroup(
          b.sent.images.map((im) => ({
            path: im.path,
            src: `/api/sent?win=${encodeURIComponent(win)}&path=${encodeURIComponent(im.path)}`,
          })),
        );
        g.classList.add('sent');
        el.append(g);
      }
      // other files (a PDF, a document) as file cards
      if (b.sent.files && b.sent.files.length > 0) el.append(fileGroup(b.sent.files, { sent: true }));
    }
  }
  if (it.endsTurn === true) el.append(actions(it)); // one bar per turn, not under every step
  return el;
}

// ---------- updates ----------
let mtime = 0;
let thinkingSince: number | null = null,
  thinkingEnded: number | null = null,
  lastThinkingSecs = 0;
const rendered = new Map<string, string>(); // id -> json of last render
function atBottom(): boolean {
  return window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
}

function apply(items: Item[]): void {
  const stick = atBottom() || rendered.size === 0;
  if (items.length === 0) {
    log.innerHTML = '<p class="empty">No messages yet.</p>';
    rendered.clear();
    pendingKey = '';
    return;
  }
  if (rendered.size === 0) {
    log.innerHTML = '';
    pendingKey = '';
  }
  const ids = new Set(items.map((i) => i.id));
  for (const [id] of rendered)
    if (!ids.has(id)) {
      log.querySelector(`[data-id="${CSS.escape(id)}"]`)?.remove();
      rendered.delete(id);
    }
  let prev: Element | null = null;
  for (const it of items) {
    const key = JSON.stringify(it);
    let el = log.querySelector(`[data-id="${CSS.escape(it.id)}"]`);
    if (rendered.get(it.id) !== key) {
      const fresh = renderItem(it);
      // keep open tool details open across re-renders
      if (el) {
        const open = [...el.querySelectorAll('details')].map((d) => d.open);
        for (const [i, d] of [...fresh.querySelectorAll('details')].entries()) if (open[i] === true) d.open = true;
        el.replaceWith(fresh);
      } else if (prev) prev.after(fresh);
      else log.prepend(fresh);
      el = fresh;
      rendered.set(it.id, key);
    }
    prev = el;
  }
  if (stick) window.scrollTo(0, document.body.scrollHeight);
}

// Messages sent from the composer that the transcript does not have yet (server.ts echoes):
// Claude Code writes a prompt only after its prompt hooks, and the brain's takes seconds.
// They show at the end of the log, marked "Sending…", until the real message arrives.
let pendingKey = '';
let pending: Pending[] = [];
const PHASE: Record<string, string> = {
  sending: 'Sending…',
  brain: 'Searching the brain for related context…',
  working: 'Claude is working…',
};
function applyPending(list: Pending[]): void {
  pending = list;
  const key = JSON.stringify(list.map((p) => [p.at, p.text]));
  if (key === pendingKey) return;
  pendingKey = key;
  const stick = atBottom();
  for (const e of log.querySelectorAll('.msg.pending')) e.remove();
  if (list.length > 0) log.querySelector('.empty')?.remove();
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
    log.append(el);
  }
  if (stick) window.scrollTo(0, document.body.scrollHeight);
}

let polling = false,
  pollAgain = false,
  pollTimer: ReturnType<typeof setTimeout> | undefined;
async function poll(): Promise<void> {
  if (polling) {
    pollAgain = true;
    return;
  }
  polling = true;
  clearTimeout(pollTimer);
  try {
    const r = await fetch(`/api/chat?win=${encodeURIComponent(win)}&since=${String(mtime)}`);
    if (r.ok) {
      const j = (await r.json()) as ChatAnswer;
      if (j.unchanged !== true) {
        mtime = j.mtime;
        apply(j.items ?? []);
      }
      applyPending(j.pending ?? []);
    }
    const st = (await (await fetch('/api/state')).json()) as StateAnswer;
    const s = (st.sessions ?? []).find((x) => x.id === win);
    const live = s !== undefined && s.state === 'working' ? (s.live ?? '') : null;
    const busy = live !== null;
    log.classList.toggle('busy', busy); // the running turn has no final time yet
    // the live spinner line from Claude's terminal (transcripts are written per block, so there is no token stream)
    let text = busy ? live || 'Claude is working…' : '';
    const secs = busy ? liveThinkingSeconds(live) : null;
    const now = Date.now();
    if (secs !== null && live !== null) {
      thinkingSince ??= now - secs * 1000;
      lastThinkingSecs = secs;
      text = `${thinkingLabel(secs)} ${live.replace(/^.*?…\s*/, '')}`; // e.g. "Still thinking… (18s · thinking with high effort)"
    } else if (thinkingSince !== null) {
      // the Claude app keeps the active label ≥ 2 s, then shows "Thought for Ns" for 2 s
      thinkingEnded ??= now;
      const activeFor = now - thinkingSince;
      if (now < thinkingEnded + Math.max(0, MIN_ACTIVE_MS - activeFor)) text = thinkingLabel(lastThinkingSecs);
      else if (now < thinkingEnded + Math.max(0, MIN_ACTIVE_MS - activeFor) + DONE_SHOW_MS)
        text = thoughtFor(lastThinkingSecs);
      else {
        thinkingSince = thinkingEnded = null;
      }
    }
    // a sent message not in the transcript yet: say which step it is in
    const last = pending.at(-1);
    if (last) text = PHASE[last.phase ?? ''] ?? PHASE['sending'] ?? '';
    working.classList.toggle('hidden', !text);
    if (text) {
      const liveEl = working.querySelector('.live');
      if (liveEl) liveEl.textContent = text;
      working.setAttribute('aria-label', `Claude is working: ${text}`);
    }
  } catch {
    /* server restarting */
  }
  polling = false;
  pollTimer = setTimeout(
    () => {
      void poll();
    },
    pollAgain ? 0 : pending.length > 0 ? 300 : 1000,
  );
  pollAgain = false;
}
// the app calls this right after a send, so the message shows without waiting for the next poll
window.pollNow = () => {
  void poll();
};

window.addEventListener('scroll', () => jump.classList.toggle('hidden', atBottom()));
jump.addEventListener('click', () => {
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
});
void poll();
