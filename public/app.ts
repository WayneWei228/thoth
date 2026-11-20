// The panel page (index.html), laid out as the Mac app: the sidebar (pages and sessions), Home with the
// Ask box, All Sessions, All Devices, the Session page (Chat and Terminal), dialogs and the menu keys.
import {
  HASH_RE,
  PAGES,
  canChooseFolder,
  canFetch,
  fetchText,
  hashFor,
  isPage,
  parseHash,
  stateClass,
} from './pages.js';
import type { FetchInfo, Page } from './pages.js';
import { joinRequests } from './joins.js';
import type { JoinRequest } from './joins.js';
import { deviceGroups, deviceHeader, newUpdateId, showsUpdateButton } from './helper_update.js';
import type { PeerInfo } from './helper_update.js';
import { chipText } from './device_status.js';
import {
  detailView,
  groupKey,
  helperOf,
  isOffline,
  computerOptions,
  helperHistoryText,
  isPending,
  isRemote,
  mayNotify,
  newBody,
  pendingMenuLabel,
  pendingNotice,
  preparedSession,
  needsYou,
  offlineNotice,
  placeText,
  rowTip,
  sectionPlace,
} from './helpers.js';
import { makeCommandMenu } from './command_menu.js';
import { retryTarget } from './commands.js';
import { SelectMode, asCheckRow, headerButton, mountBar, onRowsKey, rowClick } from './select.js';
import type { SelectHooks } from './select.js';
import { beforeFirstPoll, escapeStops, mayAskNotices, noticeFor, showNotice } from './fixes.js';
import type { Notice } from './fixes.js';
import { tidyButton } from './tidy.js';
import type { TidyHooks } from './tidy.js';
import * as Restore from './restore.js';

interface Choice {
  n: number;
  label: string;
}
interface Session {
  id: string;
  name: string;
  folder: string;
  device?: string; // a helper computer's session (lib/peer.ts)
  state: string;
  agent?: string;
  title?: string;
  last?: string;
  question?: string;
  options?: Choice[];
  branch?: string;
  prompt?: string;
  sid?: string;
  running: boolean;
  activity?: number;
  offline?: boolean;
  preparedAs?: string; // a session started on a helper: the id of the preparing row it was
  fetch?: FetchInfo; // the newest "Fetch result" of a helper session (lib/fetch_result.ts)
  waits?: { kind: string; text: string }; // an idle session that waits for the owner (server.ts)
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
  ts: number;
  choices?: { id: string; name: string }[];
  tasks?: unknown[];
  folder?: string;
  newName?: string;
}
interface StateMessage {
  type?: string;
  sessions?: Session[];
  routes?: Route[];
  defaultFolder?: string;
  platform?: string;
  restoring?: boolean; // the server builds the saved windows again (server.ts ensureSession)
  joins?: JoinRequest[];
  join?: JoinRequest;
  peers?: PeerInfo[]; // the helper computers and their update state (server.ts peersView)
}
interface ApiAnswer {
  error?: string;
  routeId?: string;
  id?: string;
  folder?: string;
  path?: string;
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
  first?: string;
}
interface Request {
  text: string;
  attachments: string[];
  retry?: () => void; // what Try Again does (a command goes to the same session again); none = the router again
}
type PageName = Page['name'];

