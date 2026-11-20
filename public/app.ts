// The panel page (index.html): sessions in the sidebar and on the overview, one terminal, the Ask box.

interface Choice {
  n: number;
  label: string;
}
interface Session {
  id: string;
  name: string;
  folder: string;
  state: string;
  agent?: string;
  title?: string;
  last?: string;
  question?: string;
  options: Choice[];
  branch?: string;
  prompt?: string;
  sid?: string;
  running: boolean;
  activity?: number;
}
interface Route {
  id: string;
  status: string;
  decided?: string;
  target?: string;
  targetName?: string;
  reason?: string;
  error?: string;
  text: string;
  part?: string;
  parent?: string;
  ts: number;
  choices?: { id: string; name: string }[];
  folder?: string;
  newName?: string;
}
interface ApiAnswer {
  error?: string;
  routeId?: string;
  id?: string;
  folder?: string;
}
interface Agent {
  id: string;
  available?: boolean;
  reason?: string;
}
interface HistoryEntry {
  sid: string;
  agent?: string;
  mtime: number;
  title?: string;
  first: string;
}
interface Prefs {
  notify?: boolean;
  sound?: boolean;
}

function $(s: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(s);
  if (!el) throw new Error(`${s} is missing`);
  return el;
}
function $input(s: string): HTMLInputElement {
  const el = $(s);
  if (!(el instanceof HTMLInputElement)) throw new TypeError(`${s} is not an input`);
  return el;
}
function $textarea(s: string): HTMLTextAreaElement {
  const el = $(s);
  if (!(el instanceof HTMLTextAreaElement)) throw new TypeError(`${s} is not a textarea`);
  return el;
}
function $form(s: string): HTMLFormElement {
  const el = $(s);
  if (!(el instanceof HTMLFormElement)) throw new TypeError(`${s} is not a form`);
  return el;
}
function $button(s: string): HTMLButtonElement {
  const el = $(s);
  if (!(el instanceof HTMLButtonElement)) throw new TypeError(`${s} is not a button`);
  return el;
}
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const has = (s: string | undefined): s is string => s !== undefined && s !== '';
const esc = (s: string | number | null | undefined): string =>
  String(s ?? '').replaceAll(/[&<>"']/g, (c) => ESC[c] ?? c);
const LABEL: Record<string, string> = {
  needs: 'Needs you',
  working: 'Working',
  idle: 'Ready',
  stopped: 'Not running',
  elsewhere: 'Open elsewhere',
};

let sessions: Session[] = [];
let routes: Route[] = [];
let myRoute: string | null = null; // route id the user just submitted (auto-jump target)
let selected: string | null = null; // window id
const prev = new Map<string, string>(); // id -> last state (for notifications)
const unread = new Set<string | null>();
const prefs = loadPrefs();

function loadPrefs(): Prefs {
  try {
    return JSON.parse(localStorage.getItem('ccp') ?? '{}') as Prefs;
  } catch {
    return {};
  }
}
function savePrefs(): void {
  try {
    localStorage.setItem('ccp', JSON.stringify(prefs));
  } catch {
    /* private mode */
  }
}
const AGENT_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex' };
const agentOf = (x: { agent?: string | undefined } | undefined): string => x?.agent ?? 'claude';
const agentName = (x: { agent?: string | undefined } | undefined): string => AGENT_NAME[agentOf(x)] ?? 'Claude';
// small "Codex" badge; nothing for Claude Code (keeps the old look)
const agentBadge = (x: Session): string =>
  agentOf(x) === 'codex' ? '<span class="pill agent" title="Runs the Codex CLI">Codex</span>' : '';
function short(p: string | undefined): string {
  return (p ?? '').replace(/^\/Users\/[^/]+/, '~');
}
function ago(ms: number | undefined): string {
  if (ms === undefined || ms === 0) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${String(Math.floor(s / 60))}m`;
  if (s < 86_400) return `${String(Math.floor(s / 3600))}h`;
  return `${String(Math.floor(s / 86_400))}d`;
}
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string): void {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.add('hidden');
  }, 2600);
}
async function api(name: string, body?: Record<string, unknown>): Promise<ApiAnswer> {
  const r = await fetch(`/api/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const j = (await r.json().catch(() => ({}))) as ApiAnswer;
  if (!r.ok) {
    toast(j.error ?? 'Failed');
    throw new Error(j.error);
  }
  return j;
}
// a click handler that calls the server: the error is already shown as a toast
const run = (fn: () => Promise<unknown>) => (): void => {
  fn().catch(() => {
    /* toast shown */
  });
};

// ---------- state socket ----------
function connectState(): void {
  const ws = new WebSocket(`ws://${location.host}/ws/state`);
  ws.addEventListener('open', () => {
    $('#conn').classList.remove('off');
  });
  ws.addEventListener('close', () => {
    $('#conn').classList.add('off');
    setTimeout(connectState, 1500);
  });
  ws.addEventListener('message', (e: MessageEvent<string>) => {
    const m = JSON.parse(e.data) as { type: string; routes?: Route[]; sessions?: Session[] };
    if (m.type !== 'state') return;
    onRoutes(m.routes ?? []);
    onState(m.sessions ?? []);
  });
}

let routesKey = '';
function onRoutes(list: Route[]): void {
  const key = JSON.stringify(list);
  if (key === routesKey) return;
  routesKey = key;
  routes = list;
  const r = myRoute === null ? undefined : routes.find((x) => x.id === myRoute);
  const target = r?.target;
  if (
    r &&
    target !== undefined &&
    target !== '' &&
    (r.decided === 'auto' || r.decided === 'auto-new' || r.decided === 'auto-new-busy' || r.decided === 'manual')
  ) {
    myRoute = null;
    toast(`→ ${r.targetName ?? ''}: ${r.reason ?? ''}`);
    setTimeout(() => {
      select(target);
    }, 150);
  } else if (r && (r.status === 'ask' || r.status === 'error')) {
    myRoute = null;
    select(null);
  } else if (r?.status === 'split') {
    myRoute = null; // several tasks went to several sessions: no single session to jump to
  }
  renderRequests();
}

const RSTATUS: Record<string, string> = {
  split: 'Split into tasks',
  routing: 'Finding the right session…',
  sending: 'Sending…',
  queued: 'Waiting for session to be ready',
  sent: 'Sent',
  ask: 'Which session?',
  error: 'Failed',
};
function renderRequests(): void {
  const wrap = $('#requests-wrap'),
    box = $('#requests');
  const list = routes.slice(0, 8);
  wrap.classList.toggle('hidden', list.length === 0);
  box.innerHTML = '';
  for (const r of list) {
    const row = document.createElement('div');
    row.className = `req ${r.status}${has(r.parent) ? ' part' : ''}`;
    const when = new Date(r.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    let right = '';
    if (r.target !== undefined && r.target !== '' && sessions.some((s) => s.id === r.target))
      right = `<button class="chip go" data-go="${esc(r.target)}">→ ${esc(r.targetName)}</button>`;
    const reason = (r.error ?? '') || (r.reason ?? '');
    row.innerHTML = `<div class="req-top"><span class="req-status ${r.status}">${r.status === 'routing' ? '<span class="spin"></span>' : ''}${esc(RSTATUS[r.status] ?? r.status)}</span>
        <span class="req-text" title="${esc(r.text)}">${has(r.part) ? `<span class="req-part">${esc(r.part)}</span> ` : ''}${esc(r.text)}</span>${right}<span class="req-time">${when}</span>
        <button class="x small" title="Remove" data-dismiss="1">✕</button></div>
      ${reason ? `<div class="req-reason">${esc(reason)}</div>` : ''}`;
    if (r.status === 'ask' || r.status === 'error') {
      const opts = document.createElement('div');
      opts.className = 'req-opts';
      const seen = new Set<string>();
      for (const c of r.choices ?? []) {
        seen.add(c.id);
        opts.append(
          mkBtn(
            c.name,
            'btn small primary',
            run(() => routeTo(r, { target: c.id })),
          ),
        );
      }
      for (const s of sessions)
        if (!seen.has(s.id) && s.state !== 'elsewhere')
          opts.append(
            mkBtn(
              s.name,
              'btn small',
              run(() => routeTo(r, { target: s.id })),
            ),
          );
      const folder = r.folder;
      if (has(folder))
        opts.append(
          mkBtn(
            `+ New in ${folder.split('/').pop() ?? ''}`,
            'btn small ghost',
            run(() => routeTo(r, { folder, name: r.newName })),
          ),
        );
      opts.append(
        mkBtn(
          '+ New session…',
          'btn small ghost',
          run(() => openNew(folder ?? '', r.id)),
        ),
      );
      row.append(opts);
    }
    const dismiss = row.querySelector<HTMLElement>('[data-dismiss]');
    if (dismiss) dismiss.onclick = run(() => api('dismissRoute', { routeId: r.id }));
    const go = row.querySelector<HTMLElement>('[data-go]');
    if (go)
      go.onclick = () => {
        select(go.dataset['go'] ?? null);
      };
    box.append(row);
  }
}
function mkBtn(label: string, cls: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = label;
  b.onclick = fn;
  return b;
}
async function routeTo(r: Route, body: Record<string, unknown>): Promise<void> {
  myRoute = r.id;
  await api('routeTo', { routeId: r.id, ...body });
}

// unified entry box
const askText = $textarea('#ask-text');
askText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $form('#ask').requestSubmit();
  }
});
$form('#ask').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = askText.value.trim();
  if (!text) return;
  askText.disabled = true;
  api('route', { text })
    .then(({ routeId }) => {
      myRoute = routeId ?? null;
      askText.value = '';
      select(null);
    })
    .catch(() => {
      /* toast shown */
    })
    .finally(() => {
      askText.disabled = false;
      askText.focus();
    });
});

