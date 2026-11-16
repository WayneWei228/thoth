'use strict';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LABEL = { needs: 'Needs you', working: 'Working', idle: 'Ready', stopped: 'Not running', elsewhere: 'Open elsewhere' };

let sessions = [];
let routes = [];
let myRoute = null;            // route id the user just submitted (auto-jump target)
let selected = null;           // window id
const prev = new Map();        // id -> last state (for notifications)
const unread = new Set();
const prefs = loadPrefs();

function loadPrefs() { try { return JSON.parse(localStorage.getItem('ccp') || '{}'); } catch { return {}; } }
function savePrefs() { try { localStorage.setItem('ccp', JSON.stringify(prefs)); } catch { /* private mode */ } }
const AGENT_NAME = { claude: 'Claude', codex: 'Codex' };
const agentOf = (x) => (x && x.agent) || 'claude';
// small "Codex" badge; nothing for Claude Code (keeps the old look)
const agentBadge = (x) => agentOf(x) === 'codex' ? '<span class="pill agent" title="Runs the Codex CLI">Codex</span>' : '';
function short(p) { return String(p || '').replace(/^\/Users\/[^/]+/, '~'); }
function ago(ms) {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 2600);
}
async function api(name, body) {
  const r = await fetch('/api/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { toast(j.error || 'Failed'); throw new Error(j.error); }
  return j;
}

// ---------- state socket ----------
function connectState() {
  const ws = new WebSocket(`ws://${location.host}/ws/state`);
  ws.onopen = () => $('#conn').classList.remove('off');
  ws.onclose = () => { $('#conn').classList.add('off'); setTimeout(connectState, 1500); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type !== 'state') return;
    onRoutes(m.routes || []);
    onState(m.sessions || []);
  };
}

function onRoutes(list) {
  const key = JSON.stringify(list);
  if (key === onRoutes.key) return;
  onRoutes.key = key;
  routes = list;
  const r = myRoute && routes.find((x) => x.id === myRoute);
  if (r && r.target && (r.decided === 'auto' || r.decided === 'auto-new' || r.decided === 'auto-new-busy' || r.decided === 'manual')) {
    myRoute = null;
    toast(`→ ${r.targetName}: ${r.reason || ''}`);
    setTimeout(() => select(r.target), 150);
  } else if (r && (r.status === 'ask' || r.status === 'error')) {
    myRoute = null;
    select(null);
  } else if (r && r.status === 'split') {
    myRoute = null;   // several tasks went to several sessions: no single session to jump to
  }
  renderRequests();
}

const RSTATUS = { split: 'Split into tasks', routing: 'Finding the right session…', sending: 'Sending…', queued: 'Waiting for session to be ready', sent: 'Sent', ask: 'Which session?', error: 'Failed' };
function renderRequests() {
  const wrap = $('#requests-wrap'), box = $('#requests');
  const list = routes.slice(0, 8);
  wrap.classList.toggle('hidden', !list.length);
  box.innerHTML = '';
  for (const r of list) {
    const row = document.createElement('div');
    row.className = `req ${r.status}${r.parent ? ' part' : ''}`;
    const when = new Date(r.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    let right = '';
    if (r.target && sessions.some((s) => s.id === r.target)) right = `<button class="chip go" data-go="${esc(r.target)}">→ ${esc(r.targetName)}</button>`;
    row.innerHTML = `<div class="req-top"><span class="req-status ${r.status}">${r.status === 'routing' ? '<span class="spin"></span>' : ''}${esc(RSTATUS[r.status] || r.status)}</span>
        <span class="req-text" title="${esc(r.text)}">${r.part ? `<span class="req-part">${esc(r.part)}</span> ` : ''}${esc(r.text)}</span>${right}<span class="req-time">${when}</span>
        <button class="x small" title="Remove" data-dismiss="1">✕</button></div>
      ${r.reason || r.error ? `<div class="req-reason">${esc(r.error || r.reason)}</div>` : ''}`;
    if (r.status === 'ask' || r.status === 'error') {
      const opts = document.createElement('div');
      opts.className = 'req-opts';
      const seen = new Set();
      for (const c of (r.choices || [])) {
        seen.add(c.id);
        opts.appendChild(mkBtn(c.name, 'btn small primary', () => routeTo(r, { target: c.id })));
      }
      for (const s of sessions) if (!seen.has(s.id) && s.state !== 'elsewhere') opts.appendChild(mkBtn(s.name, 'btn small', () => routeTo(r, { target: s.id })));
      if (r.folder) opts.appendChild(mkBtn(`+ New in ${r.folder.split('/').pop()}`, 'btn small ghost', () => routeTo(r, { folder: r.folder, name: r.newName })));
      opts.appendChild(mkBtn('+ New session…', 'btn small ghost', () => openNew(r.folder || '', r.id)));
      row.appendChild(opts);
    }
    row.querySelector('[data-dismiss]').onclick = () => api('dismissRoute', { routeId: r.id });
    const go = row.querySelector('[data-go]'); if (go) go.onclick = () => select(go.dataset.go);
    box.appendChild(row);
  }
}
function mkBtn(label, cls, fn) { const b = document.createElement('button'); b.className = cls; b.textContent = label; b.onclick = fn; return b; }
async function routeTo(r, body) {
  myRoute = r.id;
  await api('routeTo', { routeId: r.id, ...body });
}

// unified entry box
const askText = $('#ask-text');
askText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#ask').requestSubmit(); }
});
$('#ask').onsubmit = async (e) => {
  e.preventDefault();
  const text = askText.value.trim(); if (!text) return;
  askText.disabled = true;
  try {
    const { routeId } = await api('route', { text });
    myRoute = routeId; askText.value = '';
    select(null);
  } finally { askText.disabled = false; askText.focus(); }
};