function $(s: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(s);
  if (!el) throw new Error(`${s} is missing`);
  return el;
}
/** The element `s`, checked to be of `type` (HTMLInputElement, HTMLSelectElement …). */
function $as<T extends HTMLElement>(s: string, type: new () => T): T {
  const el = $(s);
  if (!(el instanceof type)) throw new TypeError(`${s} is not a ${type.name}`);
  return el;
}
function within(root: ParentNode, s: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(s);
  if (!el) throw new Error(`${s} is missing`);
  return el;
}
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const has = (s: string | null | undefined): s is string => s !== undefined && s !== null && s !== '';
const esc = (s: string | number | null | undefined): string =>
  String(s ?? '').replaceAll(/[&<>"']/g, (c) => ESC[c] ?? c);
const LABEL: Record<string, string> = {
  needs: 'Needs you',
  working: 'Working',
  starting: 'Starting',
  idle: 'Ready',
  stopped: 'Not running',
  elsewhere: 'Open elsewhere',
  preparing: 'Preparing',
  failed: 'Did not start',
};
const label = (s: Session): string => LABEL[s.state] ?? s.state;
const isFetching = (s: Session): boolean => s.fetch?.state === 'fetching';
const randomHex = (n: number): string =>
  [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
function fetchResult(s: Session): Promise<unknown> {
  return isFetching(s) ? api('fetchCancel', { id: s.id }) : api('fetchResult', { id: s.id, fetchId: randomHex(8) });
}
const isMac = /Mac|iPad/.test(navigator.userAgent);
const wsBase = (): string => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

let sessions: Session[] = [];
let routes: Route[] = [];
let selected: string | null = null; // window id of the open session page (null on other pages)
let page: Page = { name: 'home' };
let connected = false; // the state socket is open
const prev = new Map<string, string>(); // id -> last state (for notifications)
const stopSent = new Set<string>(); // ids that Escape stopped in this working turn
const orderKey = new Map<string, number>(); // id -> sort key of the Recent list (MainWindow.swift reload)
const lastState = new Map<string, string>(); // id -> state at the last update (for orderKey)
function store(k: string, v: string | null): void {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
}
function stored(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
const AGENT_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex' };
const agentOf = (x: { agent?: string | undefined } | undefined): string => (has(x?.agent) ? x.agent : 'claude');
const agentName = (x: { agent?: string | undefined } | undefined): string => AGENT_NAME[agentOf(x)] ?? 'Claude';
// small "Codex" badge; nothing for Claude Code (as in the app)
const agentBadge = (x: Session): string =>
  agentOf(x) === 'codex' ? '<span class="pill agent" title="Runs the Codex CLI">Codex</span>' : '';
function short(p: string | undefined): string {
  return (p ?? '').replace(/^\/(Users|home)\/[^/]+/, '~');
}
function ago(ms: number | undefined): string {
  if (ms === undefined || ms === 0) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${String(Math.floor(s / 60))}m`;
  if (s < 86_400) return `${String(Math.floor(s / 3600))}h`;
  return `${String(Math.floor(s / 86_400))}d`;
}
const plural = (n: number, word: string): string => `${String(n)} ${word}${n === 1 ? '' : 's'}`;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string): void {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.add('hidden');
  }, 3000);
}
async function post(name: string, body?: Record<string, unknown>): Promise<Response> {
  return fetch(`/api/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}
async function api(name: string, body?: Record<string, unknown>): Promise<ApiAnswer> {
  const r = await post(name, body);
  const j = (await r.json().catch(() => ({}))) as ApiAnswer;
  if (!r.ok) {
    toast(j.error ?? 'Failed');
    throw new Error(j.error);
  }
  return j;
}
// a handler that calls the server: the error is already shown as a toast
const run = (fn: () => Promise<unknown>) => (): void => {
  fn().catch(() => {
    /* toast shown */
  });
};
async function getJson(url: string): Promise<unknown> {
  try {
    const r = await fetch(url);
    return r.ok ? ((await r.json()) as unknown) : null;
  } catch {
    return null;
  }
}

// ---------- look (Theme.swift: Original | Website) ----------
function look(): 'website' | 'original' {
  return document.documentElement.classList.contains('website') ? 'website' : 'original';
}
// for pages this page embeds (chat.html reads ?look=website, as in the app)
function lookQuery(): string {
  return look() === 'website' ? 'look=website' : '';
}
function setLook(l: string): void {
  document.documentElement.classList.toggle('website', l === 'website');
  store('thoth.look', l);
  const u = new URL(location.href);
  if (u.searchParams.has('look')) {
    u.searchParams.delete('look');
    history.replaceState(null, '', u);
  }
  for (const c of document.querySelectorAll<HTMLElement>('.look-card'))
    c.classList.toggle('on', c.dataset['look'] === l);
  if (selected !== null) openChat(selected);
}

// ---------- state socket ----------
let stateKey: string | null = null;
function onMessage(m: StateMessage, snapshot = false): void {
  serverRestoring = m.restoring === true;
  joins.show(m.joins ?? []);
  onPeers(m.peers ?? []);
  onMeta(m);
  onRoutes(m.routes ?? []);
  onState((m.sessions ?? []).map(shown), snapshot, beforeFirstPoll(m));
}
function connectState(): void {
  const ws = new WebSocket(`${wsBase()}/ws/state`);
  ws.addEventListener('open', () => {
    connected = true;
    $('#conn').classList.add('hidden');
  });
  ws.addEventListener('close', () => {
    connected = false;
    $('#conn').classList.remove('hidden');
    setTimeout(connectState, 1500);
  });
  ws.addEventListener('message', (e: MessageEvent<string>) => {
    const m = JSON.parse(e.data) as StateMessage;
    if (m.type === 'state') onMessage(m);
    // a computer asks to join: once per request id (server.ts announceJoins)
    else if (m.type === 'joinNotice' && m.join) joins.notice(m.join);
  });
}
// first paint before the socket opens
void getJson('/api/state').then((m) => {
  if (m !== null && typeof m === 'object' && stateKey === null) onMessage(m, true);
});

// the default folder (HomeViewController: "New session in X") and the server's OS ("Choose…" needs macOS)
let defaultFolder = '';
let serverPlatform = '';
let routesKey: string | null = null;
function onMeta(m: StateMessage): void {
  const d = m.defaultFolder ?? '';
  if (has(m.platform)) serverPlatform = m.platform;
  if (d !== defaultFolder) {
    defaultFolder = d;
    routesKey = null;
  }
}
function onRoutes(list: Route[]): void {
  const key = JSON.stringify(list);
  if (key === routesKey) return;
  routesKey = key;
  routes = list;
  checkMine();
  renderHome();
}

// ---------- requests the Ask box sent (RouteWatcher.swift), followed on every page ----------
const mine = new Map<string, Request>(); // routeId -> the request (for Try Again / Edit)
function checkMine(): void {
  for (const [rid, req] of mine) {
    const r = routes.find((x) => x.id === rid);
    if (!r) continue;
    if (r.status === 'error') {
      mine.delete(rid);
      routeFailed(req, has(r.error) ? r.error : 'Unknown error');
    } else if (r.status === 'ask') {
      mine.delete(rid);
      toast('Which session? Choose on Home.');
    } else if (r.status === 'split') {
      mine.delete(rid);
      toast(`Split into ${String((r.tasks ?? []).length)} tasks. See Home.`);
    }
  }
  jumpIfSent();
}
// Home only (HomeViewController.reload): open the session once the router sent my request there
function jumpIfSent(): void {
  if (page.name !== 'home') return;
  const r = routes.find((x) => mine.has(x.id));
  const target = r?.target;
  if (!r || !has(target) || !has(r.decided) || !sessions.some((s) => s.id === target)) return;
  mine.delete(r.id);
  toast(`→ ${has(r.targetName) ? r.targetName : 'session'}: ${r.reason ?? ''}`);
  setTimeout(() => {
    go('session', target);
  }, 200);
}
/** POST a request (`route`) or a command (`command`); the answer, or the error to show. */
async function postRequest(
  name: string,
  body: Record<string, unknown>,
  refused: string,
): Promise<{ res: ApiAnswer; error: string }> {
  let res: ApiAnswer = {};
  let error = '';
  try {
    const r = await post(name, body);
    res = (await r.json().catch(() => ({}))) as ApiAnswer;
    if (!r.ok) error = has(res.error) ? res.error : `HTTP ${String(r.status)}`;
  } catch {
    error = 'The server does not answer';
  }
  if (!error && !has(res.routeId)) error = has(res.error) ? res.error : refused;
  return { res, error };
}
async function sendRequest(text: string, attachments: string[]): Promise<void> {
  const { res, error } = await postRequest('route', { text, attachments }, 'The server did not take the request');
  const routeId = res.routeId;
  if (error || !has(routeId)) {
    routeFailed({ text, attachments }, error);
    return;
  }
  mine.set(routeId, { text, attachments });
  toast('Finding the right session…');
  checkMine();
}
/** Send a Claude Code command to the session the user chose (`target`; null = a new session in the
 * default folder) and follow it. It does not go through the router (server.ts `command`). */
async function sendCommand(text: string, attachments: string[], target: string | null, name: string): Promise<void> {
  const again = (): void => {
    void sendCommand(text, attachments, target, name);
  };
  const body = target === null ? { text, attachments } : { text, attachments, target };
  const { res, error } = await postRequest('command', body, 'The server did not take the command');
  const routeId = res.routeId;
  if (error || !has(routeId)) {
    routeFailed({ text, attachments, retry: again }, error);
    return;
  }
  // "New session": the server made it (`id`). Try Again goes to that session while it is open, so a
  // failed delivery does not make one more session each time.
  const retry = (): void => {
    const s = retryTarget(target, res.id, sessions);
    if (s) void sendCommand(text, attachments, s.id, s.name);
    else again();
  };
  mine.set(routeId, { text, attachments, retry });
  toast(`Sending to ${name}…`);
  checkMine();
}
let failedReq: Request | null = null;
function routeFailed(req: Request, error: string): void {
  failedReq = req;
  const shown = req.text.length > 300 ? `${req.text.slice(0, 300)}…` : req.text;
  $('#rf-body').textContent = `${shown}\n\nError: ${error}`;
  openDialog('#route-failed');
  $('#rf-retry').focus();
}
$('#rf-retry').addEventListener('click', () => {
  closeDialog('#route-failed');
  if (failedReq?.retry) failedReq.retry();
  else if (failedReq) void sendRequest(failedReq.text, failedReq.attachments);
});
$('#rf-edit').addEventListener('click', () => {
  closeDialog('#route-failed');
  go('home');
  if (failedReq) ask.restore(failedReq.text, failedReq.attachments);
});

// ---------- Home page (HomeViewController.swift) ----------
const RSTATUS: Record<string, string> = {
  split: 'Split into tasks',
  routing: 'Finding the right session…',
  sending: 'Sending…',
  'handing-off': 'Moving the work to this Mac…',
  briefing: 'Writing background for the new session…',
  queued: 'Waiting for the session',
  sent: 'Sent',
  ask: 'Which session?',
  error: 'Failed',
};
const ICON = {
  plus: '<svg viewBox="0 0 20 20" width="12" height="12" aria-hidden="true"><path d="M10 4v12M4 10h12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  folder:
    '<svg viewBox="0 0 20 20" width="12" height="12" aria-hidden="true"><path d="M2.5 5.5a1.5 1.5 0 0 1 1.5-1.5h3.6l1.6 1.8H16a1.5 1.5 0 0 1 1.5 1.5v7.2a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  xmark:
    '<svg viewBox="0 0 20 20" width="11" height="11" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
} as const;
const baseName = (p: string | undefined): string => (p ?? '').replace(/\/+$/, '').split('/').pop() ?? '';
function mkBtn(text: string, cls: string, fn: () => void, icon?: keyof typeof ICON): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.innerHTML = (icon === undefined ? '' : ICON[icon]) + `<span class="bl">${esc(text)}</span>`;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    fn();
  });
  return b;
}
const onKeyOpen = (el: HTMLElement, fn: () => void) => (e: KeyboardEvent) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target === el) {
    e.preventDefault();
    fn();
  }
};
function renderHome(): void {
  // Needs you
  const needs = sessions.filter((s) => needsYou(s)); // an offline helper cannot answer
  $('#needs-wrap').classList.toggle('hidden', needs.length === 0);
  const nb = $('#needs');
  nb.innerHTML = '';
  for (const s of needs) nb.append(needsCard(s));
  // Recent requests: not the dry runs, at most 8
  const list = routes.filter((r) => r.status !== 'dry').slice(0, 8);
  $('#requests-wrap').classList.toggle('hidden', list.length === 0);
  const rb = $('#requests');
  rb.innerHTML = '';
  for (const r of list) rb.append(requestCard(r));
}
function needsCard(s: Session): HTMLDivElement {
  const c = document.createElement('div');
  c.className = 'card click tint-red need-card';
  c.dataset['testid'] = `home.needs.${s.name}`;
  c.setAttribute('role', 'button');
  c.tabIndex = 0;
  c.setAttribute('aria-label', `Needs you: ${s.name}`);
  const q = has(s.question) ? s.question : `${agentName(s)} is waiting for your choice.`;
  c.innerHTML =
    `<span class="dot needs"></span><div class="nc-body"><div class="nc-name"><span class="nm">${esc(s.name)}</span>${agentBadge(s)}</div>` +
    `<div class="nc-q">${esc(q)}</div><div class="nc-btns"></div></div>`;
  const row = within(c, '.nc-btns');
  for (const o of (s.options ?? []).slice(0, 4)) {
    const b = mkBtn(o.label, 'btn small nc-opt' + (/^yes/i.test(o.label) ? ' tint-green' : ''), () => {
      b.disabled = true;
      api('choose', { id: s.id, n: o.n })
        .catch(() => {
          /* toast shown */
        })
        .finally(() => {
          b.disabled = false;
        });
    });
    b.title = o.label;
    b.dataset['testid'] = `home.needs.${s.name}.choice.${String(o.n)}`;
    row.append(b);
  }
  const open = (): void => {
    go('session', s.id);
  };
  row.append(mkBtn('Open', 'btn', open));
  c.addEventListener('click', open);
  c.addEventListener('keydown', onKeyOpen(c, open));
  c.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, s);
  });
  return c;
}
function requestPill(status: string): string {
  if (status === 'sent' || status === 'split') return 'idle';
  if (status === 'ask') return 'amber-fill';
  if (status === 'error') return 'needs';
  return 'working';
}
function requestCard(r: Route): HTMLDivElement {
  const unsure = r.status === 'ask' || r.status === 'error';
  const c = document.createElement('div');
  c.className = 'card req-card' + (unsure ? ' tint-amber' : '');
  c.dataset['testid'] = `home.request.${r.id}`;
  const text = has(r.part) ? `↳ ${r.part}  ${r.text}` : r.text;
  const when = new Date(r.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const why = has(r.error) ? r.error : (r.reason ?? '');
  c.innerHTML =
    `<div class="rq-top"><div class="rq-left"><span class="pill ${requestPill(r.status)}">${esc(RSTATUS[r.status] ?? r.status)}</span>` +
    `<span class="rq-text" title="${esc(r.text)}">${esc(text)}</span></div>` +
    `<span class="rq-time">${esc(when)}</span></div>` +
    (why ? `<div class="rq-reason">${esc(why)}</div>` : '');
  const target = has(r.target) ? sessions.find((s) => s.id === r.target) : undefined;
  if (target) {
    const open = (): void => {
      go('session', target.id);
    };
    const g = mkBtn(`→ ${target.name}`, 'btn small', open);
    g.dataset['testid'] = `home.request.${r.id}.go`;
    within(c, '.rq-left').append(g);
    c.classList.add('click');
    c.addEventListener('click', open);
  }
  const x = mkBtn(
    '',
    'icon-btn rq-x',
    run(() => api('dismissRoute', { routeId: r.id })),
    'xmark',
  );
  x.title = 'Remove';
  x.setAttribute('aria-label', 'Remove');
  within(c, '.rq-top').append(x);
  if (unsure) c.append(requestOptions(r));
  return c;
}
function requestOptions(r: Route): HTMLDivElement {
  const opts = document.createElement('div');
  opts.className = 'rq-opts';
  const def = defaultFolder;
  const newName = r.newName ?? '';
  if (def) {
    const b = mkBtn(
      `New session in ${baseName(def)}`,
      'btn small primary',
      run(() => routeTo(r, { folder: def, name: newName })),
      'plus',
    );
    b.title = def;
    b.dataset['testid'] = `home.request.${r.id}.newDefault`;
    opts.append(b);
  }
  const seen = new Set<string>();
  for (const ch of r.choices ?? []) {
    seen.add(ch.id);
    const b = mkBtn(
      ch.name,
      'btn small primary',
      run(() => routeTo(r, { target: ch.id })),
    );
    b.dataset['testid'] = `home.request.${r.id}.pick.${ch.name}`;
    opts.append(b);
  }
  for (const s of sessions) {
    if (seen.has(s.id) || s.state === 'elsewhere') continue;
    const b = mkBtn(
      s.name,
      'btn small',
      run(() => routeTo(r, { target: s.id })),
    );
    b.dataset['testid'] = `home.request.${r.id}.pick.${s.name}`;
    opts.append(b);
  }
  const folder = r.folder;
  if (has(folder) && folder !== def)
    opts.append(
      mkBtn(
        `New in ${baseName(folder)}`,
        'btn small',
        run(() => routeTo(r, { folder, name: newName })),
        'plus',
      ),
    );
  opts.append(
    mkBtn(
      'New Session…',
      'btn small',
      run(() => openNew(folder ?? '', r.id)),
      'folder',
    ),
  );
  return opts;
}
async function routeTo(r: Route, body: Record<string, unknown>): Promise<void> {
  const { id } = await api('routeTo', { routeId: r.id, ...body });
  if (has(id))
    setTimeout(() => {
      if (id) go('session', id);
    }, 400);
}

// ---------- Ask box (Composer.swift ComposerBox) ----------
const IMAGE_RE = /\.(png|jpe?g|gif|webp|heic)$/i;
const ATTACH_RE =
  /\.(png|jpe?g|gif|webp|heic|pdf|txt|md|csv|tsv|json|ya?ml|xml|html?|log|ipynb|py|js|ts|swift|java|go|rs|c|cpp|h|rb|sh|sql)$/i;
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
};
const attachable = (f: File): boolean => ATTACH_RE.test(f.name) || MIME_EXT[f.type] !== undefined;
interface ComposerParts {
  box: HTMLFormElement;
  text: HTMLTextAreaElement;
  chips: HTMLElement;
  file: HTMLInputElement;
  attach: HTMLElement;
  min: number;
  max: number;
  draft: string | null;
  onSend: (text: string, attachments: string[]) => void;
  onKey?: (e: KeyboardEvent) => boolean; // sees each key first; true = used (the command list)
  onText?: () => void; // the text changed
  interceptSend?: (text: string, attachments: string[]) => boolean; // true = do not send, keep the text
}
interface Composer {
  focus: () => void;
  submit: () => void;
  setText: (t: string) => void;
  clear: () => void;
  setDraftKey: (k: string | null) => void;
  moveDraft: (k: string, afterRestart: boolean) => void;
  restore: (t: string, att: string[]) => void;
}
function readB64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.addEventListener('load', () => {
      resolve(typeof fr.result === 'string' ? fr.result.replace(/^data:[^,]*,/, '') : '');
    });
    fr.addEventListener('error', () => {
      reject(fr.error ?? new Error('read failed'));
    });
    fr.readAsDataURL(blob);
  });
}
// one composer box (Composer.swift ComposerBox): growing text, attachment chips, paste / drop, a draft per key.
// The Ask box on Home and the composer of the Session page both use it.
function makeComposer(parts: ComposerParts): Composer {
  const { box, text, chips, file, attach, min, max, draft, onSend } = parts;
  let draftKey = draft; // localStorage key of the draft (null: no draft)
  let files: string[] = []; // absolute paths on the server
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  function fit(): void {
    text.style.height = 'auto';
    text.style.height = `${String(Math.max(min, Math.min(max, text.scrollHeight + 2)))}px`;
  }
  // text and attached files are both kept, so a reload, a crash or a closed tab loses neither (Composer.swift)
  function saveDraft(): void {
    if (draftKey === null) return;
    store(Restore.textKey(draftKey), text.value || null);
    store(Restore.filesKey(draftKey), files.length > 0 ? JSON.stringify(files) : null);
  }
  let typed = false; // the box changed since its draft was loaded (moveDraft)
  function scheduleDraft(): void {
    typed = true;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 400);
  }
  text.addEventListener('input', () => {
    fit();
    scheduleDraft();
    parts.onText?.();
  });
  text.addEventListener('keydown', (e) => {
    if (parts.onKey?.(e) === true) return;
    if ((e.key === 'Enter' || e.key === 'NumpadEnter') && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  box.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  function submit(): void {
    const t = text.value.trim();
    if (!t && files.length === 0) return;
    const att = [...files];
    if (parts.interceptSend?.(t, att) === true) return;
    clear();
    text.focus();
    onSend(t, att);
  }
  function clear(): void {
    text.value = '';
    setFiles([]);
    clearTimeout(draftTimer);
    saveDraft();
    fit();
  }
  const displayName = (p: string): string => baseName(p).replace(/^\d{10,}-/, '');
  function setFiles(list: string[]): void {
    files = list;
    chips.innerHTML = '';
    chips.classList.toggle('hidden', files.length === 0);
    for (const p of files) chips.append(chip(p));
  }
  function chip(p: string): HTMLDivElement {
    const c = document.createElement('div');
    c.className = 'chip-att';
    const img = IMAGE_RE.test(p);
    const src = img
      ? `/api/attachment?path=${encodeURIComponent(p)}`
      : `/api/thumb?path=${encodeURIComponent(p)}&size=68`;
    c.innerHTML =
      `<a class="ca-thumb" href="${esc(src)}" target="_blank" rel="noopener" title="Preview"><img alt="" src="${esc(src)}"></a>` +
      `<span class="ca-name" title="${esc(displayName(p))}">${esc(displayName(p))}</span>`;
    const im = within(c, 'img');
    im.addEventListener('error', () => {
      const doc = document.createElement('span');
      doc.className = 'ca-doc';
      doc.textContent = (p.split('.').pop() ?? '').toUpperCase().slice(0, 4);
      im.replaceWith(doc);
    });
    if (!img) within(c, '.ca-thumb').removeAttribute('href');
    const x = mkBtn(
      '',
      'icon-btn ca-x',
      () => {
        setFiles(files.filter((f) => f !== p));
        scheduleDraft();
        text.focus();
      },
      'xmark',
    );
    x.title = 'Remove image';
    x.setAttribute('aria-label', 'Remove image');
    c.append(x);
    return c;
  }
  async function add(list: File[]): Promise<void> {
    const ok = list.filter((f) => attachable(f));
    if (ok.length === 0) {
      if (list.length > 0) toast('This kind of file cannot be attached');
      return;
    }
    for (const f of ok) {
      const name = ATTACH_RE.test(f.name) ? f.name : `pasted${MIME_EXT[f.type] ?? '.png'}`;
      try {
        const { path } = await api('upload', { name, data: await readB64(f) });
        if (has(path)) {
          setFiles([...files, path]);
          scheduleDraft();
        }
      } catch {
        /* toast shown */
      }
    }
    text.focus();
  }
  text.addEventListener('paste', (e) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const fl = [...cd.files].filter((f) => attachable(f));
    const hasText = cd.getData('text/plain') !== '';
    // files are attached; image data only when there is no text to paste (the Claude app's rule)
    if (fl.length > 0 && (!hasText || fl.some((f) => f.name !== '' && !/^image\.\w+$/.test(f.name)))) {
      e.preventDefault();
      void add(fl);
      return;
    }
    if (!hasText) {
      const imgs = [...cd.items]
        .filter((i) => i.kind === 'file' && MIME_EXT[i.type] !== undefined)
        .map((i) => i.getAsFile())
        .filter((f): f is File => f !== null);
      if (imgs.length > 0) {
        e.preventDefault();
        void add(imgs);
      }
    }
  });
  let depth = 0;
  const hasFiles = (e: DragEvent): boolean => [...(e.dataTransfer?.types ?? [])].includes('Files');
  box.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    box.classList.add('drag');
  });
  box.addEventListener('dragover', (e) => {
    if (!hasFiles(e) || !e.dataTransfer) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  box.addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      box.classList.remove('drag');
    }
  });
  box.addEventListener('drop', (e) => {
    if (!hasFiles(e) || !e.dataTransfer) return;
    e.preventDefault();
    depth = 0;
    box.classList.remove('drag');
    void add([...e.dataTransfer.files]);
  });
  attach.addEventListener('click', () => {
    file.click();
  });
  file.addEventListener('change', () => {
    const l = [...(file.files ?? [])];
    file.value = '';
    void add(l);
  });
  // the saved draft of the key: text and the attached files that are still on the server
  function loadDraft(): void {
    const k = draftKey;
    text.value = k === null ? '' : (stored(Restore.textKey(k)) ?? '');
    const saved = k === null ? [] : Restore.parseFiles(stored(Restore.filesKey(k)));
    typed = false;
    setFiles(saved);
    fit();
    if (saved.length === 0) return;
    // a quiet check (no toast): an old server without the action keeps the files
    void post('attachmentsExist', { paths: saved })
      .then(async (r) => (r.ok ? ((await r.json()) as { paths?: unknown }) : null))
      .then((j) => {
        if (!j || !Array.isArray(j.paths)) return;
        const left = (j.paths as unknown[]).filter((x): x is string => typeof x === 'string');
        // only when the box still shows these files (the user may have changed them meanwhile)
        if (draftKey !== k || files.join('\n') !== saved.join('\n') || left.length === saved.length) return;
        setFiles(saved.filter((f) => left.includes(f)));
        saveDraft();
      })
      .catch(() => undefined);
  }
  loadDraft();
  requestAnimationFrame(fit);
  return {
    focus() {
      text.focus();
    },
    submit,
    clear,
    // replace the text (a command picked from the list); the cursor goes to the end
    setText(t) {
      text.value = t;
      text.setSelectionRange(t.length, t.length);
      clearTimeout(draftTimer);
      saveDraft();
      fit();
    },
    // another draft key (the Session page: one draft per session)
    setDraftKey(k) {
      if (k === draftKey) return;
      clearTimeout(draftTimer);
      saveDraft();
      draftKey = k;
      loadDraft();
    },
    // Composer.moveDraft: keep the draft in the box under a new key (the session got its transcript id)
    moveDraft(k, afterRestart) {
      const old = draftKey;
      if (old === null) return;
      const how = Restore.moveDraft(
        { get: stored, set: store },
        { old, key: k, boxEmpty: !text.value && files.length === 0, typed, saved: launchPage, afterRestart },
      );
      if (how === 'none') return;
      clearTimeout(draftTimer);
      draftKey = k;
      if (how === 'carry') saveDraft();
      else loadDraft();
    },
    // a failed request goes back into the box, unless the user typed something new
    restore(t, att) {
      if (text.value.trim()) return;
      text.value = t;
      setFiles([...att]);
      saveDraft();
      fit();
      text.focus();
    },
  };
}
const ask = makeComposer({
  box: $as('#ask', HTMLFormElement),
  text: $as('#ask-text', HTMLTextAreaElement),
  chips: $('#ask-chips'),
  file: $as('#ask-file', HTMLInputElement),
  attach: $('#ask-attach'),
  min: 70,
  max: 220,
  draft: 'home',
  onSend: (t, att) => {
    void sendRequest(t, att);
  },
  onKey: (e) => picker.key(e),
  onText: () => {
    picker.textChanged();
  },
  interceptSend: (t, att) => picker.sending(t, att),
});
// "/" in the Ask box: Claude Code's commands; a command runs in the session the user chooses
const picker = makeCommandMenu({
  text: $as('#ask-text', HTMLTextAreaElement),
  list: $('#ask-commands'),
  submit: ask.submit,
  setText: ask.setText,
  clear: ask.clear,
  sessions: () => sessions,
  defaultFolder: () => defaultFolder,
  toast,
  send: (text, files, target, name) => {
    void sendCommand(text, files, target, name);
  },
});