let stateKey = '';
function onState(list: Session[]): void {
  for (const s of list) {
    const p = prev.get(s.id);
    if (p !== undefined && p !== s.state) {
      const who = agentName(s);
      if (s.state === 'needs')
        notify(`${s.name} needs you`, (s.question ?? '') || `${who} is waiting for your choice.`, s.id);
      if (p === 'working' && s.state === 'idle') {
        if (s.id !== selected || document.hidden) unread.add(s.id);
        notify(`${s.name} is done`, (s.last ?? '') || `${who} finished.`, s.id);
      }
    }
    prev.set(s.id, s.state);
  }
  const key = JSON.stringify(
    list.map((s) => {
      const rest: Partial<Session> = { ...s };
      delete rest.activity;
      return rest;
    }),
  );
  sessions = list;
  if (selected !== null && !sessions.some((s) => s.id === selected)) {
    select(null);
    return;
  }
  if (key === stateKey) return; // nothing visible changed: keep DOM (no lost clicks)
  stateKey = key;
  render();
}

// ---------- notifications ----------
let audioCtx: AudioContext | undefined;
function beep(): void {
  try {
    audioCtx ??= new AudioContext();
    const o = audioCtx.createOscillator(),
      g = audioCtx.createGain();
    o.frequency.value = 880;
    g.gain.value = 0.06;
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.15);
  } catch {
    /* no audio */
  }
}
function notify(title: string, body: string, id: string): void {
  if (prefs.sound === true) beep();
  if (prefs.notify !== true || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (!document.hidden && id === selected) return;
  const n = new Notification(title, { body: body.slice(0, 180), tag: id });
  n.addEventListener('click', () => {
    window.focus();
    select(id);
    n.close();
  });
}

// ---------- render ----------
function render(): void {
  if (editing) return;
  const f = $input('#filter').value.trim().toLowerCase();
  const shown = sessions.filter((s) => !f || `${s.name} ${s.folder} ${String(s.last)}`.toLowerCase().includes(f));

  // group by folder
  const groups = new Map<string, Session[]>();
  for (const s of shown) {
    const g = groups.get(s.folder);
    if (g) g.push(s);
    else groups.set(s.folder, [s]);
  }
  const list = $('#list');
  list.innerHTML = '';
  for (const [folder, items] of groups) {
    const g = document.createElement('div');
    g.className = 'group';
    const branch = items[0]?.branch;
    const br = has(branch) ? `<span class="gb">⎇ ${esc(branch)}</span>` : '';
    g.innerHTML = `<div class="group-h" title="${esc(folder)}"><span>${esc((folder.split('/').pop() ?? '') || folder)}</span>${br}<button class="add" title="New session in this folder">+</button></div>`;
    const add = g.querySelector<HTMLElement>('.add');
    if (add) add.onclick = run(() => openNew(folder));
    for (const s of items) g.append(card(s));
    list.append(g);
  }

  // attention banner
  const needs = sessions.filter((s) => s.state === 'needs');
  const att = $('#attention');
  att.classList.toggle('hidden', needs.length === 0);
  att.textContent =
    needs.length === 1 ? `${needs[0]?.name ?? ''} needs you →` : `${String(needs.length)} sessions need you →`;
  att.onclick = () => {
    select(needs[0]?.id ?? null);
  };
  document.title = (needs.length > 0 ? `(${String(needs.length)}) ` : '') + 'Thoth';

  renderGrid();
  renderRequests();
  if (selected !== null) renderDetail();
}

function card(s: Session): HTMLDivElement {
  const b = document.createElement('div');
  b.tabIndex = 0;
  b.dataset['id'] = s.id;
  b.className = `card ${s.state === 'needs' ? 'needs' : ''} ${s.id === selected ? 'active' : ''} ${unread.has(s.id) ? 'unread' : ''}`;
  let last = s.last;
  if (s.state === 'needs') last = (s.question ?? '') || 'Waiting for your choice';
  else if (s.state === 'elsewhere') last = 'Still open in another window (VS Code?)';
  b.innerHTML = `<div class="card-top"><span class="dot ${s.state}"></span><span class="card-name"><span class="nm" title="Double-click to rename">${esc(s.name)}</span>${agentBadge(s)}${has(s.title) ? `<span class="sub">${esc(s.title)}</span>` : ''}</span><button class="edit" title="Rename">✎</button><span class="card-time">${esc(LABEL[s.state])} · ${ago(s.activity)}</span></div>
    <div class="card-last">${esc(last ?? '')}</div>`;
  b.onclick = (e) => {
    if (!(e.target instanceof Element && e.target.closest('input'))) select(s.id);
  };
  b.onkeydown = (e) => {
    if (e.key === 'Enter' && e.target === b) select(s.id);
  };
  const nm = b.querySelector<HTMLElement>('.nm');
  const edit = b.querySelector<HTMLElement>('.edit');
  if (edit)
    edit.onclick = (e) => {
      e.stopPropagation();
      editName(nm, s);
    };
  if (nm)
    nm.ondblclick = (e) => {
      e.stopPropagation();
      editName(nm, s);
    };
  b.oncontextmenu = (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, s);
  };
  return b;
}