function onState(list) {
  for (const s of list) {
    const p = prev.get(s.id);
    if (p && p !== s.state) {
      const who = AGENT_NAME[agentOf(s)] || 'Claude';
      if (s.state === 'needs') notify(`${s.name} needs you`, s.question || `${who} is waiting for your choice.`, s.id);
      if (p === 'working' && s.state === 'idle') {
        if (s.id !== selected || document.hidden) unread.add(s.id);
        notify(`${s.name} is done`, s.last || `${who} finished.`, s.id);
      }
    }
    prev.set(s.id, s.state);
  }
  const key = JSON.stringify(list.map(({ activity, ...rest }) => rest));
  sessions = list;
  if (selected && !sessions.some((s) => s.id === selected)) { select(null); return; }
  if (key === onState.key) return;   // nothing visible changed: keep DOM (no lost clicks)
  onState.key = key;
  render();
}

// ---------- notifications ----------
let audioCtx;
function beep() {
  try {
    audioCtx = audioCtx || new AudioContext();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880; g.gain.value = 0.06; o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.15);
  } catch { /* no audio */ }
}
function notify(title, body, id) {
  if (prefs.sound) beep();
  if (!prefs.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (!document.hidden && id === selected) return;
  const n = new Notification(title, { body: String(body).slice(0, 180), tag: id });
  n.onclick = () => { window.focus(); select(id); n.close(); };
}

// ---------- render ----------
function render() {
  if (editing) return;
  const f = $('#filter').value.trim().toLowerCase();
  const shown = sessions.filter((s) => !f || (s.name + ' ' + s.folder + ' ' + s.last).toLowerCase().includes(f));

  // group by folder
  const groups = new Map();
  for (const s of shown) { if (!groups.has(s.folder)) groups.set(s.folder, []); groups.get(s.folder).push(s); }
  const list = $('#list');
  list.innerHTML = '';
  for (const [folder, items] of groups) {
    const g = document.createElement('div');
    g.className = 'group';
    const br = items[0].branch ? `<span class="gb">⎇ ${esc(items[0].branch)}</span>` : '';
    g.innerHTML = `<div class="group-h" title="${esc(folder)}"><span>${esc(folder.split('/').pop() || folder)}</span>${br}<button class="add" title="New session in this folder">+</button></div>`;
    g.querySelector('.add').onclick = () => openNew(folder);
    for (const s of items) g.appendChild(card(s));
    list.appendChild(g);
  }

  // attention banner
  const needs = sessions.filter((s) => s.state === 'needs');
  const att = $('#attention');
  att.classList.toggle('hidden', !needs.length);
  att.textContent = needs.length === 1 ? `${needs[0].name} needs you →` : `${needs.length} sessions need you →`;
  att.onclick = () => select(needs[0].id);
  document.title = (needs.length ? `(${needs.length}) ` : '') + 'Thoth';

  renderGrid();
  renderRequests();
  if (selected) renderDetail();
}

function card(s) {
  const b = document.createElement('div');
  b.tabIndex = 0; b.dataset.id = s.id;
  b.className = `card ${s.state === 'needs' ? 'needs' : ''} ${s.id === selected ? 'active' : ''} ${unread.has(s.id) ? 'unread' : ''}`;
  const last = s.state === 'needs' ? (s.question || 'Waiting for your choice') : s.state === 'elsewhere' ? 'Still open in another window (VS Code?)' : s.last;
  b.innerHTML = `<div class="card-top"><span class="dot ${s.state}"></span><span class="card-name"><span class="nm" title="Double-click to rename">${esc(s.name)}</span>${agentBadge(s)}${s.title ? `<span class="sub">${esc(s.title)}</span>` : ''}</span><button class="edit" title="Rename">✎</button><span class="card-time">${esc(LABEL[s.state])} · ${ago(s.activity)}</span></div>
    <div class="card-last">${esc(last || '')}</div>`;
  b.onclick = (e) => { if (!e.target.closest('input')) select(s.id); };
  b.onkeydown = (e) => { if (e.key === 'Enter' && e.target === b) select(s.id); };
  b.querySelector('.edit').onclick = (e) => { e.stopPropagation(); editName(b.querySelector('.nm'), s); };
  b.querySelector('.nm').ondblclick = (e) => { e.stopPropagation(); editName(b.querySelector('.nm'), s); };
  b.oncontextmenu = (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, s); };
  return b;
}