/** An idle session that waits for the owner (server.ts Session.waits: its last reply asks a question, or
 * its input box holds text that was never sent) is shown like 'needs': first, notified, with the text and
 * no option buttons. Only the panel shows it so: the server keeps it 'idle' (it may receive messages). */
function shown(s: Session): Session {
  if (s.state !== 'idle' || !s.waits) return s;
  const question = s.waits.kind === 'draft' ? `Not sent: ${s.waits.text}` : s.waits.text;
  return { ...s, state: 'needs', question, options: [] };
}
function onState(list: Session[], snapshot = false, early = false): void {
  for (const s of list) {
    const n = mayNotify(s) ? noticeFor(s, prev.get(s.id), agentName(s)) : null;
    if (n) notify(n);
    prev.set(s.id, s.state);
    if (s.state !== 'working') stopSent.delete(s.id); // the next working turn may be stopped again
    // Recent order: first seen = its last activity; leaving "working" = now (a running session keeps its place)
    if (!orderKey.has(s.id)) orderKey.set(s.id, s.activity ?? 0);
    else if (lastState.get(s.id) === 'working' && s.state !== 'working') orderKey.set(s.id, Date.now());
    lastState.set(s.id, s.state);
  }
  const key = JSON.stringify(
    list.map((s) => {
      const rest: Partial<Session> = { ...s };
      delete rest.activity;
      return rest;
    }),
  );
  sessions = list;
  const open = page.name === 'session' ? page.id : null;
  // a preparing row of a new session on a helper became that session: follow it (MainWindow.swift)
  const became = open === null ? null : preparedSession(sessions, open);
  if (became !== null) {
    stateKey = key;
    go('session', became, true);
    render();
    return;
  }
  // the open session: waits during a restore, found by transcript id, or All Sessions when it went away
  // (MainWindow.swift); not on the empty snapshot a restarted server sends before its first poll
  if (!early && checkSessionPage(snapshot)) {
    stateKey = key;
    render();
    return;
  }
  if (key === stateKey) return; // nothing visible changed: keep DOM (no lost clicks)
  stateKey = key;
  render();
}

// ---------- crash restore (MainWindow.swift refresh and LastPage; public/restore.ts) ----------
// After a reload or a new tab on a saved session page: wait for that session while the server builds
// the windows again, and find it by its transcript id when tmux gave it a new window id.
let serverRestoring = false;
let restoreWait: Restore.RestoreWait = { pending: false, until: null };
let restoreRetry: ReturnType<typeof setTimeout> | undefined;
const savedPage = (): Restore.LastPage | null => Restore.parseLastPage(stored(Restore.LAST_PAGE_KEY));
// the last page saved before this page load (who owns a window-id draft: Restore.moveDraft)
const launchPage = savedPage();
// a page the user chose: always saved. From a state update (confirm): only when Restore.shouldSave
function savePage(p: Page, fromState = false, launching = false): void {
  const known = p.name === 'session' ? (sessions.find((s) => s.id === p.id)?.sid ?? '') : '';
  const saved = savedPage();
  const next = Restore.lastPageFor(p, known, saved);
  if (fromState && !Restore.shouldSave(next, saved, launching)) return;
  if (JSON.stringify(next) !== JSON.stringify(saved)) store(Restore.LAST_PAGE_KEY, JSON.stringify(next));
}
/** The Session page against the new state. True when it changed the page. */
function checkSessionPage(snapshot = false): boolean {
  if (page.name !== 'session') return false;
  const id = page.id;
  const launching = restoreWait.pending || restoreWait.until !== null;
  const { step, wait } = Restore.restoreStep(
    { id, sessions, connected: connected || snapshot, restoring: serverRestoring, saved: savedPage(), now: Date.now() },
    restoreWait,
  );
  restoreWait = wait;
  if (step.kind === 'open') {
    go('session', step.id, true);
    return true;
  }
  if (step.kind === 'sessions') {
    go('sessions', undefined, true);
    return true;
  }
  if (step.kind === 'wait') {
    clearTimeout(restoreRetry);
    restoreRetry = setTimeout(() => {
      if (checkSessionPage()) render();
    }, 1000);
    return false;
  }
  if (step.confirm) savePage(page, true, launching);
  // the draft follows the conversation once the session has a transcript id
  const s = sessions.find((x) => x.id === id);
  if (s) detailComposer.moveDraft(Restore.draftKeyFor(id, s.sid), launching || serverRestoring);
  return false;
}

// ---------- notifications (main.swift: only when the app is not in front) ----------
// The browser asks for permission on the first click on the page, or before the first notice.
function askNotices(): void {
  if ('Notification' in window && mayAskNotices(Notification.permission))
    void Notification.requestPermission().catch(() => undefined);
}
document.addEventListener('pointerdown', askNotices, { once: true, capture: true });
function notify(n: Notice): void {
  if (!showNotice({ hidden: document.hidden, focused: document.hasFocus() })) return;
  if (!('Notification' in window)) return;
  if (mayAskNotices(Notification.permission)) {
    // a browser may ignore an ask without a click; the notice shows once the answer is yes
    void Notification.requestPermission()
      .then((p) => {
        if (p === 'granted') postNotice(n);
      })
      .catch(() => undefined);
    return;
  }
  if (Notification.permission === 'granted') postNotice(n);
}
function postNotice(n: Notice): void {
  try {
    const shown = new Notification(n.title, { body: n.body.slice(0, 180), tag: `${n.id}-${String(Date.now())}` });
    shown.addEventListener('click', () => {
      window.focus();
      go('session', n.id);
      shown.close();
    });
  } catch {
    /* some browsers allow notices only from a service worker */
  }
}

// ---------- badge: count of sessions that need you ----------
let favBase: string | null = null;
let badgeN = 0;
void fetch('/favicon.svg')
  .then(async (r) => r.text())
  .then((t) => {
    favBase = t;
    badge(badgeN, true);
  })
  .catch(() => {
    /* no favicon */
  });
function badge(n: number, force = false): void {
  if (n === badgeN && !force) return;
  badgeN = n;
  document.title = (n > 0 ? `(${String(n)}) ` : '') + 'Thoth';
  try {
    if (n > 0) void navigator.setAppBadge(n).catch(() => undefined);
    else void navigator.clearAppBadge().catch(() => undefined);
  } catch {
    /* not an installed app */
  }
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link || favBase === null) return;
  link.href =
    n > 0
      ? 'data:image/svg+xml,' +
        encodeURIComponent(
          favBase.replace('</svg>', '<circle cx="12.5" cy="3.5" r="3.5" fill="#E4472F" stroke="#FBF8F1"/></svg>'),
        )
      : '/favicon.svg';
}