// inline rename: el is the element that shows the name
let editing = false;
function editName(el: Element | null, s: Session): void {
  if (!el || editing) return;
  editing = true;
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = s.name;
  input.maxLength = 30;
  el.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save: boolean): Promise<void> => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    editing = false;
    if (save && name && name !== s.name) {
      s.name = name;
      try {
        await api('rename', { id: s.id, name });
        toast(`Renamed to "${name}"`);
      } catch {
        /* toast shown */
      }
    }
    stateKey = '';
    render();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      void finish(true);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      void finish(false);
    }
  };
  input.onclick = (e) => {
    e.stopPropagation();
  };
  input.onblur = () => {
    void finish(true);
  };
}

function renderGrid(): void {
  const grid = $('#grid');
  grid.innerHTML = '';
  $('#empty').classList.toggle('hidden', sessions.length > 0);
  const order: Record<string, number> = { needs: 0, working: 1, idle: 2, elsewhere: 3, stopped: 4 };
  for (const s of sessions.toSorted((a, b) => (order[a.state] ?? Number.NaN) - (order[b.state] ?? Number.NaN))) {
    const t = document.createElement('button');
    t.className = `tile ${s.state}`;
    t.innerHTML = `<div class="tile-top"><span class="dot ${s.state}"></span><span class="tile-name">${esc(s.name)}${agentBadge(s)}${has(s.title) ? `<span class="sub">${esc(s.title)}</span>` : ''}</span><span class="pill ${s.state}">${esc(LABEL[s.state])}</span></div>
      <div class="tile-folder">${esc(short(s.folder))}${has(s.branch) ? ' · ⎇ ' + esc(s.branch) : ''}</div>
      ${has(s.prompt) ? `<div class="tile-prompt">You: ${esc(s.prompt)}</div>` : ''}
      <div class="tile-last">${esc(s.state === 'needs' ? (s.question ?? '') || 'Waiting for your choice' : (s.last ?? '') || '—')}</div>`;
    t.onclick = () => {
      select(s.id);
    };
    t.oncontextmenu = (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, s);
    };
    grid.append(t);
  }
}