// inline rename: el is the element that shows the name
let editing = false;
function editName(el, s) {
  if (!el || editing) return;
  editing = true;
  const input = document.createElement('input');
  input.className = 'rename'; input.value = s.name; input.maxLength = 30;
  el.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const name = input.value.trim();
    editing = false;
    if (save && name && name !== s.name) {
      s.name = name;
      try { await api('rename', { id: s.id, name }); toast(`Renamed to "${name}"`); } catch { /* toast shown */ }
    }
    onState.key = ''; render();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  input.onclick = (e) => e.stopPropagation();
  input.onblur = () => finish(true);
}

function renderGrid() {
  const grid = $('#grid');
  grid.innerHTML = '';
  $('#empty').classList.toggle('hidden', sessions.length > 0);
  const order = { needs: 0, working: 1, idle: 2, elsewhere: 3, stopped: 4 };
  for (const s of [...sessions].sort((a, b) => order[a.state] - order[b.state])) {
    const t = document.createElement('button');
    t.className = `tile ${s.state}`;
    t.innerHTML = `<div class="tile-top"><span class="dot ${s.state}"></span><span class="tile-name">${esc(s.name)}${agentBadge(s)}${s.title ? `<span class="sub">${esc(s.title)}</span>` : ''}</span><span class="pill ${s.state}">${esc(LABEL[s.state])}</span></div>
      <div class="tile-folder">${esc(short(s.folder))}${s.branch ? ' · ⎇ ' + esc(s.branch) : ''}</div>
      ${s.prompt ? `<div class="tile-prompt">You: ${esc(s.prompt)}</div>` : ''}
      <div class="tile-last">${esc(s.state === 'needs' ? (s.question || 'Waiting for your choice') : (s.last || '—'))}</div>`;
    t.onclick = () => select(s.id);
    t.oncontextmenu = (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, s); };
    grid.appendChild(t);
  }
}

function cur() { return sessions.find((s) => s.id === selected); }