// ---------- sidebar (MainWindow.swift SidebarController) ----------
// select mode: tick sessions and close them together (public/select.ts)
const sel = new SelectMode();
const selHooks: SelectHooks = {
  sessions: () => sessions,
  render: () => {
    render();
  },
  close: (ids) => {
    for (const id of ids) void closeSession(sessions.find((s) => s.id === id));
  },
};
const selBar = mountBar(sel, selHooks);
const tidyHooks: TidyHooks = {
  ask: async () =>
    api('tidy').catch((error: unknown) => {
      if (error instanceof TypeError) toast('The server does not answer'); // fetch failed: api() showed nothing
      throw error;
    }),
  render: () => {
    render();
  },
};
$('#rows').addEventListener('keydown', (e) => {
  onRowsKey(e, sel);
});
function render(): void {
  const box = $('#rows');
  // the rows are rebuilt: keep the keyboard focus on the same session row
  const focused = document.activeElement;
  const refocus = focused instanceof HTMLElement && box.contains(focused) ? focused.dataset['id'] : undefined;
  const refocusSelect = focused instanceof HTMLElement && focused.classList.contains('side-h-btn');
  box.innerHTML = '';
  sel.reload(sessions);
  // this Mac's sessions under Needs You / Recent; each helper computer's under its own name
  const local = sessions.filter((s) => !has(s.device));
  const needs = local.filter((s) => s.state === 'needs');
  if (needs.length > 0) {
    box.append(header('Needs You'));
    for (const s of needs) box.append(row(s));
  }
  const rest = local
    .filter((s) => s.state !== 'needs')
    .toSorted((a, b) => (orderKey.get(b.id) ?? 0) - (orderKey.get(a.id) ?? 0) || b.id.localeCompare(a.id));
  if (rest.length > 0) {
    box.append(header('Recent'));
    for (const s of rest) box.append(row(s));
  }
  // every helper computer has a header (also one without sessions: it may need an update)
  for (const g of deviceGroups(peers, sessions, (id) => orderKey.get(id) ?? 0)) {
    box.append(
      deviceHeader(g, DEV_IC.pc, {
        menu: (x, y) => {
          deviceMenu(x, y, g.device, g.peer);
        },
        update: () => {
          updateHelper(g.device);
        },
      }),
    );
    for (const s of g.sessions) box.append(row(s));
  }
  // Select / Done on the first session header ("Needs You" when a session needs you; never a helper's header)
  // with Tidy left of it (public/tidy.ts: the AI suggests which sessions to close)
  box.querySelector('.side-h:not(.side-dev)')?.append(tidyButton(sel, tidyHooks), headerButton(sel, selHooks));
  if (refocus !== undefined) box.querySelector<HTMLElement>(`.row[data-id="${CSS.escape(refocus)}"]`)?.focus();
  if (refocusSelect) box.querySelector<HTMLElement>('.side-h-btn')?.focus(); // Select / Done pressed
  badge(sessions.filter((s) => s.state === 'needs').length);
  markSelection();
  selBar.update();
  renderSessionsPage();
  renderHome();
  jumpIfSent();
  if (selected !== null) renderDetail();
}
function header(t: string): HTMLDivElement {
  const h = document.createElement('div');
  h.className = 'side-h';
  h.dataset['testid'] = `header.${t}`;
  const name = document.createElement('span');
  name.textContent = t;
  name.setAttribute('role', 'heading');
  name.setAttribute('aria-level', '3');
  h.append(name); // Select / Done goes next to it, not inside the heading
  return h;
}
function row(s: Session): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'row' + (has(s.title) ? ' tall' : '');
  b.dataset['id'] = s.id;
  b.dataset['testid'] = `session.${s.name}`;
  b.setAttribute('aria-label', `${s.name}, ${label(s)}`);
  b.title = rowTip(s, short);
  if (isOffline(s)) b.classList.add('offline'); // a helper computer that does not answer: grey
  const needs = s.state === 'needs';
  b.innerHTML =
    `<span class="dot ${stateClass(s.state)}"></span><span class="rt"><span class="rn"><span class="nm">${esc(s.name)}</span>${agentBadge(s)}</span>${has(s.title) ? `<span class="sub">${esc(s.title)}</span>` : ''}</span>` +
    `<span class="tm${needs ? ' needs' : ''}">${needs ? 'Needs you' : esc(ago(s.activity))}</span>`;
  b.addEventListener('click', () => {
    if (!rowClick(s, sel, selHooks)) go('session', s.id);
  });
  b.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, s);
  });
  if (sel.selecting) asCheckRow(b, s, sel);
  return b;
}
function markSelection(): void {
  for (const n of document.querySelectorAll<HTMLElement>('#sidebar .nav'))
    n.classList.toggle('sel', page.name === n.dataset['page']);
  const open = page.name === 'session' ? page.id : null;
  for (const r of document.querySelectorAll<HTMLElement>('#sidebar .row'))
    r.classList.toggle('sel', !sel.selecting && open !== null && r.dataset['id'] === open);
}
for (const n of document.querySelectorAll<HTMLElement>('#sidebar .nav'))
  n.addEventListener('click', () => {
    const p = n.dataset['page'];
    if (isPage(p)) go(p);
  });

// ---------- helper computers: headers and "Update <device>" (helper_update.ts) ----------
let peers: PeerInfo[] = [];
let peersKey = '';
function onPeers(list: PeerInfo[]): void {
  const k = JSON.stringify(list);
  if (k === peersKey) return;
  peersKey = k;
  peers = list;
  stateKey = null; // the sidebar draws again with the next sessions list
}
/** "Update <device>" (header menu and button): the server sends this Mac's Thoth to the helper. */
function updateHelper(device: string): void {
  api('updateHelper', { device, updateId: newUpdateId() }).catch(() => {
    // refused (toast shown): draw the sidebar again, so the greyed button can be clicked again
    stateKey = null;
    render();
  });
}
/** The header's menu: "Update <device>", greyed unless the helper is older (or failed) and online. */
function deviceMenu(x: number, y: number, device: string, peer: PeerInfo | undefined): void {
  menuAt(x, y, [
    [
      `Update ${device}`,
      showsUpdateButton(peer)
        ? () => {
            updateHelper(device);
          }
        : null,
    ],
  ]);
}

// ---------- join requests at the top of the sidebar (MainWindow.swift .join rows): joins.ts ----------
const joins = joinRequests($('#joins'), {
  esc,
  header,
  api,
  toast,
});

// ---------- All Sessions (SessionsViewController.swift): one section per project folder ----------
const RANK: Record<string, number> = {
  needs: 0,
  failed: 0,
  working: 1,
  preparing: 1,
  starting: 1,
  idle: 2,
  elsewhere: 3,
  stopped: 4,
};
const rank = (s: Session): number => RANK[s.state] ?? 9;
const FOLDER_IC =
  '<svg class="fic" viewBox="0 0 20 20" aria-hidden="true"><path class="fill" d="M2.5 5.5a1.5 1.5 0 0 1 1.5-1.5h3.6l1.6 1.8H16a1.5 1.5 0 0 1 1.5 1.5v7.2a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5z"/></svg>';
function renderSessionsPage(): void {
  const box = $('#sections'),
    empty = $('#s-empty');
  const f = $as('#filter', HTMLInputElement).value.trim().toLowerCase();
  // the filter matches name, folder, title and last reply (SessionsViewController.render)
  const shown = sessions.filter(
    (s) => !f || [s.name, s.folder, s.title, s.last].some((x) => (x ?? '').toLowerCase().includes(f)),
  );
  box.innerHTML = '';
  if (shown.length === 0) {
    empty.textContent = f ? 'No session matches.' : 'No sessions yet. Click New Session to start one.';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  const groups = new Map<string, Session[]>();
  // a helper computer's folder is its own group (same path, other computer)
  for (const s of shown) {
    const g = groups.get(groupKey(s));
    if (g) g.push(s);
    else groups.set(groupKey(s), [s]);
  }
  // groups with the most urgent session first, then the newest activity
  const minRank = (l: Session[]): number => Math.min(...l.map((s) => rank(s)));
  const newest = (l: Session[]): number => Math.max(...l.map((x) => x.activity ?? 0));
  const ordered = [...groups].toSorted(([, a], [, b]) => minRank(a) - minRank(b) || newest(b) - newest(a));
  for (const [, items] of ordered) box.append(folderSection(items[0]?.folder ?? '', items));
}
function folderSection(folder: string, items: Session[]): HTMLElement {
  const sec = document.createElement('section');
  sec.className = 'fsec';
  sec.dataset['testid'] = `section.${baseName(folder)}`;
  const branch = items[0]?.branch ?? '';
  const device = items[0]?.device ?? '';
  sec.innerHTML =
    `<div class="fsec-h">${FOLDER_IC}<span class="fsec-name">${esc(baseName(folder) || folder)}</span>` +
    `<span class="fsec-path" title="${esc(folder)}"${device ? ` data-testid="sessions.device.${esc(device)}"` : ''}>${esc(sectionPlace(folder, items, short) + (branch ? '  ·  ⎇ ' + branch : ''))}</span></div><div class="grid"></div>`;
  const grid = within(sec, '.grid');
  for (const s of items.toSorted((a, b) => rank(a) - rank(b))) grid.append(sessionCard(s));
  if (device) return sec; // a new session on a helper computer starts from New Session (Computer)
  const add = mkBtn(
    'New Session Here',
    'btn small',
    run(() => openNew(folder)),
    'plus',
  );
  add.dataset['testid'] = `section.${baseName(folder)}.new`;
  within(sec, '.fsec-h').append(add);
  return sec;
}
// a card, exactly 150 px high: dot, name, Codex badge, state; AI title; "You:" line; reply (3 lines)
function sessionCard(s: Session): HTMLDivElement {
  const t = document.createElement('div');
  t.className = 'card click tile' + (s.state === 'needs' ? ' tint-red' : '') + (isOffline(s) ? ' offline' : '');
  t.dataset['testid'] = `card.${s.name}`;
  t.setAttribute('role', 'button');
  t.tabIndex = 0;
  const on = isRemote(s) ? `, on ${s.device ?? ''}${isOffline(s) ? ', offline' : ''}` : '';
  t.setAttribute('aria-label', `${s.name}, ${label(s)}${on}`);
  let reply = has(s.last) ? s.last : '—';
  if (s.state === 'needs') reply = has(s.question) ? s.question : 'Waiting for your choice';
  t.innerHTML =
    `<div class="tile-top"><span class="dot ${stateClass(s.state)}"></span><span class="tile-name">${esc(s.name)}</span>${agentBadge(s)}` +
    `<span class="pill ${stateClass(s.state)}">${esc(label(s))}</span></div>` +
    `<div class="tile-title">${esc(s.title)}</div>` +
    `<div class="tile-prompt">You: ${esc(s.prompt)}</div>` +
    `<div class="tile-last">${esc(reply)}</div>`;
  const open = (): void => {
    go('session', s.id);
  };
  t.addEventListener('click', open);
  t.addEventListener('keydown', onKeyOpen(t, open));
  t.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, s);
  });
  return t;
}
$('#filter').addEventListener('input', renderSessionsPage);
$('#s-new').addEventListener(
  'click',
  run(() => openNew()),
);