function cur(): Session | undefined {
  return sessions.find((s) => s.id === selected);
}

function renderDetail(): void {
  const s = cur();
  if (!s) return;
  $('#d-dot').className = `dot ${s.state}`;
  $('#d-name').textContent = s.name;
  $('#d-title').textContent = s.title ?? '';
  $('#d-agent').classList.toggle('hidden', agentOf(s) !== 'codex');
  msg.placeholder = `Message ${agentName(s)}…  (Enter to send, Shift+Enter for new line)`;
  const pill = $('#d-state');
  pill.className = `pill ${s.state}`;
  pill.textContent = LABEL[s.state] ?? null;
  $('#d-folder').textContent = short(s.folder);
  $('#d-folder').title = s.folder;
  $('#d-branch').textContent = s.branch ?? '';
  $('#a-start').classList.toggle('hidden', s.running);
  $('#a-start').textContent = has(s.sid) ? '▶ Resume' : '▶ Start';
  $('#a-stop').classList.toggle('hidden', s.state !== 'working');

  // choice bar
  const ch = $('#choice');
  if (s.state === 'needs' && s.options.length > 0) {
    ch.classList.remove('hidden');
    $('#choice-q').textContent = (s.question ?? '') || `${agentName(s)} needs your decision`;
    const key = JSON.stringify(s.options);
    if (ch.dataset['key'] !== key) {
      ch.dataset['key'] = key;
      const box = $('#choice-opts');
      box.innerHTML = '';
      for (const o of s.options) {
        const b = document.createElement('button');
        let kind = '';
        if (/^yes/i.test(o.label)) kind = ' yes';
        else if (/^no/i.test(o.label)) kind = ' no';
        b.className = 'btn' + kind;
        b.textContent = o.label;
        b.title = o.label;
        b.onclick = () => {
          b.disabled = true;
          api('choose', { id: s.id, n: o.n })
            .catch(() => {
              /* toast shown */
            })
            .finally(() => {
              b.disabled = false;
              term.focus();
            });
        };
        box.append(b);
      }
    }
  } else {
    ch.classList.add('hidden');
    ch.dataset['key'] = '';
  }

  // notice
  const nt = $('#notice');
  if (s.state === 'elsewhere') {
    nt.innerHTML =
      'This conversation is still open in another window (probably VS Code). Type <b>/exit</b> there first, then click <b>▶ Resume</b>. Running it in two places at once can mix up the conversation.';
    nt.classList.remove('hidden');
  } else if (s.state === 'stopped') {
    const who = agentName(s);
    nt.innerHTML = has(s.sid)
      ? `${who} is not running here. Click <b>▶ Resume</b> to continue this conversation.`
      : `${who} is not running here. Click <b>▶ Start</b>.`;
    nt.classList.remove('hidden');
  } else nt.classList.add('hidden');
  $('#composer').classList.toggle('hidden', !s.running);
}