function renderDetail() {
  const s = cur(); if (!s) return;
  $('#d-dot').className = `dot ${s.state}`;
  $('#d-name').textContent = s.name;
  $('#d-title').textContent = s.title || '';
  $('#d-agent').classList.toggle('hidden', agentOf(s) !== 'codex');
  msg.placeholder = `Message ${AGENT_NAME[agentOf(s)] || 'Claude'}…  (Enter to send, Shift+Enter for new line)`;
  const pill = $('#d-state'); pill.className = `pill ${s.state}`; pill.textContent = LABEL[s.state];
  $('#d-folder').textContent = short(s.folder); $('#d-folder').title = s.folder;
  $('#d-branch').textContent = s.branch || '';
  $('#a-start').classList.toggle('hidden', s.running);
  $('#a-start').textContent = s.sid ? '▶ Resume' : '▶ Start';
  $('#a-stop').classList.toggle('hidden', s.state !== 'working');

  // choice bar
  const ch = $('#choice');
  if (s.state === 'needs' && s.options.length) {
    ch.classList.remove('hidden');
    $('#choice-q').textContent = s.question || `${AGENT_NAME[agentOf(s)] || 'Claude'} needs your decision`;
    const key = JSON.stringify(s.options);
    if (ch.dataset.key !== key) {
      ch.dataset.key = key;
      const box = $('#choice-opts'); box.innerHTML = '';
      for (const o of s.options) {
        const b = document.createElement('button');
        b.className = 'btn' + (/^yes/i.test(o.label) ? ' yes' : /^no/i.test(o.label) ? ' no' : ''); b.textContent = o.label; b.title = o.label;
        b.onclick = async () => { b.disabled = true; try { await api('choose', { id: s.id, n: o.n }); } finally { b.disabled = false; } term.focus(); };
        box.appendChild(b);
      }
    }
  } else { ch.classList.add('hidden'); ch.dataset.key = ''; }

  // notice
  const nt = $('#notice');
  if (s.state === 'elsewhere') {
    nt.innerHTML = 'This conversation is still open in another window (probably VS Code). Type <b>/exit</b> there first, then click <b>▶ Resume</b>. Running it in two places at once can mix up the conversation.';
    nt.classList.remove('hidden');
  } else if (s.state === 'stopped') {
    const who = AGENT_NAME[agentOf(s)] || 'Claude';
    nt.innerHTML = s.sid ? `${who} is not running here. Click <b>▶ Resume</b> to continue this conversation.` : `${who} is not running here. Click <b>▶ Start</b>.`;
    nt.classList.remove('hidden');
  } else nt.classList.add('hidden');
  $('#composer').classList.toggle('hidden', !s.running);
}

// ---------- terminal ----------
const term = new Terminal({
  fontFamily: '"SF Mono", Menlo, "PingFang SC", monospace', fontSize: 13, lineHeight: 1.15,
  cursorBlink: true, allowProposedApi: true, scrollback: 0, macOptionIsMeta: true,
  theme: { background: '#1b1b1a', foreground: '#e8e6e1', cursor: '#c96442', selectionBackground: '#4a4a46' },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.loadAddon(new WebLinksAddon.WebLinksAddon());
let termWs = null;
let opened = false;

function attach(id) {
  if (termWs) { termWs.onclose = null; termWs.close(); termWs = null; }
  if (!opened) { term.open($('#term')); opened = true; }
  term.reset();
  fit.fit();
  const ws = new WebSocket(`ws://${location.host}/ws/term?win=${encodeURIComponent(id)}&cols=${term.cols}&rows=${term.rows}`);
  ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : '');
  ws.onclose = () => { if (selected === id && termWs === ws) setTimeout(() => selected === id && attach(id), 1000); };
  termWs = ws;
  setTimeout(() => term.focus(), 50);
}
term.onData((d) => { if (termWs && termWs.readyState === 1) termWs.send(d); });
function refit() {
  if (!opened || $('#detail').classList.contains('hidden')) return;
  fit.fit();
  if (termWs && termWs.readyState === 1) termWs.send(`\x00resize:${term.cols},${term.rows}`);
}
new ResizeObserver(() => { clearTimeout(refit.t); refit.t = setTimeout(refit, 60); }).observe($('#term-wrap'));

// ---------- selection ----------
function select(id) {
  selected = id;
  unread.delete(id);
  $('#overview').classList.toggle('hidden', !!id);
  $('#detail').classList.toggle('hidden', !id);
  if (id) { renderDetail(); requestAnimationFrame(() => attach(id)); }
  else if (termWs) { termWs.onclose = null; termWs.close(); termWs = null; }
  render();
}

// ---------- detail actions ----------
$('#a-start').onclick = async () => {
  const s = cur(); if (!s) return;
  if (s.state === 'elsewhere' && !confirm('This conversation still looks open in another window. Resume here anyway?')) return;
  await api('start', { id: s.id });
};
$('#a-stop').onclick = () => cur() && api('interrupt', { id: selected });
$('#a-finder').onclick = () => cur() && api('reveal', { folder: cur().folder });
$('#a-code').onclick = () => cur() && api('reveal', { folder: cur().folder, app: 'code' });
$('#a-close').onclick = () => closeSession(cur());
async function closeSession(s) {
  if (!s) return;
  if (!confirm(`Close "${s.name}"?\n\nClaude will exit. The conversation is saved and you can continue it later with + New.`)) return;
  await api('close', { id: s.id });
  if (selected === s.id) select(null);
}
$('#d-name').ondblclick = () => rename(cur());
$('#d-edit').onclick = () => rename(cur());
function rename(s) {
  if (!s) return;
  const cardEl = document.querySelector(`.card[data-id="${CSS.escape(s.id)}"] .nm`);
  if (s.id === selected) {
    const h = $('#d-name'), span = document.createElement('span');
    span.textContent = s.name; h.textContent = ''; h.appendChild(span);
    editName(span, s);
  } else editName(cardEl, s);
}

// composer
const msg = $('#msg');
msg.addEventListener('input', () => { msg.style.height = 'auto'; msg.style.height = Math.min(msg.scrollHeight, 160) + 'px'; });
msg.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); }
});
$('#composer').onsubmit = async (e) => {
  e.preventDefault();
  const text = msg.value; if (!text.trim() || !selected) return;
  await api('send', { id: selected, text: text.replace(/\n/g, ' ') });
  msg.value = ''; msg.style.height = 'auto';
};