// ---------- alert (NSAlert): resolves with the index of the button; -1 = Escape ----------
interface AlertButton {
  label: string;
  cls?: string;
}
let alertDone: ((i: number) => void) | null = null;
function alertBox(title: string, text: string, buttons: AlertButton[]): Promise<number> {
  return new Promise((resolve) => {
    alertDone?.(-1);
    $('#al-h').textContent = title;
    $('#al-body').textContent = text;
    $('#al-body').classList.toggle('hidden', !text);
    const foot = $('#al-btns');
    foot.innerHTML = '';
    const done = (i: number): void => {
      alertDone = null;
      closeDialog('#alert');
      resolve(i);
    };
    alertDone = done;
    // macOS order: the first (default) button is on the right
    let last: HTMLButtonElement | null = null;
    for (let i = buttons.length - 1; i >= 0; i--) {
      const def = buttons[i];
      if (!def) continue;
      const b = mkBtn(def.label, 'btn' + (has(def.cls) ? ` ${def.cls}` : ''), () => {
        done(i);
      });
      b.dataset['testid'] = `alert.button.${String(i)}`;
      foot.append(b);
      last = b;
    }
    openDialog('#alert');
    last?.focus();
  });
}
const okAlert = (title: string, text: string): void => {
  void alertBox(title, text, [{ label: 'OK', cls: 'primary' }]);
};
// a POST that does not show a toast: the caller puts the error text where the app puts it
async function apiQuiet<T>(name: string, body?: Record<string, unknown>): Promise<T> {
  let r: Response;
  let j: unknown;
  try {
    r = await post(name, body);
    j = await r.json().catch(() => ({}));
  } catch {
    throw new Error('The server does not answer');
  }
  const err = (j as { error?: string } | null)?.error;
  if (!r.ok) throw new Error(has(err) ? err : `HTTP ${String(r.status)}`);
  return (j ?? {}) as T;
}
async function copyText(t: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    /* not a secure page: the old way */
  }
  const ta = document.createElement('textarea');
  ta.value = t;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.append(ta);
  ta.select();
  let ok: boolean;
  try {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the only way on a page that is not secure (http on the LAN)
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
// the computer the server runs on ("this Mac" in the app)
const here = (): string => (serverPlatform && serverPlatform !== 'darwin' ? 'this computer' : 'this Mac');

// ---------- All Devices (EverywhereViewController.swift) ----------
interface Device {
  name: string;
  transport?: string;
  ok?: number | boolean;
  silent?: boolean;
  reconnect?: boolean;
  last_sync?: number | string;
  sessions?: number;
  error?: string;
  os?: string;
  online?: boolean | null; // the brain's heartbeat (brain/heartbeat.py)
  last_heartbeat?: number | null;
}
interface BrainSession {
  sid: string;
  device: string;
  agent?: string;
  project?: string;
  title?: string;
  first_prompt?: string;
  last_prompt?: string;
  last_reply?: string;
  cwd?: string;
  mtime?: number;
}
interface Handoff {
  id: string;
  status?: string;
  result?: string;
  target_path?: string;
}
interface HandoffResult {
  panel_session?: string;
  agent?: string;
}
const BRAIN_DOWN = 'The central brain is not running. Start it with: python3 brain/brain.py serve';
const DEV_IC = {
  laptop:
    '<svg class="dic" viewBox="0 0 20 20" aria-hidden="true"><rect x="3.5" y="4" width="13" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M1.5 15.5h17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  pc: '<svg class="dic" viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="3" width="15" height="10.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 13.5v3M6.5 16.8h7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  minus:
    '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="7.3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6.5 10h7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  again:
    '<svg viewBox="0 0 20 20" width="11" height="11" aria-hidden="true"><path d="M15.5 10a5.5 5.5 0 1 1-1.8-4.1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M14.5 2.5v3.8h-3.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  play: '<svg viewBox="0 0 20 20" width="10" height="10" aria-hidden="true"><path d="M5.5 3.5v13l11-6.5z" fill="currentColor"/></svg>',
  hand: '<svg viewBox="0 0 20 20" width="11" height="11" aria-hidden="true"><path d="M11 9l6-6M12.5 3H17v4.5M9 11l-6 6M7.5 17H3v-4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
} as const;
const devs = {
  list: [] as Device[],
  results: [] as BrainSession[],
  loadedOnce: false,
  agent: '',
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
  seq: 0,
};
const devPick = $as('#dev-pick', HTMLSelectElement);
const localDevice = (): string | null => devs.list.find((x) => x.transport === 'local')?.name ?? null;
const devStatus = (t: string): void => {
  $('#dev-status').textContent = t;
};
// the brain sends ok as 1 or true
const devOk = (d: Device): boolean => d.ok === 1 || d.ok === true;
function devicesShown(): void {
  void loadDevices();
  if (!devs.loadedOnce) {
    devs.loadedOnce = true;
    void runQuery();
  }
}
async function loadDevices(): Promise<void> {
  const list = await getJson('/api/deviceList');
  if (!Array.isArray(list)) {
    devs.list = [];
    renderDevices();
    devStatus(BRAIN_DOWN);
    return;
  }
  devs.list = list as Device[];
  renderDevices();
}
function renderDevices(): void {
  const box = $('#dev-chips');
  box.innerHTML = '';
  const was = devPick.value;
  devPick.innerHTML = '<option value="">All devices</option>';
  for (const d of devs.list) {
    const o = document.createElement('option');
    o.value = d.name;
    o.textContent = d.name;
    devPick.append(o);
    box.append(deviceChip(d));
  }
  devPick.value = devs.list.some((d) => d.name === was) ? was : '';
  // say it in words too: a quiet computer is easy to miss
  const quiet = devs.list.filter((d) => devOk(d) && d.silent === true);
  const note = $('#dev-silent');
  if (quiet.length === 0) {
    note.textContent = '';
    note.classList.add('hidden');
    return;
  }
  const can = quiet.some((d) => d.reconnect === true);
  note.textContent =
    `${quiet.map((d) => d.name).join(', ')} ${quiet.length === 1 ? 'has' : 'have'} sent nothing for more than 20 minutes. ` +
    'A computer that is off or asleep sends again when it wakes up.' +
    (can
      ? ' If it is on and still silent, choose Reconnect.'
      : ' If it is on and still silent, check that it is online.');
  note.classList.remove('hidden');
}
function deviceChip(d: Device): HTMLDivElement {
  const c = document.createElement('div');
  c.className = 'card click chip';
  c.dataset['testid'] = `everywhere.deviceChip.${d.name}`;
  c.setAttribute('role', 'button');
  c.tabIndex = 0;
  c.setAttribute('aria-label', `Device ${d.name}`);
  const silent = devOk(d) && d.silent === true;
  // the brain's own error stays the text; a stopped heartbeat says "Offline · last seen" (device_status.ts)
  const detail = chipText(d, ago);
  const win = (d.os ?? '').toLowerCase().includes('windows');
  c.innerHTML =
    `<span class="dot ${detail.good ? 'idle' : 'needs'}"></span>${win ? DEV_IC.pc : DEV_IC.laptop}` +
    `<span class="ct"><span class="cn">${esc(d.name + (d.transport === 'local' ? ` (${here()})` : ''))}</span>` +
    `<span class="cd${detail.warn ? ' warn' : ''}">${esc(detail.text)}</span></span>`;
  const only = (): void => {
    devPick.value = d.name;
    queryChanged();
  };
  c.addEventListener('click', only);
  c.addEventListener('keydown', onKeyOpen(c, only));
  // every computer but this one can be removed
  if (d.transport === 'local') return c;
  const reconnect = (): void => {
    addDev.open([], d.name);
  };
  const remove = (): void => {
    void confirmRemove(d);
  };
  if (silent && d.reconnect === true) {
    const again = mkBtn('Reconnect', 'btn small', reconnect);
    again.insertAdjacentHTML('afterbegin', DEV_IC.again);
    again.title = `${d.name} sends nothing. Get a command that connects it again`;
    again.dataset['testid'] = `everywhere.deviceChip.${d.name}.reconnect`;
    c.append(again);
  }
  const rm = mkBtn('', 'icon-btn rm', remove);
  rm.innerHTML = DEV_IC.minus;
  rm.title = `Remove ${d.name} from your brain`;
  rm.setAttribute('aria-label', `Remove ${d.name}`);
  rm.dataset['testid'] = `everywhere.deviceChip.${d.name}.remove`;
  c.append(rm);
  c.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    menuAt(e.clientX, e.clientY, [
      [`Show Only ${d.name}`, only],
      d.reconnect === true && [`Reconnect ${d.name}…`, reconnect],
      '-',
      [`Remove ${d.name}…`, remove],
    ]);
  });
  return c;
}
function queryChanged(): void {
  clearTimeout(devs.timer);
  devs.timer = setTimeout(() => void runQuery(), 250);
}
$('#dev-q').addEventListener('input', queryChanged);
devPick.addEventListener('change', queryChanged);
for (const b of document.querySelectorAll<HTMLElement>('#dev-agent [data-agent]')) {
  b.addEventListener('click', () => {
    devs.agent = b.dataset['agent'] ?? '';
    for (const x of document.querySelectorAll<HTMLElement>('#dev-agent [data-agent]'))
      x.classList.toggle('on', x === b);
    queryChanged();
  });
}
async function runQuery(): Promise<void> {
  const q = new URLSearchParams({ limit: '200' });
  const text = $as('#dev-q', HTMLInputElement).value.trim();
  if (text) q.set('q', text);
  if (devPick.value) q.set('device', devPick.value);
  if (devs.agent) q.set('agent', devs.agent);
  const seq = ++devs.seq;
  const list = await getJson(`/api/brain/sessions?${q.toString()}`);
  if (seq !== devs.seq) return; // a newer query was sent meanwhile
  if (!Array.isArray(list)) {
    devStatus(BRAIN_DOWN);
    return;
  }
  devs.results = list as BrainSession[];
  renderResults();
}
const displayTitle = (s: BrainSession): string => {
  if (has(s.title)) return s.title;
  return has(s.first_prompt) ? s.first_prompt : s.sid;
};
function projectName(p: string): string {
  if (p.startsWith('git:')) return p.slice(4);
  if (p.startsWith('folder:')) return p.slice(7);
  return p || 'No project';
}
function renderResults(): void {
  const box = $('#dev-results');
  box.innerHTML = '';
  const res = devs.results;
  const hit = new Set(res.map((s) => s.device));
  devStatus(
    res.length === 0
      ? 'No session matches.'
      : `${plural(res.length, 'session')} on ${plural(hit.size, 'device')}` + (res.length >= 200 ? ' (first 200)' : ''),
  );
  // group by project, keep the newest-first order of groups
  const groups = new Map<string, BrainSession[]>();
  for (const s of res) {
    const k = s.project ?? '';
    const g = groups.get(k);
    if (g) g.push(s);
    else groups.set(k, [s]);
  }
  for (const [k, items] of groups) {
    const g = document.createElement('div');
    g.className = 'rgrp';
    const devNames = [...new Set(items.map((s) => s.device))].toSorted().join(' · ');
    g.innerHTML = `<h3 class="rgrp-h">${esc(projectName(k))}   ${esc(devNames)}</h3>`;
    for (const s of items) g.append(resultRow(s));
    box.append(g);
  }
}
function resultRow(s: BrainSession): HTMLDivElement {
  const c = document.createElement('div');
  c.className = 'card rrow';
  const sid8 = s.sid.slice(0, 8);
  c.dataset['testid'] = `everywhere.result.${s.device}.${sid8}`;
  const local = localDevice();
  const codex = s.agent === 'codex';
  const who = codex ? 'Codex' : 'Claude';
  c.innerHTML =
    `<div class="rr-top"><span class="pill ${s.device === local ? 'dev-local' : 'dev-other'}">${esc(s.device)}</span>` +
    `<span class="pill ${codex ? 'ag-codex' : 'ag-claude'}">${who}</span>` +
    `<span class="rr-title">${esc(displayTitle(s))}</span><span class="rr-time">${esc(s.mtime === undefined ? '' : ago(s.mtime * 1000))}</span></div>` +
    `<div class="rr-you">${has(s.last_prompt) ? 'You: ' + esc(s.last_prompt) : ''}</div>` +
    `<div class="rr-reply">${esc(s.last_reply)}</div><div class="rr-cwd">${esc(s.cwd)}</div>`;
  const top = within(c, '.rr-top');
  // the browser cannot see the folder: a session of this computer may be opened; the server says if the folder is gone
  if (local !== null && s.device === local) {
    const openIt = (): void => {
      void openLocal(s);
    };
    const open = mkBtn('Open Here', 'btn small', openIt);
    open.insertAdjacentHTML('afterbegin', DEV_IC.play);
    open.dataset['testid'] = `everywhere.result.${s.device}.${sid8}.open`;
    top.append(open);
    c.classList.add('click');
    c.addEventListener('click', openIt);
  } else if (local === null) {
    top.insertAdjacentHTML('beforeend', `<span class="rr-na">Folder not on ${esc(here())}</span>`);
  } else {
    const hand = mkBtn(`Continue on ${here().replace(/^this/, 'This')}`, 'btn small', () => {
      void confirmHandoff(s);
    });
    hand.insertAdjacentHTML('afterbegin', DEV_IC.hand);
    hand.title = `Copy the code from ${s.device} to ${here()} and start ${who} here with a summary of the work`;
    hand.dataset['testid'] = `everywhere.result.${s.device}.${sid8}.handoff`;
    top.append(hand);
  }
  return c;
}
// continue a session of this computer in the panel (opens it if it is already there)
async function openLocal(s: BrainSession): Promise<void> {
  const open = sessions.find((x) => x.sid === s.sid);
  if (open) {
    go('session', open.id);
    return;
  }
  const body: Record<string, unknown> = { folder: s.cwd ?? '', sid: s.sid };
  if (s.agent === 'codex') body['agent'] = 'codex'; // the server runs `codex resume <sid>`
  try {
    const { id } = await api('new', body);
    if (has(id))
      setTimeout(() => {
        go('session', id);
      }, 500);
  } catch {
    /* toast shown */
  }
}
async function confirmHandoff(s: BrainSession): Promise<void> {
  const who = s.agent === 'codex' ? 'Codex' : 'Claude';
  const i = await alertBox(
    `Continue “${displayTitle(s)}” on ${here()}?`,
    `The brain copies the code from ${s.device} (${s.cwd ?? ''}) to a new folder on ${here()}, writes a summary of what was done and what is left, and opens a ${who} session here with it. Nothing on ${s.device} changes.`,
    [{ label: 'Continue Here', cls: 'primary' }, { label: 'Cancel' }],
  );
  if (i !== 0) return;
  devStatus(`Handing off from ${s.device}: reading the session, copying the code, writing the summary…`);
  let r: { id?: string; error?: string };
  try {
    const res = await post('brain/handoff', { device: s.device, sid: s.sid });
    r = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
    if (!res.ok) {
      devStatus(has(r.error) ? r.error : `Handoff failed (HTTP ${String(res.status)})`);
      return;
    }
  } catch {
    devStatus(BRAIN_DOWN);
    return;
  }
  if (has(r.id)) void pollHandoff(r.id, 0);
}
async function pollHandoff(id: string, tries: number): Promise<void> {
  const list = await getJson('/api/brain/handoffs?limit=20');
  const h = Array.isArray(list) ? (list as Handoff[]).find((x) => x.id === id) : undefined;
  const st = h?.status;
  if (h && st === 'ran') {
    // "prepared" comes first (code copied) and is not the end in panel mode
    let res: HandoffResult | null;
    try {
      res = JSON.parse(h.result ?? 'null') as HandoffResult | null;
    } catch {
      res = null;
    }
    devStatus(`Handoff ${id} ready: ${h.target_path ?? ''}`);
    const ps = res?.panel_session;
    if (has(ps)) {
      toast(
        `Opened on ${here()}. Approve the folder, then ${res?.agent === 'codex' ? 'Codex' : 'Claude'} gets the summary.`,
      );
      openWhenListed(ps, 0);
    }
  } else if (st === 'failed' || st === 'run-failed') {
    devStatus('Handoff failed');
    okAlert('Handoff failed', (h?.result ?? '').slice(-600));
  } else if (tries > 150) {
    devStatus('Handoff is taking long; check later.');
  } else
    setTimeout(() => {
      void pollHandoff(id, tries + 1);
    }, 2000);
}
// the panel state arrives every 1.5 s: open the new session once the page knows it
function openWhenListed(id: string, tries: number): void {
  if (sessions.some((s) => s.id === id) || tries > 20) {
    go('session', id);
    return;
  }
  setTimeout(() => {
    openWhenListed(id, tries + 1);
  }, 500);
}
async function confirmRemove(d: Device): Promise<void> {
  const n = d.sessions ?? 0;
  const i = await alertBox(
    `Remove “${d.name}” from your brain?`,
    `The brain deletes what it has from ${d.name}: ${plural(n, 'session')} and its memory files. ${d.name} can no longer send data to the brain.\n\n` +
      `Nothing on ${d.name} itself changes. To connect it again, choose Add Computer.`,
    [{ label: 'Remove', cls: 'danger' }, { label: 'Cancel' }],
  );
  if (i !== 0) return;
  devStatus(`Removing ${d.name}…`);
  let r: { note?: string; sessions?: number | string };
  try {
    r = await apiQuiet('deviceRemove', { name: d.name });
  } catch (error) {
    devStatus(`${d.name} was not removed.`);
    okAlert(`“${d.name}” was not removed`, errText(error));
    return;
  }
  if (devPick.value === d.name) devPick.value = '';
  if (has(r.note)) okAlert(`“${d.name}” is disconnected`, r.note);
  else toast(`Removed ${d.name}: ${plural(Number(r.sessions ?? 0), 'session')} deleted from the brain`);
  void loadDevices();
  void runQuery();
}
$('#dev-sync').addEventListener('click', () => {
  devStatus('Syncing all devices…');
  void post('brain/sync')
    .catch(() => {
      /* the reload says it */
    })
    .finally(() => {
      void loadDevices();
      void runQuery();
    });
});
$('#dev-add').addEventListener('click', () => {
  addDev.open(devs.list.map((d) => d.name));
});