// ---------- terminal ----------
const term = new Terminal({
  fontFamily: '"SF Mono", Menlo, "PingFang SC", monospace',
  fontSize: 13,
  lineHeight: 1.15,
  cursorBlink: true,
  allowProposedApi: true,
  scrollback: 0,
  macOptionIsMeta: true,
  theme: { background: '#1b1b1a', foreground: '#e8e6e1', cursor: '#c96442', selectionBackground: '#4a4a46' },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.loadAddon(new WebLinksAddon.WebLinksAddon());
let termWs: WebSocket | null = null;
let opened = false;

function attach(id: string): void {
  if (termWs) {
    termWs.onclose = null;
    termWs.close();
    termWs = null;
  }
  if (!opened) {
    term.open($('#term'));
    opened = true;
  }
  term.reset();
  fit.fit();
  const ws = new WebSocket(
    `ws://${location.host}/ws/term?win=${encodeURIComponent(id)}&cols=${String(term.cols)}&rows=${String(term.rows)}`,
  );
  ws.onmessage = (e: MessageEvent<unknown>) => {
    term.write(typeof e.data === 'string' ? e.data : '');
  };
  ws.onclose = () => {
    if (selected === id && termWs === ws)
      setTimeout(() => {
        if (selected === id) attach(id);
      }, 1000);
  };
  termWs = ws;
  setTimeout(() => {
    term.focus();
  }, 50);
}
term.onData((d) => {
  if (termWs?.readyState === 1) termWs.send(d);
});
function refit(): void {
  if (!opened || $('#detail').classList.contains('hidden')) return;
  fit.fit();
  if (termWs?.readyState === 1) termWs.send(`\u0000resize:${String(term.cols)},${String(term.rows)}`);
}
let refitTimer: ReturnType<typeof setTimeout> | undefined;
new ResizeObserver(() => {
  clearTimeout(refitTimer);
  refitTimer = setTimeout(refit, 60);
}).observe($('#term-wrap'));

// ---------- selection ----------
function select(id: string | null): void {
  selected = id;
  unread.delete(id);
  $('#overview').classList.toggle('hidden', id !== null && id !== '');
  $('#detail').classList.toggle('hidden', id === null || id === '');
  if (id !== null && id !== '') {
    renderDetail();
    requestAnimationFrame(() => {
      attach(id);
    });
  } else if (termWs) {
    termWs.onclose = null;
    termWs.close();
    termWs = null;
  }
  render();
}

// ---------- detail actions ----------
$('#a-start').onclick = run(async () => {
  const s = cur();
  if (!s) return;
  if (s.state === 'elsewhere' && !confirm('This conversation still looks open in another window. Resume here anyway?'))
    return;
  await api('start', { id: s.id });
});
$('#a-stop').onclick = run(async () => {
  if (cur()) await api('interrupt', { id: selected });
});
$('#a-finder').onclick = run(async () => {
  const s = cur();
  if (s) await api('reveal', { folder: s.folder });
});
$('#a-code').onclick = run(async () => {
  const s = cur();
  if (s) await api('reveal', { folder: s.folder, app: 'code' });
});
$('#a-close').onclick = run(() => closeSession(cur()));
async function closeSession(s: Session | undefined): Promise<void> {
  if (!s) return;
  if (
    !confirm(
      `Close "${s.name}"?\n\nClaude will exit. The conversation is saved and you can continue it later with + New.`,
    )
  )
    return;
  await api('close', { id: s.id });
  if (selected === s.id) select(null);
}
$('#d-name').ondblclick = () => {
  rename(cur());
};
$('#d-edit').onclick = () => {
  rename(cur());
};
function rename(s: Session | undefined): void {
  if (!s) return;
  const cardEl = document.querySelector(`.card[data-id="${CSS.escape(s.id)}"] .nm`);
  if (s.id === selected) {
    const h = $('#d-name'),
      span = document.createElement('span');
    span.textContent = s.name;
    h.textContent = '';
    h.append(span);
    editName(span, s);
  } else editName(cardEl, s);
}

// composer
const msg = $textarea('#msg');
msg.addEventListener('input', () => {
  msg.style.height = 'auto';
  msg.style.height = `${String(Math.min(msg.scrollHeight, 160))}px`;
});
msg.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $form('#composer').requestSubmit();
  }
});
$form('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = msg.value;
  if (!text.trim() || selected === null || selected === '') return;
  api('send', { id: selected, text: text.replaceAll('\n', ' ') })
    .then(() => {
      msg.value = '';
      msg.style.height = 'auto';
    })
    .catch(() => {
      /* toast shown */
    });
});