// ---------- context menu ----------
function showMenu(x, y, s) {
  const m = $('#menu');
  const items = [
    ['Open', () => select(s.id)],
    ['Rename…', () => rename(s)],
    !s.running && [s.sid ? 'Resume' : 'Start', () => api('start', { id: s.id })],
    s.state === 'working' && ['Stop (Esc)', () => api('interrupt', { id: s.id })],
    ['New session in this folder', () => openNew(s.folder)],
    ['Show in Finder', () => api('reveal', { folder: s.folder })],
    ['Open in VS Code', () => api('reveal', { folder: s.folder, app: 'code' })],
    ['Close session', () => closeSession(s), 'danger'],
  ].filter(Boolean);
  m.innerHTML = '';
  for (const [label, fn, cls] of items) {
    const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls;
    b.onclick = () => { hideMenu(); fn(); }; m.appendChild(b);
  }
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
}
function hideMenu() { $('#menu').classList.add('hidden'); }
document.addEventListener('click', (e) => { if (!$('#menu').contains(e.target)) hideMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideMenu(); closeModal(); } });

// ---------- new session modal ----------
let modalRoute = null;
// agent for "Start new": remembered in localStorage; Codex is off when the server says it is not available
let newAgent = (() => { try { return localStorage.getItem('ccp.agent') === 'codex' ? 'codex' : 'claude'; } catch { return 'claude'; } })();
function setAgent(a, save = true) {
  newAgent = a;
  if (save) try { localStorage.setItem('ccp.agent', a); } catch { /* private mode */ }
  for (const b of document.querySelectorAll('#m-agent [data-agent]')) {
    const on = b.dataset.agent === a;
    b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on));
  }
}
for (const b of document.querySelectorAll('#m-agent [data-agent]')) b.onclick = () => setAgent(b.dataset.agent);
async function loadAgents() {
  let list = null;
  try { const r = await fetch('/api/agents'); if (r.ok) list = await r.json(); } catch { /* old server */ }
  const codex = Array.isArray(list) && list.find((a) => a.id === 'codex');
  const ok = !!(codex && codex.available);
  const reason = (codex && codex.reason) || (list ? 'Codex is not available.' : 'This server cannot start Codex.');
  const btn = $('#m-agent [data-agent="codex"]');
  btn.disabled = !ok;
  btn.title = ok ? 'Start the Codex CLI in this folder' : reason;
  const note = $('#m-agent-note');
  note.textContent = ok ? '' : `Codex: ${reason}`;
  note.classList.toggle('hidden', ok);
  // Codex off: use Claude Code now, but keep the saved choice for later
  if (!ok && newAgent === 'codex') setAgent('claude', false);
}
setAgent(newAgent, false);
async function openNew(folder, routeId) {
  modalRoute = routeId || null;
  $('#modal').classList.remove('hidden');
  try { setAgent(localStorage.getItem('ccp.agent') === 'codex' ? 'codex' : 'claude', false); } catch { /* private mode */ }
  loadAgents();
  $('#m-folder').value = folder || '';
  const rec = await (await fetch('/api/folders')).json();
  const box = $('#m-recent'); box.innerHTML = '';
  for (const r of rec.slice(0, 14)) {
    const c = document.createElement('button');
    c.className = 'chip'; c.textContent = r.folder.split('/').pop(); c.title = r.folder;
    c.onclick = () => { $('#m-folder').value = r.folder; loadHistory(); };
    box.appendChild(c);
  }
  loadHistory();
}
window.openNew = openNew;
function closeModal() { $('#modal').classList.add('hidden'); }
window.closeModal = closeModal;
$('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };

async function loadHistory() {
  const folder = $('#m-folder').value.trim();
  for (const c of document.querySelectorAll('#m-recent .chip')) c.classList.toggle('on', c.title === folder);
  const box = $('#m-history');
  if (!folder) { box.innerHTML = '<div class="muted">Choose a folder first.</div>'; return; }
  const list = await (await fetch('/api/history?folder=' + encodeURIComponent(folder))).json();
  if (!list.length) { box.innerHTML = '<div class="muted">No previous conversations in this folder.</div>'; return; }
  const open = new Set(sessions.map((s) => s.sid));
  box.innerHTML = '';
  for (const h of list) {
    const b = document.createElement('button');
    b.className = 'hist';
    const when = new Date(h.mtime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    b.innerHTML = `<div class="hist-t"><span class="pill agent">${agentOf(h) === 'codex' ? 'Codex' : 'Claude Code'}</span>${esc(h.title || h.first.slice(0, 60))}${open.has(h.sid) ? ' <span class="pill">already in panel</span>' : ''}</div>
      <div class="hist-s">${esc(when)} · ${esc(h.first)}</div>`;
    b.onclick = () => {
      const existing = sessions.find((s) => s.sid === h.sid);
      if (existing) { closeModal(); select(existing.id); return; }
      create(folder, h.sid, agentOf(h));
    };
    box.appendChild(b);
  }
}
$('#m-folder').addEventListener('change', loadHistory);
$('#m-browse').onclick = async () => {
  const { folder } = await api('pickFolder');
  if (folder) { $('#m-folder').value = folder; loadHistory(); }
};
$('#m-fresh').onclick = () => {
  const folder = $('#m-folder').value.trim();
  if (!folder) return toast('Choose a folder first');
  create(folder, '');
};
async function create(folder, sid, agent) {
  agent = agent || newAgent;
  if (modalRoute && !sid) {
    const r = routes.find((x) => x.id === modalRoute);
    closeModal(); if (r) await routeTo(r, { folder, agent }); return;
  }
  const { id } = await api('new', { folder, sid, agent });
  closeModal();
  setTimeout(() => select(id), 400);
}

// ---------- sidebar controls ----------
$('#btn-new').onclick = () => openNew();
$('#btn-overview').onclick = () => select(null);
$('#filter').oninput = render;
$('#opt-notify').checked = !!prefs.notify;
$('#opt-sound').checked = !!prefs.sound;
$('#opt-notify').onchange = async (e) => {
  prefs.notify = e.target.checked; savePrefs();
  if (prefs.notify && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
};
$('#opt-sound').onchange = (e) => { prefs.sound = e.target.checked; savePrefs(); if (prefs.sound) beep(); };

// Cmd/Ctrl + 1..9 jumps to a session
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
    const s = sessions[Number(e.key) - 1]; if (s) { e.preventDefault(); select(s.id); }
  }
  if ((e.metaKey || e.ctrlKey) && e.key === '0') { e.preventDefault(); select(null); }
});
setInterval(render, 30000); // refresh "ago" labels

connectState();
select(null);