// Add a Computer / Reconnect (AddDeviceController.swift)
interface DeviceCommand {
  device?: string;
  /** a computer on a cloud brain: one prompt for Claude Code there (lib/setup_prompt.ts) */
  prompt?: string;
  mode?: string;
  since?: number | string;
  command?: string;
  os?: string;
  firewall?: { cause?: string };
}
interface DeviceStatus {
  joined?: boolean;
  waiting?: boolean;
  lastSeen?: number | string;
  sessions?: number | string;
  pushed?: boolean;
}
const addDev = (() => {
  const name = $as('#ad-name', HTMLInputElement),
    os = $as('#ad-os', HTMLSelectElement),
    create = $as('#ad-create', HTMLButtonElement),
    copyBtn = $('#ad-copy'),
    promptBtn = $('#ad-prompt'),
    closeBtn = $('#ad-close');
  let reconnect: string | null = null,
    prompt = '',
    taken: string[] = [],
    device = '',
    localMode = false,
    joined = false,
    since = 0,
    started = 0,
    timer: ReturnType<typeof setInterval> | undefined;
  const CODE_MS = 15 * 60 * 1000; // the code in the command works for 15 minutes
  const setCreate = (t: string): void => {
    within(create, 'span').textContent = t;
  };
  const state = (t: string): void => {
    $('#ad-state').textContent = t;
  };
  const spin = (on: boolean): void => {
    $('#ad-spin').classList.toggle('hidden', !on);
  };
  const msg = (t: string): void => {
    $('#ad-msg').textContent = t;
  };
  // "Office PC" -> "office-pc": the brain's names are small letters, digits and "-"
  const tidy = (s: string): string =>
    s
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9]/g, '-')
      .split('-')
      .filter(Boolean)
      .join('-')
      .slice(0, 31);
  const local = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
  function stop(): void {
    clearInterval(timer);
    timer = undefined;
  }
  function open(names: string[], rc?: string): void {
    stop();
    reconnect = rc ?? null;
    taken = names;
    device = '';
    localMode = false;
    joined = false;
    since = 0;
    $('#ad-h').textContent = has(rc) ? `Reconnect ${rc}` : 'Add a Computer';
    $('#ad-sub').textContent = has(rc)
      ? `Use this when ${rc} is on and awake but sends nothing: it could not find ${here()} again, or it was set up again. Run one command on it. Its sessions in the brain stay.`
      : 'Its Claude Code and Codex sessions and memory files go to your brain. You run one command on that computer; nothing else is installed by hand.';
    $('#ad-step1').textContent = has(rc) ? '1. The computer' : '1. Name the computer';
    name.value = rc ?? '';
    name.disabled = has(rc);
    os.value = 'macos';
    os.disabled = false;
    os.classList.toggle('hidden', has(rc));
    setCreate('Create Command');
    create.disabled = false;
    msg('');
    $('#ad-step2').classList.add('hidden');
    $('#ad-fw').classList.add('hidden');
    $('#ad-allow').classList.add('hidden');
    spin(false);
    state('');
    closeBtn.textContent = 'Cancel';
    openDialog('#add-device');
    if (has(rc)) void createPressed();
    else name.focus();
  }
  async function createPressed(): Promise<void> {
    const n = tidy(name.value);
    if (!n) {
      msg('Type a name for the computer: letters, digits and "-".');
      return;
    }
    name.value = n;
    if (!device && taken.includes(n)) {
      msg(`Your brain already has a computer called "${n}". Choose another name, or remove that one first.`);
      return;
    }
    msg('');
    const sys = os.value;
    create.disabled = true;
    let r: DeviceCommand;
    try {
      r =
        reconnect === null
          ? await apiQuiet<DeviceCommand>('deviceAdd', { name: n, os: sys })
          : await apiQuiet<DeviceCommand>('deviceReconnect', { name: n });
    } catch (error) {
      msg(errText(error));
      create.disabled = false;
      return;
    }
    created(r, has(r.os) ? r.os : sys);
  }
  function created(r: DeviceCommand, sys: string): void {
    device = r.device ?? '';
    localMode = r.mode === 'local';
    joined = false;
    since = Number(r.since ?? 0);
    $('#ad-cmd').textContent = r.command ?? '';
    prompt = r.prompt ?? '';
    promptBtn.classList.toggle('hidden', !prompt);
    $('#ad-where').textContent =
      sys === 'windows'
        ? `On ${device}: open PowerShell, paste the command, press Enter.`
        : `On ${device}: open Terminal, paste the command, press Enter.`;
    $('#ad-note').textContent = 'The code in it works once, for 15 minutes.';
    $('#ad-step2').classList.remove('hidden');
    const cause = r.firewall?.cause;
    $('#ad-fw').textContent = has(cause)
      ? `Before you run it: ${cause} Allow it here, or the command gets no answer.`
      : '';
    $('#ad-fw').classList.toggle('hidden', !has(cause));
    // the fix runs on the server's screen: only offered to a page opened on that computer
    $('#ad-allow').classList.toggle('hidden', !has(cause) || !local);
    name.disabled = true;
    os.disabled = true;
    setCreate('New Code');
    create.disabled = false;
    spin(true);
    state(reconnect === null ? `Waiting for ${device} to join…` : `Waiting for ${device} to run the command…`);
    stop();
    started = Date.now();
    timer = setInterval(() => void poll(), 2000);
  }
  async function poll(): Promise<void> {
    if (!device) return;
    if (!joined && Date.now() - started > CODE_MS) {
      stop();
      spin(false);
      state('The code has expired. Choose New Code to get a new command.');
      return;
    }
    const n = device;
    let r: DeviceStatus;
    try {
      r = await apiQuiet<DeviceStatus>('deviceStatus', { name: n });
    } catch {
      return;
    }
    if (device !== n || r.joined !== true) return;
    if (reconnect !== null) {
      // it was joined all the time: wait for the new join, then for data after it
      if (r.waiting === true) return;
      if (!(Number(r.lastSeen ?? 0) > since)) {
        state(`${n} ran the command. It is sending its sessions…`);
        return;
      }
    }
    if (!joined) {
      joined = true;
      closeBtn.textContent = 'Done';
      create.disabled = true;
      changed();
    }
    const k = Number(r.sessions ?? 0);
    if (r.pushed === true) {
      stop();
      spin(false);
      state(`${n} is connected: the brain has ${plural(k, 'session')} from it.`);
      changed();
    } else state(`${n} joined. It is sending its sessions…`);
  }
  function changed(): void {
    void loadDevices();
    void runQuery();
  }
  function close(): void {
    stop();
    // cancelled before the computer joined: take it off the list, so its code stops working
    if (reconnect === null && localMode && device && !joined)
      apiQuiet('deviceRemove', { name: device }).catch(() => undefined);
    closeDialog('#add-device');
    changed();
  }
  create.addEventListener('click', () => void createPressed());
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      void createPressed();
    }
  });
  promptBtn.addEventListener('click', () => {
    void copyText(prompt).then(() => {
      within(promptBtn, 'span').textContent = 'Copied';
      setTimeout(() => {
        within(promptBtn, 'span').textContent = 'Copy Prompt for Claude Code';
      }, 1500);
    });
  });
  copyBtn.addEventListener('click', () => {
    void copyText($('#ad-cmd').textContent).then(() => {
      within(copyBtn, 'span').textContent = 'Copied';
      setTimeout(() => {
        within(copyBtn, 'span').textContent = 'Copy Command';
      }, 1500);
    });
  });
  $('#ad-allow').addEventListener('click', () => {
    apiQuiet('setupFix', { id: 'firewall-allow' })
      .then(() => {
        $('#ad-fw').textContent =
          'macOS asks for your Mac password once. After that, run the command on the other computer.';
      })
      .catch((error: unknown) => {
        $('#ad-fw').textContent = errText(error);
      });
  });
  closeBtn.addEventListener('click', close);
  return { open, close };
})();

// ---------- session page (SessionDetailViewController.swift) ----------
function cur(): Session | undefined {
  return sessions.find((s) => s.id === selected);
}
const chatFrame = $as('#chat', HTMLIFrameElement);
const msgBox = $as('#msg', HTMLTextAreaElement);
const nameEdit = $as('#d-name-edit', HTMLInputElement);
// Chat | Terminal, remembered (detail.mode in the app); Chat is the default
let mode: 'chat' | 'terminal' = stored('ccp.mode') === 'terminal' ? 'terminal' : 'chat';
let chatWin: string | null = null; // the session the chat frame shows
let inlineRename = false; // the name in the header is being edited
// the view shown: a helper computer's session is always Chat (no terminal through the relay)
// (one rule with detailView: the session's device; its id before the state lists it)
const shownMode = (): 'chat' | 'terminal' => (isRemote(cur() ?? { device: helperOf(selected ?? '') }) ? 'chat' : mode);
function openChat(id: string | null): void {
  if (shownMode() !== 'chat' || !has(id)) return;
  const q = lookQuery();
  const want = `/chat.html?win=${encodeURIComponent(id)}${q ? '&' + q : ''}`;
  if (chatWin === want) return;
  chatWin = want;
  chatFrame.src = want;
}
// the chat frame asks for a toast (a file Claude sent on a helper computer: chat.ts)
addEventListener('message', (e: MessageEvent<unknown>) => {
  if (e.origin !== location.origin || e.source !== chatFrame.contentWindow) return;
  const d = e.data as { type?: unknown; text?: unknown } | null;
  if (d?.type === 'toast' && typeof d.text === 'string') toast(d.text.slice(0, 200));
});
function pollChat(): void {
  try {
    chatFrame.contentWindow?.pollNow?.();
  } catch {
    /* another origin */
  }
}
function focusMain(): void {
  if (page.name !== 'session' || anyDialog() !== undefined) return;
  if (shownMode() === 'chat') {
    if (!$('#composer').classList.contains('hidden')) msgBox.focus();
  } else term.focus();
}
function applyMode(focus: boolean): void {
  const chat = shownMode() === 'chat';
  for (const b of document.querySelectorAll<HTMLElement>('#d-mode [data-mode]')) {
    const on = b.dataset['mode'] === shownMode();
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
    b.setAttribute('role', 'radio');
  }
  chatFrame.classList.toggle('hidden', !chat);
  $('#term-wrap').classList.toggle('chat-mode', chat);
  if (chat) openChat(selected);
  renderDetail();
  if (!chat) requestAnimationFrame(refit);
  if (focus) setTimeout(focusMain, 30);
}
for (const b of document.querySelectorAll<HTMLElement>('#d-mode [data-mode]')) {
  b.addEventListener('click', () => {
    mode = b.dataset['mode'] === 'terminal' ? 'terminal' : 'chat';
    store('ccp.mode', mode);
    applyMode(true);
  });
}