// ---------- context menu ----------
type MenuItem = readonly [string, () => void, string?];
function showMenu(x: number, y: number, s: Session): void {
  const m = $('#menu');
  const items: (MenuItem | false)[] = [
    [
      'Open',
      () => {
        select(s.id);
      },
    ],
    [
      'Rename…',
      () => {
        rename(s);
      },
    ],
    !s.running && [has(s.sid) ? 'Resume' : 'Start', run(() => api('start', { id: s.id }))],
    s.state === 'working' && ['Stop (Esc)', run(() => api('interrupt', { id: s.id }))],
    ['New session in this folder', run(() => openNew(s.folder))],
    ['Show in Finder', run(() => api('reveal', { folder: s.folder }))],
    ['Open in VS Code', run(() => api('reveal', { folder: s.folder, app: 'code' }))],
    ['Close session', run(() => closeSession(s)), 'danger'],
  ];
  m.innerHTML = '';
  for (const item of items) {
    if (item === false) continue;
    const [label, fn, cls] = item;
    const b = document.createElement('button');
    b.textContent = label;
    if (cls !== undefined) b.className = cls;
    b.onclick = () => {
      hideMenu();
      fn();
    };
    m.append(b);
  }
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = `${String(Math.min(x, innerWidth - r.width - 8))}px`;
  m.style.top = `${String(Math.min(y, innerHeight - r.height - 8))}px`;
}
function hideMenu(): void {
  $('#menu').classList.add('hidden');
}
document.addEventListener('click', (e) => {
  if (!(e.target instanceof Node && $('#menu').contains(e.target))) hideMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideMenu();
    closeModal();
  }
});

// ---------- new session modal ----------
let modalRoute: string | null = null;
function savedAgent(): string {
  try {
    return localStorage.getItem('ccp.agent') === 'codex' ? 'codex' : 'claude';
  } catch {
    return 'claude';
  }
}
// agent for "Start new": remembered in localStorage; Codex is off when the server says it is not available
let newAgent = savedAgent();
function setAgent(a: string, save = true): void {
  newAgent = a;
  if (save)
    try {
      localStorage.setItem('ccp.agent', a);
    } catch {
      /* private mode */
    }
  for (const b of document.querySelectorAll<HTMLElement>('#m-agent [data-agent]')) {
    const on = b.dataset['agent'] === a;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
}
for (const b of document.querySelectorAll<HTMLElement>('#m-agent [data-agent]'))
  b.onclick = () => {
    setAgent(b.dataset['agent'] ?? 'claude');
  };
async function loadAgents(): Promise<void> {
  let list: unknown = null;
  try {
    const r = await fetch('/api/agents');
    if (r.ok) list = await r.json();
  } catch {
    /* old server */
  }
  const codex = Array.isArray(list) ? (list as Agent[]).find((a) => a.id === 'codex') : undefined;
  const ok = codex?.available === true;
  const reason =
    (codex?.reason ?? '') || (list === null ? 'This server cannot start Codex.' : 'Codex is not available.');
  const btn = $button('#m-agent [data-agent="codex"]');
  btn.disabled = !ok;
  btn.title = ok ? 'Start the Codex CLI in this folder' : reason;
  const note = $('#m-agent-note');
  note.textContent = ok ? '' : `Codex: ${reason}`;
  note.classList.toggle('hidden', ok);
  // Codex off: use Claude Code now, but keep the saved choice for later
  if (!ok && newAgent === 'codex') setAgent('claude', false);
}
setAgent(newAgent, false);
async function openNew(folder?: string, routeId?: string): Promise<void> {
  modalRoute = routeId ?? null;
  $('#modal').classList.remove('hidden');
  setAgent(savedAgent(), false);
  void loadAgents();
  $input('#m-folder').value = folder ?? '';
  const rec = (await (await fetch('/api/folders')).json()) as { folder: string }[];
  const box = $('#m-recent');
  box.innerHTML = '';
  for (const r of rec.slice(0, 14)) {
    const c = document.createElement('button');
    c.className = 'chip';
    c.textContent = r.folder.split('/').pop() ?? '';
    c.title = r.folder;
    c.onclick = () => {
      $input('#m-folder').value = r.folder;
      void loadHistory();
    };
    box.append(c);
  }
  await loadHistory();
}
function closeModal(): void {
  $('#modal').classList.add('hidden');
}
$('#modal').onclick = (e) => {
  if (e.target instanceof Element && e.target.id === 'modal') closeModal();
};
// the two buttons in index.html that open and close the modal
$('#btn-first-session').addEventListener(
  'click',
  run(() => openNew()),
);
$('#modal-close').addEventListener('click', closeModal);

async function loadHistory(): Promise<void> {
  const folder = $input('#m-folder').value.trim();
  for (const c of document.querySelectorAll<HTMLElement>('#m-recent .chip'))
    c.classList.toggle('on', c.title === folder);
  const box = $('#m-history');
  if (!folder) {
    box.innerHTML = '<div class="muted">Choose a folder first.</div>';
    return;
  }
  const list = (await (await fetch('/api/history?folder=' + encodeURIComponent(folder))).json()) as HistoryEntry[];
  if (list.length === 0) {
    box.innerHTML = '<div class="muted">No previous conversations in this folder.</div>';
    return;
  }
  const open = new Set(sessions.map((s) => s.sid));
  box.innerHTML = '';
  for (const h of list) {
    const b = document.createElement('button');
    b.className = 'hist';
    const when = new Date(h.mtime).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    b.innerHTML = `<div class="hist-t"><span class="pill agent">${agentOf(h) === 'codex' ? 'Codex' : 'Claude Code'}</span>${esc((h.title ?? '') || h.first.slice(0, 60))}${open.has(h.sid) ? ' <span class="pill">already in panel</span>' : ''}</div>
      <div class="hist-s">${esc(when)} · ${esc(h.first)}</div>`;
    b.onclick = run(async () => {
      const existing = sessions.find((s) => s.sid === h.sid);
      if (existing) {
        closeModal();
        select(existing.id);
        return;
      }
      await create(folder, h.sid, agentOf(h));
    });
    box.append(b);
  }
}
$input('#m-folder').addEventListener('change', run(loadHistory));
$('#m-browse').onclick = run(async () => {
  const { folder } = await api('pickFolder');
  if (has(folder)) {
    $input('#m-folder').value = folder;
    await loadHistory();
  }
});
$('#m-fresh').onclick = run(async () => {
  const folder = $input('#m-folder').value.trim();
  if (!folder) {
    toast('Choose a folder first');
    return;
  }
  await create(folder, '');
});
async function create(folder: string, sid: string, agent?: string): Promise<void> {
  const chosen = agent ?? newAgent;
  if (modalRoute !== null && !sid) {
    const r = routes.find((x) => x.id === modalRoute);
    closeModal();
    if (r) await routeTo(r, { folder, agent: chosen });
    return;
  }
  const { id } = await api('new', { folder, sid, agent: chosen });
  closeModal();
  setTimeout(() => {
    select(id ?? null);
  }, 400);
}

// ---------- sidebar controls ----------
$('#btn-new').onclick = run(() => openNew());
$('#btn-overview').onclick = () => {
  select(null);
};
$('#filter').oninput = render;
$input('#opt-notify').checked = prefs.notify === true;
$input('#opt-sound').checked = prefs.sound === true;
$input('#opt-notify').onchange = run(async () => {
  prefs.notify = $input('#opt-notify').checked;
  savePrefs();
  if (prefs.notify && 'Notification' in window && Notification.permission === 'default')
    await Notification.requestPermission();
});
$input('#opt-sound').onchange = () => {
  prefs.sound = $input('#opt-sound').checked;
  savePrefs();
  if (prefs.sound) beep();
};

// Cmd/Ctrl + 1..9 jumps to a session
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
    const s = sessions[Number(e.key) - 1];
    if (s) {
      e.preventDefault();
      select(s.id);
    }
  }
  if ((e.metaKey || e.ctrlKey) && e.key === '0') {
    e.preventDefault();
    select(null);
  }
});
setInterval(render, 30_000); // refresh "ago" labels

connectState();
select(null);

export {};