function renderDetail(): void {
  const s = cur();
  if (!s) return;
  const who = agentName(s);
  $('#d-dot').className = `dot ${stateClass(s.state)}`;
  if (!inlineRename) $('#d-name').textContent = s.name;
  $('#d-title').textContent = s.title ?? '';
  $('#d-agent').classList.toggle('hidden', agentOf(s) !== 'codex');
  msgBox.placeholder = `Message ${who}…  (paste or drop images and files)`;
  const pill = $('#d-state');
  pill.className = `pill ${stateClass(s.state)}`;
  pill.textContent = label(s);
  const v = detailView(s, mode);
  if (v.chatOnly && chatFrame.classList.contains('hidden')) {
    applyMode(false); // calls renderDetail again with the chat shown
    return;
  }
  $('#d-path').textContent = placeText(s, short) + (has(s.branch) ? `  ·  ⎇ ${s.branch}` : '');
  $('#d-path').title = s.folder;
  // a helper computer's session: Chat only; its folder is on that computer (no Finder, VS Code)
  $('#d-mode').classList.toggle('hidden', v.chatOnly);
  for (const sel of ['#a-finder', '#a-code']) $(sel).classList.toggle('hidden', !v.localOnly);
  $('#a-close').classList.toggle('hidden', !v.close); // a helper's session closes on the helper
  $('#d-edit').classList.toggle('hidden', !v.rename);
  $('#a-start').classList.toggle('hidden', !v.start);
  $('#a-start span').textContent = has(s.sid) ? 'Resume' : 'Start';
  $('#a-stop').classList.toggle('hidden', !v.stop);
  $('#a-fetch').classList.toggle('hidden', !canFetch(s));
  $('#a-fetch span').textContent = isFetching(s) ? 'Cancel Fetch' : 'Fetch Result';
  renderChoices(s, who, v.choices);
  renderNotice(s, who);
  // the composer only in Chat mode and only while the agent runs (not for a helper that does not answer)
  const composer = $('#composer');
  const wasHidden = composer.classList.contains('hidden');
  composer.classList.toggle('hidden', !v.composer);
  if (wasHidden !== composer.classList.contains('hidden')) requestAnimationFrame(refit);
}
// choice bar: Claude's menu as buttons, at the end of the chat (Chat mode only)
function renderChoices(s: Session, who: string, show: boolean): void {
  const ch = $('#choice');
  const opts = s.options ?? [];
  const key = s.state === 'needs' ? opts.map((o) => o.label).join('|') : '';
  ch.classList.toggle('hidden', !key || !show);
  if (key === ch.dataset['key']) return;
  ch.dataset['key'] = key;
  $('#choice-q').textContent = has(s.question) ? s.question : `${who} needs your decision`;
  const box = $('#choice-opts');
  box.innerHTML = '';
  if (!key) return;
  for (const o of opts) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small' + (/^yes/i.test(o.label) ? ' yes' : '');
    b.textContent = `${String(o.n)}.  ${o.label}`;
    b.title = o.label;
    b.dataset['testid'] = `detail.choice.${String(o.n)}`;
    b.addEventListener('click', () => {
      b.disabled = true;
      api('choose', { id: s.id, n: o.n })
        .catch(() => {
          /* toast shown */
        })
        .finally(() => {
          b.disabled = false;
          pollChat();
          focusMain();
        });
    });
    box.append(b);
  }
}
function renderNotice(s: Session, who: string): void {
  const nt = $('#notice');
  let text = '';
  if (isOffline(s) && has(s.device)) {
    // the last state the helper sent: this notice only
    nt.textContent = offlineNotice(s.device);
    nt.classList.remove('hidden');
    return;
  }
  if (isPending(s)) text = pendingNotice(s);
  else if (s.state === 'elsewhere')
    text =
      'This conversation is open in another window (VS Code or a terminal). Click Resume to move it here: the other copy is closed and the conversation continues in the panel. A message sent here does the same.';
  else if (s.state === 'stopped')
    text = has(s.sid)
      ? `${who} is not running here. Click Resume to continue this conversation.`
      : `${who} is not running here. Click Start.`;
  // a helper session's recent "Fetch result" above the state notice (Models.swift FetchInfo)
  if (has(s.device) && s.fetch) text = fetchText(s.fetch, s.device) + (text ? `\n${text}` : '');
  nt.textContent = text;
  nt.classList.toggle('hidden', !text);
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
  detach();
  if (!opened) {
    term.open($('#term'));
    opened = true;
  }
  term.reset();
  fit.fit();
  const ws = new WebSocket(
    `${wsBase()}/ws/term?win=${encodeURIComponent(id)}&cols=${String(term.cols)}&rows=${String(term.rows)}`,
  );
  ws.addEventListener('message', (e: MessageEvent<unknown>) => {
    term.write(typeof e.data === 'string' ? e.data : '');
  });
  ws.onclose = () => {
    if (selected === id && termWs === ws)
      setTimeout(() => {
        if (selected === id) attach(id);
      }, 1000);
  };
  termWs = ws;
  setTimeout(focusMain, 50);
}
function detach(): void {
  if (!termWs) return;
  termWs.onclose = null;
  termWs.close();
  termWs = null;
}
term.onData((d) => {
  if (termWs?.readyState === WebSocket.OPEN) termWs.send(d);
});
function refit(): void {
  if (!opened || $('#detail').classList.contains('hidden')) return;
  fit.fit();
  if (termWs?.readyState === WebSocket.OPEN) termWs.send(`\u0000resize:${String(term.cols)},${String(term.rows)}`);
}
let refitTimer: ReturnType<typeof setTimeout> | undefined;
new ResizeObserver(() => {
  clearTimeout(refitTimer);
  refitTimer = setTimeout(refit, 60);
}).observe($('#term-wrap'));

// ---------- pages and routing (MainWindow.swift Page): #/home #/sessions #/devices #/session/<id> ----------
// go: change the page; the hash keeps reload, Back and Forward working
function go(name: PageName, id?: string, replace = false): void {
  const p: Page = name === 'session' ? (has(id) ? { name, id } : { name: 'sessions' }) : { name };
  const h = hashFor(p);
  if (location.hash !== h) {
    if (replace) history.replaceState(null, '', h);
    else history.pushState(null, '', h);
  }
  show(parseHash(location.hash));
}
function show(p: Page): void {
  const newSel = p.name === 'session' ? p.id : null;
  const same = p.name === page.name && newSel === (page.name === 'session' ? page.id : null);
  page = p;
  savePage(p);
  for (const n of PAGES) $(`#page-${n}`).classList.toggle('hidden', p.name !== n);
  $('#detail').classList.toggle('hidden', p.name !== 'session');
  document.body.classList.remove('side-open'); // narrow window: the overlay closes after a choice
  $('#scrim').classList.add('hidden');
  if (newSel !== selected || !same) {
    selected = newSel;
    if (inlineRename) {
      inlineRename = false;
      nameEdit.classList.add('hidden');
      $('#d-name').classList.remove('hidden');
    }
    if (newSel === null) detach();
    else {
      $('#choice').dataset['key'] = '-'; // a new session: build the choice bar again
      detailComposer.setDraftKey(Restore.openKey(newSel, sessions.find((s) => s.id === newSel)?.sid, savedPage()));
      applyMode(false);
      // a helper computer's session has no terminal on this Mac: only Chat
      if (helperOf(newSel) === '')
        requestAnimationFrame(() => {
          attach(newSel);
        });
      else detach();
    }
  }
  if (p.name === 'devices') devicesShown(); // the app reloads the devices each time the page shows, the query once
  if (p.name === 'home' && anyDialog() === undefined) {
    ask.focus(); // viewDidAppear: the Ask box has focus
    jumpIfSent();
  }
  markSelection();
}
addEventListener('popstate', () => {
  show(parseHash(location.hash));
});
addEventListener('hashchange', () => {
  show(parseHash(location.hash));
});

// ---------- session actions ----------
$('#a-start').addEventListener('click', () => {
  const s = cur();
  if (!s) return;
  void (async () => {
    if (s.state === 'elsewhere') {
      const i = await alertBox(
        'Move this conversation here?',
        'It is open in another window. That copy will be closed (its history is kept) and the conversation continues in the panel.',
        [{ label: 'Move Here', cls: 'primary' }, { label: 'Cancel' }],
      );
      if (i !== 0) return;
    }
    await api('start', { id: s.id }).catch(() => undefined);
  })();
});
$('#a-stop').addEventListener(
  'click',
  run(async () => {
    if (cur()) await api('interrupt', { id: selected });
  }),
);
$('#a-finder').addEventListener(
  'click',
  run(async () => {
    const s = cur();
    if (s) await api('reveal', { folder: s.folder });
  }),
);
$('#a-code').addEventListener(
  'click',
  run(async () => {
    const s = cur();
    if (s) await api('reveal', { folder: s.folder, app: 'code' });
  }),
);
$('#a-fetch').addEventListener(
  'click',
  run(async () => {
    const s = cur();
    if (s) await fetchResult(s);
  }),
);
$('#a-close').addEventListener('click', () => void closeSession(cur()));
// Close at once, with no confirmation: the conversation is saved and can be resumed (SessionMenu.close)
async function closeSession(s: Session | undefined): Promise<void> {
  if (!s) return;
  try {
    await api('close', { id: s.id });
  } catch {
    return;
  }
  if (selected === s.id) go('sessions');
}

// inline rename in the header: double-click the name or click the pencil; Enter or leaving saves, Esc restores
function startInlineRename(): void {
  const s = cur();
  if (!s || inlineRename || isPending(s)) return; // a row still preparing cannot be renamed
  inlineRename = true;
  nameEdit.value = s.name;
  $('#d-name').classList.add('hidden');
  nameEdit.classList.remove('hidden');
  nameEdit.focus();
  nameEdit.select();
}
function endInlineRename(save: boolean): void {
  if (!inlineRename) return;
  inlineRename = false;
  const s = cur(),
    n = nameEdit.value.trim(),
    shown = $('#d-name');
  nameEdit.classList.add('hidden');
  shown.classList.remove('hidden');
  if (s && save && n && n !== s.name) {
    shown.textContent = n;
    api('rename', { id: s.id, name: n })
      .then(() => {
        toast(`Renamed to “${n}”`);
      })
      .catch(() => {
        shown.textContent = s.name;
      });
  } else if (s) shown.textContent = s.name;
  focusMain();
}
$('#d-name').addEventListener('dblclick', startInlineRename);
$('#d-edit').addEventListener('click', startInlineRename);
nameEdit.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    endInlineRename(true);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    endInlineRename(false);
  }
});
nameEdit.addEventListener('blur', () => {
  endInlineRename(true);
});
$('#d-name').addEventListener('contextmenu', (e) => {
  const s = cur();
  if (!s) return;
  e.preventDefault();
  showMenu(e.clientX, e.clientY, s);
});

// Rename Session dialog (MainWindow.swift rename), from the context menu
let renaming: Session | null = null;
const renameInput = $as('#rename-input', HTMLInputElement);
function rename(s: Session): void {
  renaming = s;
  renameInput.value = s.name;
  openDialog('#rename');
  renameInput.focus();
  renameInput.select();
}
$('#rename .rename-card').addEventListener('submit', (e) => {
  e.preventDefault();
  const s = renaming,
    name = renameInput.value.trim();
  closeDialog('#rename');
  if (!s || !name || name === s.name) return;
  api('rename', { id: s.id, name })
    .then(() => {
      s.name = name;
      stateKey = '';
      render();
    })
    .catch(() => {
      /* toast shown */
    });
});

// composer of the Session page: the same box as the Ask box, a draft per session
const detailComposer = makeComposer({
  box: $as('#composer', HTMLFormElement),
  text: msgBox,
  chips: $('#msg-chips'),
  file: $as('#msg-file', HTMLInputElement),
  attach: $('#msg-attach'),
  min: 36,
  max: 140,
  draft: null,
  onSend: (t, att) => {
    const id = selected;
    if (id === null) return;
    // the chat page shows the sent message at once (it is in the transcript only after the prompt hooks)
    api('send', { id, text: t, attachments: att })
      .then(pollChat)
      .catch(() => {
        /* toast shown */
      });
  },
});

// ---------- context menu (SessionMenu: same labels and order) ----------
type MenuItem = readonly [string, (() => void) | null]; // null: shown greyed, does nothing
function showMenu(x: number, y: number, s: Session): void {
  // a new session on a helper, not started: closing it cancels it there and removes its folder
  if (isPending(s)) {
    menuAt(x, y, [
      [
        'Open',
        () => {
          go('session', s.id);
        },
      ],
      [pendingMenuLabel(s.state), () => void closeSession(s)],
    ]);
    return;
  }
  menuAt(x, y, [
    [
      'Open',
      () => {
        go('session', s.id);
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
    ...(canFetch(s)
      ? (['-', [isFetching(s) ? 'Cancel Fetch' : 'Fetch Result', run(() => fetchResult(s))]] as (MenuItem | '-')[])
      : []),
    // a helper computer's session (lib/peer.ts): its folder is on that computer; it closes there
    ...(has(s.device)
      ? isOffline(s)
        ? []
        : (['-', ['Close Session', () => void closeSession(s)]] as (MenuItem | '-')[])
      : ([
          '-',
          ['New Session in This Folder', run(() => openNew(s.folder))],
          ['Show in Finder', run(() => api('reveal', { folder: s.folder }))],
          ['Open in VS Code', run(() => api('reveal', { folder: s.folder, app: 'code' }))],
          '-',
          ['Close Session', () => void closeSession(s)],
        ] as (MenuItem | '-')[])),
  ]);
}
// a context menu at x, y: items are [label, fn], '-' (a separator) or false (left out)
function menuAt(x: number, y: number, list: (MenuItem | '-' | false)[]): void {
  const m = $('#menu');
  m.innerHTML = '';
  for (const it of list) {
    if (it === false) continue;
    if (it === '-') {
      const hr = document.createElement('hr');
      hr.className = 'sep';
      m.append(hr);
      continue;
    }
    const [text, fn] = it;
    const b = document.createElement('button');
    b.textContent = text;
    b.setAttribute('role', 'menuitem');
    if (fn === null) b.disabled = true;
    b.addEventListener('click', () => {
      hideMenu();
      fn?.();
    });
    m.append(b);
  }
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = `${String(Math.max(4, Math.min(x, innerWidth - r.width - 8)))}px`;
  m.style.top = `${String(Math.max(4, Math.min(y, innerHeight - r.height - 8)))}px`;
}
function hideMenu(): void {
  $('#menu').classList.add('hidden');
}
document.addEventListener('click', (e) => {
  if (!(e.target instanceof Node && $('#menu').contains(e.target))) hideMenu();
});
addEventListener('blur', hideMenu);

// ---------- dialogs ----------
function openDialog(sel: string): void {
  $(sel).classList.remove('hidden');
}
function closeDialog(sel: string): void {
  $(sel).classList.add('hidden');
}
for (const d of document.querySelectorAll<HTMLElement>('#settings, #rename, #route-failed')) {
  d.addEventListener('click', (e) => {
    if (e.target === d || (e.target instanceof Element && e.target.closest('[data-close]'))) closeDialog(`#${d.id}`);
  });
}

// Settings: the look (SettingsWindow.swift)
function openSettings(): void {
  for (const c of document.querySelectorAll<HTMLElement>('.look-card'))
    c.classList.toggle('on', c.dataset['look'] === look());
  openDialog('#settings');
}
for (const c of document.querySelectorAll<HTMLElement>('.look-card'))
  c.addEventListener('click', () => {
    setLook(c.dataset['look'] ?? 'original');
  });
$('#btn-settings').addEventListener('click', openSettings);
// ---------- New Session dialog (NewSessionController.swift) ----------
let modalRoute: string | null = null;
const mFolder = $as('#m-folder', HTMLInputElement);
const mRecent = $as('#m-recent', HTMLSelectElement);
const savedAgent = (): string => (stored('ccp.agent') === 'codex' ? 'codex' : 'claude');
// agent for "Start New Conversation": remembered (newSession.agent in the app); Codex is off when the server says it is not available
let newAgent = savedAgent();
function setAgent(a: string, save = true): void {
  newAgent = a;
  if (save) store('ccp.agent', a);
  for (const b of document.querySelectorAll<HTMLElement>('#m-agent [data-agent]')) {
    const on = b.dataset['agent'] === a;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
}
for (const b of document.querySelectorAll<HTMLElement>('#m-agent [data-agent]'))
  b.addEventListener('click', () => {
    setAgent(b.dataset['agent'] ?? 'claude');
  });
async function loadAgents(): Promise<void> {
  const list = await getJson('/api/agents');
  const codex = Array.isArray(list) ? (list as Agent[]).find((a) => a.id === 'codex') : undefined;
  const ok = codex?.available === true;
  let reason = list === null ? 'This server cannot start Codex.' : 'Codex is not available.';
  if (has(codex?.reason)) reason = codex.reason;
  const btn = $as('#m-agent [data-agent="codex"]', HTMLButtonElement);
  btn.disabled = !ok;
  btn.title = ok ? 'Start the Codex CLI in this folder' : reason;
  const note = $('#m-agent-note');
  note.textContent = ok ? '' : `Codex: ${reason}`;
  note.classList.toggle('hidden', ok);
  // Codex off: use Claude Code now, but keep the saved choice for later
  if (!ok && newAgent === 'codex') setAgent('claude', false);
}
setAgent(newAgent, false);
let histSel: HistoryEntry | null = null; // the selected row's history item
let histSeq = 0;
// "Computer:" (NewSessionController): where a new conversation starts; one request id per dialog
const mComputer = $as('#m-computer', HTMLSelectElement);
let newRequestId = '';
let computersSeq = 0;
async function loadComputers(): Promise<void> {
  const seq = ++computersSeq; // only the newest load fills the list (a reopened dialog)
  const here = serverPlatform && serverPlatform !== 'darwin' ? 'This computer' : 'This Mac';
  const fill = (list: { device: string; online: boolean }[]): void => {
    mComputer.innerHTML = '';
    for (const c of computerOptions(here, list)) {
      const o = document.createElement('option');
      o.value = c.value;
      o.textContent = c.label;
      o.disabled = c.disabled;
      mComputer.append(o);
    }
    mComputer.value = '';
  };
  fill([]);
  const r = (await getJson('/api/peers')) as { peers?: { device: string; online: boolean }[] } | null;
  if (seq !== computersSeq || $('#modal').classList.contains('hidden')) return;
  fill(Array.isArray(r?.peers) ? r.peers : []);
  void loadHistory(); // the list starts at this Mac again: the history matches it
}
mComputer.addEventListener('change', () => void loadHistory());
async function openNew(folder?: string, routeId?: string): Promise<void> {
  modalRoute = routeId ?? null;
  $('#m-title').textContent = modalRoute === null ? 'New Session' : 'Send Request to a New Session';
  // a request the router already holds goes to this Mac's sessions
  $('#m-computer-wrap').classList.toggle('hidden', modalRoute !== null);
  newRequestId = randomHex(8);
  void loadComputers();
  // "Choose…" opens a macOS folder dialog on the server's screen: only when the server runs on macOS
  $('#m-browse').classList.toggle('hidden', !canChooseFolder(serverPlatform));
  $('#modal').classList.remove('hidden');
  setAgent(savedAgent(), false);
  void loadAgents();
  mFolder.value = folder ?? '';
  void loadHistory();
  mFolder.focus();
  mRecent.innerHTML = '<option value="">Recent folders…</option>';
  const rec = await getJson('/api/folders');
  for (const r of (Array.isArray(rec) ? (rec as { folder: string }[]) : []).slice(0, 25)) {
    const o = document.createElement('option');
    o.value = r.folder;
    o.textContent = short(r.folder);
    o.title = r.folder;
    mRecent.append(o);
  }
  mRecent.value = '';
}
function closeModal(): void {
  $('#modal').classList.add('hidden');
}
$('#modal').addEventListener('click', (e) => {
  if (e.target instanceof Element && e.target.id === 'modal') closeModal();
});
$('#m-cancel').addEventListener('click', closeModal);
mRecent.addEventListener('change', () => {
  const f = mRecent.value;
  if (f) {
    mFolder.value = f;
    void loadHistory();
  }
});

async function loadHistory(): Promise<void> {
  const folder = mFolder.value.trim();
  const box = $('#m-history');
  histSel = null;
  const empty = (t: string): void => {
    box.innerHTML = `<div class="hist-empty">${esc(t)}</div>`;
  };
  if (!folder) {
    empty('Choose a folder first.');
    return;
  }
  if (mComputer.value !== '') {
    histSeq++; // a history request on the way is not shown
    empty(helperHistoryText(mComputer.value));
    return;
  }
  empty('Loading…');
  const seq = ++histSeq;
  const list = await getJson('/api/history?folder=' + encodeURIComponent(folder));
  if (seq !== histSeq) return; // a newer folder was chosen meanwhile
  if (!Array.isArray(list) || list.length === 0) {
    empty('No previous conversations in this folder.');
    return;
  }
  const open = new Set(sessions.map((s) => s.sid));
  box.innerHTML = '';
  for (const [i, h] of (list as HistoryEntry[]).entries()) box.append(historyRow(box, h, i, open.has(h.sid)));
}
function historyRow(box: HTMLElement, h: HistoryEntry, i: number, isOpen: boolean): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'hist' + (i % 2 === 1 ? ' alt' : '');
  row.setAttribute('role', 'row');
  row.tabIndex = -1;
  const when = new Date(h.mtime).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const title = (has(h.title) ? h.title : (h.first ?? '')).slice(0, 120) + (isOpen ? '   (open in panel)' : '');
  row.innerHTML =
    `<div class="hist-c" role="gridcell"><div class="hist-t"><span class="pill agent">${agentOf(h) === 'codex' ? 'Codex' : 'Claude Code'}</span><span class="ht">${esc(title)}</span></div>` +
    `<div class="hist-s">${esc(h.first)}</div></div><div class="hist-w" role="gridcell">${esc(when)}</div>`;
  row.addEventListener('click', () => {
    for (const r of box.querySelectorAll('.hist.sel')) r.classList.remove('sel');
    row.classList.add('sel');
    histSel = h;
  });
  row.addEventListener('dblclick', () => {
    histSel = h;
    continueSelected();
  });
  return row;
}
function continueSelected(): void {
  const h = histSel;
  if (!h) {
    toast('Select a conversation first');
    return;
  }
  const existing = sessions.find((s) => s.sid === h.sid);
  if (existing) {
    closeModal();
    go('session', existing.id);
    return;
  }
  void create(mFolder.value.trim(), h.sid, agentOf(h));
}
$('#m-continue').addEventListener('click', continueSelected);
mFolder.addEventListener('change', () => void loadHistory());
mFolder.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    void loadHistory();
  }
});
$('#m-browse').addEventListener(
  'click',
  run(async () => {
    const { folder } = await api('pickFolder');
    if (has(folder)) {
      mFolder.value = folder;
      await loadHistory();
    }
  }),
);
$('#m-fresh').addEventListener('click', () => {
  const folder = mFolder.value.trim();
  if (!folder) {
    toast('Choose a folder first');
    return;
  }
  void create(folder, '');
});
async function create(folder: string, sid: string, agent?: string): Promise<void> {
  const chosen = agent ?? newAgent;
  const rid = modalRoute;
  const computer = mComputer.value,
    requestId = newRequestId;
  closeModal();
  try {
    if (rid !== null && !sid) {
      const { id } = await api('routeTo', { routeId: rid, folder, agent: chosen });
      if (has(id)) go('session', id);
      return;
    }
    const device = rid === null ? computer : '';
    const { id } = await api('new', newBody(folder, sid, chosen, device, requestId));
    // a helper: the server answers at once with the preparing row; it becomes the session there
    if (has(id) && device !== '' && !sid) go('session', id);
    else if (has(id))
      setTimeout(() => {
        go('session', id);
      }, 500);
  } catch {
    /* toast shown */
  }
}

// ---------- sidebar: '+', width, hide ----------
$('#btn-new').addEventListener(
  'click',
  run(() => openNew()),
);
const narrow = matchMedia('(max-width: 899px)');
function toggleSidebar(): void {
  if (narrow.matches) {
    const open = !document.body.classList.contains('side-open');
    document.body.classList.toggle('side-open', open);
    $('#scrim').classList.toggle('hidden', !open);
  } else {
    const hide = !document.body.classList.contains('side-hidden');
    document.body.classList.toggle('side-hidden', hide);
    store('thoth.sideHidden', hide ? '1' : null);
  }
}
$('#btn-sidebar').addEventListener('click', toggleSidebar);
$('#scrim').addEventListener('click', toggleSidebar);
if (stored('thoth.sideHidden') === '1') document.body.classList.add('side-hidden');
const clampW = (w: number): number => Math.max(230, Math.min(340, Math.round(w)));
{
  const sidebar = $('#sidebar');
  const w = Number(stored('thoth.sideW'));
  if (w > 0) sidebar.style.setProperty('--w', `${String(clampW(w))}px`);
  const grip = $('#side-grip');
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const left = sidebar.getBoundingClientRect().left;
    const move = (ev: PointerEvent): void => {
      sidebar.style.setProperty('--w', `${String(clampW(ev.clientX - left))}px`);
    };
    const up = (ev: PointerEvent): void => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      store('thoth.sideW', String(clampW(ev.clientX - left)));
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
}

// ---------- keyboard (main.swift menu keys) ----------
// mod = Cmd on macOS, Ctrl elsewhere. A browser tab keeps some keys (Cmd/Ctrl+N, W, often L and 1-9),
// so Alt+the same key also works outside text fields. All keys work when the page runs as an installed app.
function editable(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}
function inTerminal(t: EventTarget | null): boolean {
  return t instanceof Element && t.closest('#term') !== null;
}
const DIALOGS = ['#alert', '#add-device', '#modal', '#settings', '#rename', '#route-failed'];
function anyDialog(): string | undefined {
  return DIALOGS.find((s) => !$(s).classList.contains('hidden'));
}
function closeTopDialog(d: string): void {
  if (d === '#modal') closeModal();
  else if (d === '#alert') alertDone?.(-1);
  else if (d === '#add-device') addDev.close();
  else closeDialog(d);
}
// the action of a menu key, or null
function keyAction(e: KeyboardEvent, code: string, viaMod: boolean): (() => void) | null {
  // Linux and Windows: Ctrl+letter belongs to the terminal (Ctrl+E, Ctrl+L, Ctrl+N …) while it has focus
  const letterOk = !(viaMod && !isMac && inTerminal(e.target));
  const digit = /^Digit(\d)$/.exec(code);
  if (digit && !e.shiftKey) {
    const i = Number(digit[1]);
    if (i === 0)
      return () => {
        go('home');
      };
    const s = sessions[i - 1]; // server order, as in the app
    return s
      ? () => {
          go('session', s.id);
        }
      : null;
  }
  if (code === 'Comma' && !e.shiftKey) return openSettings;
  if (!letterOk) return null;
  if (code === 'KeyN')
    return e.shiftKey
      ? run(() => openNew())
      : () => {
          go('home');
        };
  if (code === 'KeyL' && !e.shiftKey)
    return () => {
      go('sessions');
    };
  if (code === 'KeyE' && !e.shiftKey)
    return () => {
      go('devices');
    };
  return null;
}
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape') {
      if (!$('#menu').classList.contains('hidden')) {
        hideMenu();
        e.preventDefault();
        return;
      }
      const d = anyDialog();
      if (d !== undefined) {
        closeTopDialog(d);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (document.body.classList.contains('side-open')) {
        toggleSidebar();
        return;
      }
      // Stop (Esc): the session menu's key, as in the app
      const openId = page.name === 'session' ? page.id : null;
      const s = sessions.find((x) => x.id === openId);
      const stops = escapeStops({
        page: page.name,
        state: s?.state ?? '',
        inTerminal: inTerminal(e.target),
        editable: editable(e.target),
        repeat: e.repeat,
        sent: s !== undefined && stopSent.has(s.id),
      });
      if (s && stops) {
        e.preventDefault();
        stopSent.add(s.id);
        void api('interrupt', { id: s.id }).catch(() => undefined);
      }
      return;
    }
    const code = e.code;
    // Toggle Sidebar: Ctrl+Cmd+S (macOS), Ctrl+Alt+S elsewhere
    if (code === 'KeyS' && e.ctrlKey && !e.shiftKey && (isMac ? e.metaKey && !e.altKey : e.altKey && !e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      toggleSidebar();
      return;
    }
    const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    const viaMod = mod && !e.altKey;
    const viaAlt = e.altKey && !e.metaKey && !e.ctrlKey && !editable(e.target);
    if (!viaMod && !viaAlt) return;
    const act = keyAction(e, code, viaMod);
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    hideMenu();
    act();
  },
  true,
);

// refresh the "ago" labels in place: a rebuild would drop focus and clicks
setInterval(() => {
  for (const el of document.querySelectorAll<HTMLElement>('#rows .row')) {
    const s = sessions.find((x) => x.id === el.dataset['id']);
    const tm = el.querySelector('.tm');
    if (s && tm && s.state !== 'needs') tm.textContent = ago(s.activity);
  }
}, 30_000);

// start: the page in the hash (a reload), else the page shown last (the app's LastPage), else Home
if (!HASH_RE.test(location.hash)) history.replaceState(null, '', hashFor(Restore.startPage(savedPage())));
restoreWait = { pending: parseHash(location.hash).name === 'session', until: null };
show(parseHash(location.hash));
render();
connectState();

export {};
