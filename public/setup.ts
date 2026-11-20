// The setup page (setup.html): five steps (devices, connect, brain, keep it on, move sessions in),
// then the manage view. Talks to /api/setup* (server.ts, lib/setup.ts).

// ---------- the answers of /api/setup* ----------
interface Commands {
  posix: string;
  windows: string;
}
interface Device {
  name: string;
  os: string;
  self?: boolean;
  connected?: boolean;
  sessions?: number;
  lastSeen?: number;
  pairing?: { expires: number } | null;
  revoked?: boolean;
}
interface FixAction {
  id: string;
  label: string;
  note?: string;
}
interface Check {
  id?: string;
  ok: boolean;
  optional?: boolean;
  title: string;
  cause?: string;
  detail?: string;
  fix?: string;
  actions?: FixAction[];
  steps?: string[];
  perm?: boolean;
}
interface CloudDevice {
  id: string;
  name: string;
  os: string;
  host?: string;
  self?: boolean;
  joined?: boolean;
  sessions: number;
  lastSeen?: number;
  error?: string;
}
interface Push {
  ok: boolean;
  sessions?: number;
  message?: string;
}
interface Cloud {
  up: boolean;
  error?: string;
  host?: string;
  pending?: CloudDevice[];
  later?: CloudDevice[];
  approved?: CloudDevice[];
  ignored?: CloudDevice[];
  commands: Commands;
  self?: { error?: string; push?: Push | null; pushing?: boolean };
}
interface Setup {
  done: boolean;
  step: number;
  devices: Device[];
  brain?: string | null;
  cloud?: Cloud | null;
  checks: Check[];
  keepOn: { ack: boolean; check: Check };
  local: string;
  migrated?: boolean;
}
interface Code {
  device: string;
  code: string;
  expires: number;
  commands: Commands;
}
interface Pair {
  code: string;
  expires: number;
  commands: Commands;
  addresses: string[];
}
interface OutsideRow {
  sid: string;
  ok: boolean;
  name: string;
  title?: string;
  shown?: string;
  folder: string;
  kind?: string;
  status?: string;
  agent?: string;
  move?: string;
  moveText?: string;
  problem?: string;
}
interface BrainDevice {
  name: string;
  os: string;
  self?: boolean;
  error?: string;
  known?: boolean;
  connected?: boolean;
  lastSync?: number;
  sessions: number;
}
interface Outside {
  error?: string;
  brain?: { up: boolean; cloud?: boolean; error?: string; fix: string; devices: BrainDevice[] } | null;
  outside: OutsideRow[];
}
interface Problem {
  title?: string;
  error?: string;
  steps?: string[];
}
interface Move {
  state: 'moving' | 'done' | 'error';
  msg?: string;
}
interface MapNode {
  name: string;
  os: string;
  on: boolean;
}
interface Hub {
  name: string;
  os: string;
  sub: string;
}

/** An error of the server with an optional problem to show in the fix pop-up. */
class ApiError extends Error {
  problem: Problem | undefined;
  constructor(message: string, problem: Problem | undefined) {
    super(message);
    this.problem = problem;
  }
}
const errMsg = (x: unknown): string => (x instanceof Error ? x.message : String(x));

const NAMES = ['Your devices', 'Connect them', 'Your brain', 'Keep it on', 'Move sessions in'];
const CLOUD = ':cloud'; // S.brain for a cloud brain (lib/setup.ts)
const OS: Record<string, string> = { macos: 'macOS', linux: 'Linux', windows: 'Windows' };
const SLEEP_ADVICE: Record<string, string> = {
  macos:
    'On the Mac: System Settings, Energy (or Battery, Options). Turn on "Prevent automatic sleeping when the display is off", and keep it plugged in.',
  linux:
    'On the Linux computer: turn off automatic suspend in Settings, Power. Or run: sudo systemctl mask sleep.target suspend.target',
  windows: 'On the Windows PC: Settings, System, Power. Set "When plugged in, put my device to sleep after" to Never.',
};
let state: Setup | null = null; // GET /api/setup
let O: Outside | null = null; // GET /api/setupOutside (step 5)
let welcome = false; // show the welcome screen before step 1
let ADDING = false,
  CHANGING = false; // manage view (after setup): add form, brain chooser open
let PICK: string | null = null; // step 3 / manage: the brain choice on screen ('cloud' or a device name)
let CODE: Code | null = null,
  CODE_ERR = ''; // cloud: the last pre-approved code
const PAIRS: Record<string, Pair | undefined> = {},
  PAIR_ERR: Record<string, string | undefined> = {},
  MOVE: Record<string, Move | undefined> = {};
/** The setup state; the page draws only after the first answer. */
function S(): Setup {
  if (!state) throw new Error('the setup state is not loaded');
  return state;
}
const isCloud = (): boolean => state !== null && state.brain === CLOUD;
const has = (s: string | null | undefined): s is string => s !== undefined && s !== null && s !== '';
const n = (x: number): string => String(x);
const nonZero = (x: number | undefined): x is number => x !== undefined && x !== 0;

function maybe(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#${id}`);
}
function $(id: string): HTMLElement {
  const el = maybe(id);
  if (!el) throw new Error(`#${id} is missing`);
  return el;
}
function typed<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = $(id);
  if (!(el instanceof type)) throw new TypeError(`#${id} has the wrong type`);
  return el;
}
const $input = (id: string): HTMLInputElement => typed(id, HTMLInputElement);
const $button = (id: string): HTMLButtonElement => typed(id, HTMLButtonElement);
const $dialog = (id: string): HTMLDialogElement => typed(id, HTMLDialogElement);
const $details = (id: string): HTMLDetailsElement => typed(id, HTMLDetailsElement);
const $textarea = (id: string): HTMLTextAreaElement => typed(id, HTMLTextAreaElement);
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (t: string | number | null | undefined): string =>
  String(t ?? '').replaceAll(/[&<>"']/g, (c) => ESC[c] ?? c);
const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

/* ---------- icons ---------- */
const I = {
  check:
    '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5l8 14H2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 8v4M10 14.3v.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  bad: '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 5.5v5.5M10 13.8v.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  ok: '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6.5 10.3l2.3 2.3 4.7-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  info: '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 9v5M10 6.2v.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  chev: '<svg class="chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  dotOk:
    '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" style="color:var(--green);flex:none"><circle cx="9" cy="9" r="7" fill="currentColor" opacity=".16"/><path d="M5.5 9.2l2.2 2.2 4.6-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  dotOpt:
    '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" style="color:var(--muted);flex:none"><circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  dotBad:
    '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" style="color:var(--red);flex:none"><circle cx="9" cy="9" r="7" fill="currentColor" opacity=".16"/><path d="M9 5v5M9 12.6v.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};
// device glyphs in a 24x24 box
const GLYPH: Record<string, string> = {
  macos: '<rect x="4" y="5" width="16" height="11" rx="1.6"/><path d="M2 19h20"/>',
  windows: '<rect x="3" y="4" width="18" height="12" rx="1.6"/><path d="M9 20h6M12 16v4"/>',
  linux: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h3"/>',
  session: '<path d="M4 6l4 4-4 4"/><path d="M11 16h9"/>',
  cloud: '<path d="M7 18h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.4 9.2 4.5 4.5 0 0 0 7 18z"/>',
};
const svgGlyph = (kind: string, size: number): string =>
  `<svg width="${n(size)}" height="${n(size)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPH[kind] ?? GLYPH['linux'] ?? ''}</svg>`;
const glyph = (kind: string): string => svgGlyph(kind, 22);

/* ---------- helpers ---------- */
async function api<T = Setup>(path: string, body?: Record<string, unknown>): Promise<T> {
  let r: Response;
  try {
    r = await fetch(
      path,
      body === undefined
        ? { cache: 'no-store' }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
  } catch {
    throw new Error(
      'The panel server on this computer did not answer. Check that it is still running (thoth web), then try again.',
    );
  }
  const j = (await r.json().catch(() => ({}))) as { error?: string; problem?: Problem };
  if (!r.ok) throw new ApiError(j.error ?? `The server refused the request (${n(r.status)}).`, j.problem);
  return j as T;
}
async function copy(text: string, btn: HTMLElement | null): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const old = btn.innerHTML;
      btn.textContent = 'Copied';
      setTimeout(() => {
        btn.innerHTML = old;
      }, 1600);
    }
  } catch {
    $textarea('copytext').value = text;
    $dialog('copybox').showModal();
    $textarea('copytext').select();
  }
}
async function copyDiagnostics(btn: HTMLElement): Promise<void> {
  let t: string;
  try {
    const r = await fetch('/api/setupDiagnostics', { cache: 'no-store' });
    t = await r.text();
  } catch {
    t = 'The panel server did not answer, so no diagnostics could be collected.';
  }
  await copy(t, btn);
}
function ago(t: number): string {
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${n(m)} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${n(h)} h ago` : `${n(Math.round(h / 24))} days ago`;
}
const plural = (count: number, w: string): string => `${n(count)} ${w}${count === 1 ? '' : 's'}`;
function thisComputer(): Device {
  const me = S().devices.find((d) => d.self === true);
  if (!me) throw new Error('this computer is not in the device list');
  return me;
}
const others = (): Device[] => S().devices.filter((d) => d.self !== true);
function errBox(msg: string, title = 'That did not work'): string {
  return `<div class="note bad" role="alert">${I.bad}<div><p class="t">${esc(title)}</p><p>${esc(msg)}</p>
    <div class="acts"><button class="linkbtn" data-diag>Copy diagnostics</button><span class="small muted">Paste them when you ask for help.</span></div></div></div>`;
}
// a fix from lib/setup.ts is prose, a command, or "prose: command   (note)"; show commands as copyable blocks
const CMD = /^(?:brew|sudo|curl|python3|thoth|npm|node|scripts\/|winget)\b/;
function fixBlock(fix: string | undefined): string {
  let text = (fix ?? '').trim(),
    note = '';
  const par = /^(.*?)\s+\(([^()]*)\)$/.exec(text);
  if (par) {
    text = par[1] ?? '';
    note = par[2] ?? '';
  }
  let prose = '',
    cmd = '';
  if (CMD.test(text)) cmd = text;
  else {
    const m = /^(.*?:)\s+(\S.*)$/.exec(text);
    if (m && CMD.test(m[2] ?? '')) {
      prose = m[1] ?? '';
      cmd = m[2] ?? '';
    } else prose = text + (note ? ` (${note})` : '');
  }
  if (!cmd) return `<p class="fixp">${esc(prose)}</p>`;
  return `${prose ? `<p class="fixp">${esc(prose)}</p>` : ''}${cmdBlock(cmd)}${note ? `<p class="fixp small muted">${esc(note.charAt(0).toUpperCase() + note.slice(1))}.</p>` : ''}`;
}
const cmdBlock = (cmd: string): string =>
  `<div class="cmd"><span>${esc(cmd)}</span><button class="btn small" data-copy="${esc(cmd)}">Copy</button></div>`;

/* ---------- device map: the hub (brain or this computer) and the others below it ---------- */
function deviceMap(hub: Hub, around: MapNode[]): string {
  const W = 440,
    cx = W / 2,
    cy = 38,
    count = around.length,
    H = count ? 186 : 80;
  const pts = around.map((d, i) => ({ d, x: count === 1 ? cx : 46 + i * ((W - 92) / (count - 1)), y: 128 }));
  const edges = pts
    .map(
      (p) =>
        `<path class="edge ${p.d.on ? 'on' : ''}" d="M${n(cx)} ${n(cy + 26)} C ${n(cx)} ${n(cy + 62)}, ${n(p.x)} ${n(p.y - 52)}, ${n(p.x)} ${n(p.y - 19)}"/>`,
    )
    .join('');
  const nodes = pts
    .map((p) => {
      let anchor = 'middle';
      if (count > 1 && p.x < 70) anchor = 'start';
      else if (count > 1 && p.x > W - 70) anchor = 'end';
      let tx = p.x;
      if (anchor === 'start') tx = p.x - 18;
      else if (anchor === 'end') tx = p.x + 18;
      return `<circle class="node ${p.d.on ? 'on' : ''}" cx="${n(p.x)}" cy="${n(p.y)}" r="18"/>
      <g class="glyph ${p.d.on ? 'on' : ''}" transform="translate(${n(p.x - 10)} ${n(p.y - 10)})">${svgGlyph(p.d.os, 20)}</g>
      <text x="${n(tx)}" y="${n(p.y + 36)}" style="text-anchor:${anchor}">${esc(p.d.name)}</text>`;
    })
    .join('');
  const label = `${hub.name} (${hub.sub})${count ? `: ${around.map((d) => `${d.name} ${d.on ? 'connected' : 'not connected'}`).join(', ')}` : ''}`;
  return `<svg class="map" viewBox="0 0 ${n(W)} ${n(H)}" role="img" aria-label="${esc(label)}">${edges}
    <circle class="hubring" cx="${n(cx)}" cy="${n(cy)}" r="30"/><circle class="hub" cx="${n(cx)}" cy="${n(cy)}" r="25"/>
    <g class="glyph hub" transform="translate(${n(cx - 12)} ${n(cy - 12)})">${svgGlyph(hub.os, 24)}</g>
    <text x="${n(cx + 42)}" y="${n(cy - 2)}" style="text-anchor:start">${esc(hub.name)}</text>
    <text class="msub" x="${n(cx + 42)}" y="${n(cy + 14)}" style="text-anchor:start">${esc(hub.sub)}</text>${nodes}</svg>`;
}

/* ---------- rail ---------- */
function stepSub(k: number): string {
  const s = S();
  if (k === 1) return plural(s.devices.length, 'computer');
  if (k === 2 && isCloud() && s.cloud) {
    const a = (s.cloud.approved ?? []).filter((d) => d.self !== true).length,
      w = (s.cloud.pending ?? []).length;
    return `${n(a)} connected${w ? `, ${n(w)} waiting` : ''}`;
  }
  if (k === 2) {
    const o = others();
    return o.length > 0
      ? `${n(o.filter((d) => d.connected === true).length)} of ${n(o.length)} connected`
      : 'Nothing to connect';
  }
  if (k === 3) return isCloud() ? 'Cloud brain' : (s.brain ?? '');
  if (k === 4) {
    if (isCloud()) return 'Not needed';
    return s.keepOn.ack ? 'Confirmed' : '';
  }
  return '';
}
function stepClass(k: number, cur: number): string {
  if (k < cur) return 'done';
  return k === cur ? 'now' : '';
}
function renderRail(): void {
  const s = S();
  let cur = s.step;
  if (s.done) cur = 6;
  else if (welcome) cur = 0;
  $('steps').innerHTML = NAMES.map((name, i) => {
    const k = i + 1,
      cls = stepClass(k, cur);
    const sub = k < cur || (k === cur && k !== 5) ? stepSub(k) : '';
    const canGo = !s.done && !welcome && k < s.step && !(k === 4 && isCloud());
    const label = `${esc(name)}${sub ? `<span class="s">${esc(sub)}</span>` : ''}`;
    return `<li class="${cls}" ${k === cur ? 'aria-current="step"' : ''}><span class="n">${k < cur ? I.check : n(k)}</span>
      ${canGo ? `<button class="t" data-goto="${n(k)}" title="Go back to this step">${label}</button>` : `<span class="t">${label}</span>`}</li>`;
  }).join('');
  const prog =
    s.done || welcome
      ? ''
      : `<div class="lbl">Step ${n(s.step)} of 5: ${esc(NAMES[s.step - 1])}</div>
    <div class="bar">${NAMES.map((_, i) => `<i class="${stepClass(i + 1, s.step)}"></i>`).join('')}</div>`;
  $('mprog').innerHTML = prog;
  $('mprog').hidden = !prog;
  renderChecks();
}
// ---- guided fixes: buttons that open System Settings / a password prompt / Terminal (lib/setup_fix.ts)
function fixActions(c: Check | undefined): string {
  const first = c?.actions?.[0];
  if (!c || c.ok || !first) return '';
  return `<div class="fixacts"><button class="btn small primary" data-fixcheck="${esc(c.id ?? 'keepon')}">${esc(first.label)}</button></div>`;
}
function allFixable(): Check[] {
  const s = S();
  const list = s.checks.filter((c) => !c.ok && (c.actions ?? []).length > 0);
  const k = s.keepOn.check;
  if (has(s.brain) && !isCloud() && !k.ok && k.actions && !s.done && s.step >= 4)
    list.push({ ...k, id: 'keepon', title: 'Keep the brain awake', cause: k.detail ?? '' });
  return list;
}
const FIX: { open: string | null; dismissed: Set<string>; timer: ReturnType<typeof setInterval> | undefined } = {
  open: null,
  dismissed: new Set(),
  timer: undefined,
};
function findCheck(id: string | null): Check | null {
  return allFixable().find((c) => c.id === id) ?? null;
}
function openFix(id: string): void {
  const c = findCheck(id);
  if (!c) return;
  const [main, ...rest] = c.actions ?? [];
  if (!main) return;
  FIX.open = id;
  $('fixtitle').textContent = c.title.replace(
    /^Other computers can reach this one$/,
    'Let your other computers reach this one',
  );
  $('fixcause').textContent = (c.cause ?? '') || (c.detail ?? '');
  // one button does it; the manual way stays folded away (user: nobody can find one entry in a long list)
  $('fixbtns').innerHTML =
    `<button class="btn primary" data-fix="${esc(main.id)}">${esc(main.label)}</button>` +
    (has(main.note) ? `<span class="note2">${esc(main.note)}</span>` : '');
  $('fixsteps').innerHTML = (c.steps ?? []).map((t) => `<li>${esc(t)}</li>`).join('');
  $('fixbtns2').innerHTML = rest
    .map((a) => `<button class="btn small" data-fix="${esc(a.id)}">${esc(a.label)}</button>`)
    .join('');
  // a macOS permission (lib/permissions.ts): the steps ARE the guide, so they stay open
  $details('fixmanual').open = c.perm === true;
  $('fixsum').textContent = c.perm === true ? 'Steps' : "I'd rather do it myself in System Settings";
  $('fixclose').textContent = 'Later';
  $('fixmanual').style.display = (c.steps && c.steps.length > 0) || rest.length > 0 ? '' : 'none';
  $('fixstatus').textContent = '';
  $('fixstatus').className = 'fixstatus';
  if (!$dialog('fixbox').open) $dialog('fixbox').showModal();
  clearInterval(FIX.timer);
  FIX.timer = setInterval(() => {
    void (async () => {
      // the user is fixing it right now: check every 2 s
      try {
        const s = await api('/api/setup');
        S().checks = s.checks;
        S().keepOn = s.keepOn;
        // a permission counts as done only when the state says granted (a failed read hides the row)
        const done = c.perm === true ? S().checks.some((x) => x.id === FIX.open && x.ok) : !findCheck(FIX.open);
        if (done) {
          $('fixstatus').textContent = c.perm === true ? `${c.title}: granted. Thank you.` : 'Fixed. Thank you.';
          $('fixstatus').className = 'fixstatus ok';
          // like agent-desktop's guide: go on to the next missing permission by itself
          const next = c.perm === true ? allFixable().find((x) => x.perm === true) : undefined;
          clearInterval(FIX.timer);
          setTimeout(() => {
            closeFix();
            render();
            const nextId = next?.id,
              nextAction = next?.actions?.[0];
            if (nextId !== undefined && nextAction) {
              openFix(nextId);
              void runFix(nextAction.id);
            }
          }, 1500);
        }
      } catch {
        /* keep */
      }
    })();
  }, 2000);
}
function closeFix(): void {
  clearInterval(FIX.timer);
  if (FIX.open !== null) FIX.dismissed.add(FIX.open);
  FIX.open = null;
  if ($dialog('fixbox').open) $dialog('fixbox').close();
}
function autoFix(): void {
  // pop up once per problem; "Later" keeps it closed until the page is reloaded
  if (FIX.open !== null || $dialog('copybox').open) return;
  // the firewall matters only when other computers connect to this one (not for a cloud brain)
  const cloudScreen = !S().done && S().step === 3 && brainPick() === 'cloud';
  // permissions are optional and open only on a click (no window pops up on its own about the screen)
  const c = allFixable().find(
    (x) => !FIX.dismissed.has(x.id ?? '') && x.perm !== true && !(cloudScreen && x.id === 'firewall'),
  );
  if (c?.id !== undefined) openFix(c.id);
}
async function runFix(id: string): Promise<void> {
  const st = $('fixstatus');
  st.className = 'fixstatus';
  st.textContent =
    id.includes('allow') || id.includes('awake') ? 'Enter your Mac password in the window macOS shows…' : 'Opening…';
  try {
    const r = await api<{ ok?: boolean; message?: string }>('/api/setupFix', { id });
    st.textContent = r.message ?? '';
    st.className = 'fixstatus ' + (r.ok === true ? '' : 'bad');
  } catch (error) {
    st.textContent = errMsg(error);
    st.className = 'fixstatus bad';
  }
}

function checkDot(c: Check): string {
  if (c.ok) return I.dotOk;
  return c.optional === true ? I.dotOpt : I.dotBad;
}
function renderChecks(): void {
  const s = S();
  const bad = s.checks.filter((c) => !c.ok && c.optional !== true); // an optional tool (Codex) is never a problem
  const sum =
    bad.length > 0
      ? `${I.dotBad}<span><b>${plural(bad.length, 'problem')}</b> on ${esc(s.local)}</span>`
      : `${I.dotOk}<span>${esc(s.local)} is ready</span>`;
  const list = s.checks
    .map(
      (c) => `<div class="chk">${checkDot(c)}<div><div>${esc(c.title)}</div>
      ${c.ok ? '' : `<div class="cause">${esc(c.cause)}</div>${fixActions(c)}${fixBlock(c.fix)}`}</div></div>`,
    )
    .join('');
  const d = document.querySelector<HTMLDetailsElement>('#checks details');
  const open = bad.length > 0 || (d ? d.open : false);
  $('checks').innerHTML =
    `<details ${open ? 'open' : ''}><summary>${sum}${I.chev}</summary><div style="margin-top:8px">${list}</div></details>
    <div class="foot"><button class="linkbtn" data-diag>Copy diagnostics</button><span>Checked again every 10 seconds</span></div>`;
}

/* ---------- screens ---------- */
function screenWelcome(): string {
  const me = thisComputer();
  return `<div class="welcome">
      <h2>Bring all your Claude sessions into one place</h2>
      <p class="lead">Thoth shows the Claude Code sessions from every computer you use. The brain collects them: your own cloud server, or one computer that stays on. Setup takes about five minutes.</p>
      ${deviceMap({ name: me.name, os: me.os, sub: 'this computer' }, [
        { name: 'laptop', os: 'macos', on: true },
        { name: 'work-pc', os: 'windows', on: true },
        { name: 'home-server', os: 'linux', on: false },
      ])}
      <ol class="plan">
        <li><span><b>Your devices.</b> Tell the panel which computers you use.</span></li>
        <li><span><b>Connect them.</b> Run one command on each computer.</span></li>
        <li><span><b>Your brain.</b> Connect your cloud brain, or pick the computer that collects everything.</span></li>
        <li><span><b>Keep it on.</b> Only when the brain is a computer: it must stay switched on.</span></li>
        <li><span><b>Move sessions in.</b> Bring open Claude sessions into the panel.</span></li>
      </ol>
      <div class="row"><button class="btn primary" id="start">Start setup</button><span class="small muted">You can stop at any time. This page remembers where you are.</span></div>
    </div>`;
}
function screen1(): string {
  const me = thisComputer();
  return `<p class="kicker stepk">Step 1 of 5</p>
      <h2>Which computers do you use?</h2>
      <p class="lead">Add every computer where you use Claude Code or Codex. This computer is already on the list.</p>
      <div class="stack" id="devlist">
        <div class="box row"><div class="ico on">${glyph(me.os)}</div><div class="grow"><div class="dname">${esc(me.name)}</div><div class="dmeta">${esc(OS[me.os])}</div></div><span class="pill ok">This computer</span></div>
        ${others()
          .map((d) => devRow(d))
          .join('')}
      </div>
      <div style="margin-top:10px"><button class="add" id="add">+ Add another computer</button></div>
      <p class="small muted" id="hint" style="margin-top:12px">${others().length > 0 ? 'Names use small letters, digits and dashes, for example work-pc.' : 'Only this computer? That is fine. Continue, and add others later.'}</p>
      <div class="err" id="err"></div>
      <div class="nav"><button class="btn ghost" id="back">Back</button><div class="right"><button class="btn primary" id="next">Save and continue</button></div></div>`;
}
function screen2(): string {
  if (isCloud()) return screenCloud2();
  const o = others(),
    me = thisComputer();
  if (o.length === 0) {
    return `<p class="kicker stepk">Step 2 of 5</p><h2>Nothing to connect</h2>
        <p class="lead">You use only ${esc(me.name)}, so there is nothing to connect. You can add computers later in step 1.</p>
        <div class="err" id="err"></div>
        <div class="nav"><button class="btn ghost" id="back">Back</button><div class="right"><button class="btn primary" id="next">Continue</button></div></div>`;
  }
  const c = o.filter((d) => d.connected === true).length;
  let nextLabel = 'Skip for now';
  if (c === o.length) nextLabel = 'Continue';
  else if (c) nextLabel = 'Continue, connect the rest later';
  return `<p class="kicker stepk">Step 2 of 5</p>
      <h2>Connect your other computers</h2>
      <p class="lead">Run one command on each computer. It then sends its sessions here every 5 minutes. This page updates by itself.</p>
      ${deviceMap(
        { name: me.name, os: me.os, sub: 'this computer' },
        o.map((d) => ({ name: d.name, os: d.os, on: d.connected === true })),
      )}
      <div class="stack">${o.map((d) => devCard(d)).join('')}</div>
      <div class="note" style="margin-top:16px">${I.info}<div><p>Each computer must reach this one: the same home or office network, or Tailscale on both. It needs Python 3. Nothing else is installed.</p>
        <p>Do you have a cloud brain? Then skip this step. In the next step you connect it, and then your computers join it from any network.</p></div></div>
      <div class="err" id="err"></div>
      <div class="nav"><button class="btn ghost" id="back">Back</button><div class="right">
        <button class="btn ${c === o.length ? 'primary' : ''}" id="next">${nextLabel}</button></div></div>`;
}
function screen3(): string {
  const pick = brainPick();
  let next = '<button class="btn primary" id="next">Use this computer as the brain</button>';
  if (pick === 'cloud') next = isCloud() ? '<button class="btn primary" id="next">Continue</button>' : '';
  const map =
    pick === 'cloud'
      ? deviceMap(
          cloudHub(),
          S().devices.map((d) => ({ name: d.name, os: d.os, on: d.self === true && isCloud() })),
        )
      : brainMap(S().devices.find((d) => d.name === pick) ?? thisComputer());
  return `<p class="kicker stepk">Step 3 of 5</p>
      <h2>Where is your brain?</h2>
      <p class="lead">The brain collects the sessions and notes of all your computers. A cloud brain is your own server: it is always on, and your computers reach it from any network.</p>
      <div id="brainmap">${map}</div>
      ${brainChooser(pick, false)}
      <div class="err" id="err"></div>
      <div class="nav"><button class="btn ghost" id="back">Back</button><div class="right">${next}</div></div>`;
}
// step 2 with a cloud brain: computers ask to join it; the owner decides here
function screenCloud2(): string {
  const approved = S().cloud?.approved ?? [];
  return `<p class="kicker stepk">Step 2 of 5</p>
      <h2>Connect your computers to your cloud brain</h2>
      <p class="lead">Run one command on each computer. It asks to join, and you choose Approve here. Approved computers send their sessions every 5 minutes. This page updates by itself.</p>
      ${cloudMap()}
      ${selfNote()}
      ${cloudDevicesHtml()}
      <div class="err" id="err"></div>
      <div class="nav"><button class="btn ghost" id="back">Back</button><div class="right">
        <button class="btn primary" id="next">${approved.some((d) => d.self !== true) ? 'Continue' : 'Continue, connect computers later'}</button></div></div>`;
}
function screen4(): string {
  const c = S().keepOn.check,
    brain = S().devices.find((d) => d.name === S().brain) ?? thisComputer();
  let check: string;
  if (brain.self !== true)
    check = `<div class="note">${I.info}<div><p class="t">Check the sleep setting on ${esc(brain.name)}</p><p>${esc(SLEEP_ADVICE[brain.os] ?? SLEEP_ADVICE['linux'])}</p></div></div>`;
  else if (c.ok)
    check = `<div class="note ok">${I.ok}<div><p class="t">The sleep setting is good</p><p>${esc(c.detail)}</p></div></div>`;
  else
    check = `<div class="note warn">${I.warn}<div><p class="t">${esc(c.detail)}</p>${fixActions({ ...c, id: 'keepon' })}${fixBlock(c.fix)}</div></div>`;
  return `<p class="kicker stepk">Step 4 of 5</p>
      <h2>Keep ${esc(brain.name)} switched on</h2>
      <p class="lead">When the brain sleeps or is off, sessions from your other computers stop arriving, and the panel cannot reach them.</p>
      <div class="stack">
        <div class="note warn">${I.warn}<div><p class="t">${esc(brain.name)} must stay on and plugged in.</p><p>A laptop that you close and carry away is a poor brain. It still works, but sessions only arrive while it is open.</p></div></div>
        ${check}
      </div>
      <label class="ack"><input type="checkbox" id="ack" ${S().keepOn.ack ? 'checked' : ''}><span>I will keep <b>${esc(brain.name)}</b> switched on and plugged in.</span></label>
      <div class="err" id="err"></div>
      <div class="nav"><button class="btn ghost" id="back">Back</button><div class="right"><button class="btn primary" id="next" ${S().keepOn.ack ? '' : 'aria-disabled="true"'}>Continue</button></div></div>`;
}
function screen5(): string {
  return `<p class="kicker stepk">Step 5 of 5</p>
      <h2>Move your sessions in</h2>
      <p class="lead">The brain indexes the sessions of every connected computer. Claude sessions that are open in other windows on this computer can move into the panel now.</p>
      <h3>What the brain has found</h3>
      <div id="brainlist">${brainList()}</div>
      <h3>Open outside the panel on ${esc(S().local)}</h3>
      <div id="outlist">${outList()}</div>
      <div class="err" id="err"></div>
      <div class="nav"><button class="btn ghost" id="back">Back</button><div class="right"><button class="btn primary" id="next">Finish and open the panel</button></div></div>`;
}
const sends = (count: number): string =>
  count
    ? `${plural(count, 'other computer')} ${count === 1 ? 'sends its' : 'send their'} sessions to it.`
    : 'No other computer is connected yet.';
// after setup (the Mac app's "Set Up Devices…" opens this page at any time): manage devices and the brain
function screenDone(): string {
  if (isCloud()) return screenDoneCloud();
  const s = S(),
    me = thisComputer(),
    brain = s.devices.find((d) => d.name === s.brain);
  const hub = brain ?? me;
  const c = others().filter((d) => d.connected === true).length;
  const can = s.devices.filter((d) => d.self === true || d.connected === true);
  const lead =
    s.migrated === true && !has(s.brain)
      ? 'This panel was in use before the setup page existed. Add your other computers here, and choose the brain.'
      : `The brain is <b>${esc(hub.name)}</b>. ${sends(c)} Add or connect a computer, or change the brain, at any time.`;
  const addBox = ADDING
    ? `<div class="box devrow dev" id="newdev">${devRow({ name: '', os: 'windows' })
        .replace(/^<div class="box devrow dev">/, '')
        .replace(/<button class="btn small ghost rm"[^>]*>Remove<\/button><\/div>$/, '')}
          <button class="btn small primary" id="addsave">Add</button></div>
          <p class="small muted" style="margin:8px 0 0">Names use small letters, digits and dashes, for example work-pc. <button class="linkbtn" id="addcancel">Cancel</button></p>`
    : '<button class="add" id="add">+ Add another computer</button>';
  return `<div class="row" style="justify-content:space-between;align-items:flex-start;gap:16px">
        <div class="grow"><p class="kicker">Setup is done</p><h2>Your computers</h2></div>
        <a class="btn primary" href="/">Open the panel</a></div>
      <p class="lead">${lead}</p>
      ${deviceMap(
        { name: hub.name, os: hub.os, sub: brain ? 'the brain' : 'this computer' },
        s.devices
          .filter((d) => d.name !== hub.name)
          .map((d) => ({ name: d.name, os: d.os, on: d.self === true || d.connected === true })),
      )}
      <div class="stack">
        <div class="box row"><div class="ico on">${glyph(me.os)}</div><div class="grow"><div class="dname">${esc(me.name)}</div><div class="dmeta">${esc(OS[me.os])}, this computer</div></div>
          ${me.name === s.brain ? '<span class="pill ok">The brain</span>' : '<span class="pill ok">This computer</span>'}</div>
        ${others()
          .map((d) => devCard(d))
          .join('')}
      </div>
      <div style="margin-top:10px" id="addbox">${addBox}</div>
      <div class="err" id="err"></div>
      <h3>The brain</h3>
      ${
        CHANGING || !has(s.brain)
          ? brainChange()
          : `<div class="box row"><div class="ico on">${glyph(hub.os)}</div><div class="grow"><div class="dname">${esc(hub.name)}</div>
          <div class="dmeta">${can.length > 1 ? 'Collects the sessions of all your computers.' : 'Collects your sessions.'} It must stay switched on.</div></div>
          <button class="btn small" id="brainchange">Change the brain</button></div>`
      }`;
}
function screenDoneCloud(): string {
  const c = S().cloud,
    count = (c?.approved ?? []).filter((d) => d.self !== true).length;
  return `<div class="row" style="justify-content:space-between;align-items:flex-start;gap:16px">
        <div class="grow"><p class="kicker">Setup is done</p><h2>Your computers</h2></div>
        <a class="btn primary" href="/">Open the panel</a></div>
      <p class="lead">Your brain is in the cloud at <b>${esc(c?.host)}</b>. ${sends(count)} Add a computer, or change the brain, at any time.</p>
      ${cloudMap()}
      ${selfNote()}
      ${cloudDevicesHtml()}
      <div class="err" id="err"></div>
      <h3>The brain</h3>
      ${
        CHANGING
          ? brainChange()
          : `<div class="box row"><div class="ico on">${glyph('cloud')}</div><div class="grow"><div class="dname">Cloud brain</div>
          <div class="dmeta">${esc(c?.host)}. Always on; your computers connect to it from any network.</div></div>
          <button class="btn small" id="brainchange">Change the brain</button></div>`
      }`;
}
const STEP_SCREEN: Record<number, (() => string) | undefined> = {
  1: screen1,
  2: screen2,
  3: screen3,
  4: screen4,
  5: screen5,
};

/* ---------- the brain: cloud or a computer (step 3 and the manage view) ---------- */
function brainPick(): string {
  const s = S();
  if (PICK !== null && (PICK === 'cloud' || s.devices.some((d) => d.name === PICK))) return PICK;
  return has(s.brain) && !isCloud() ? s.brain : 'cloud';
}
const cloudHub = (): Hub => ({ name: 'Cloud brain', os: 'cloud', sub: S().cloud?.host ?? 'your server' });
function cloudMap(): string {
  const c = S().cloud;
  const nodes = [
    ...(c?.approved ?? []).map((d) => ({ name: d.name, os: d.os, on: true })),
    ...(c?.pending ?? []).map((d) => ({ name: d.name, os: d.os, on: false })),
  ];
  return deviceMap(cloudHub(), nodes.slice(0, 6));
}
function brainChooser(pick: string, manage: boolean): string {
  const linkbox = `<div class="linkbox"><label for="link">Paste the connect link from your server</label>
      <div class="row"><input type="text" id="link" placeholder="ccbrain://…/#…" autocomplete="off" spellcheck="false" aria-describedby="linkhelp"><button class="btn primary" id="connect">Connect</button></div>
      <p class="small muted" id="linkhelp" style="margin:8px 0 0">The install on your server printed it. It starts with ccbrain://. Keep it private: it is the key to your brain.</p></div>`;
  const connected = `<div class="note ok">${I.ok}<div><p class="t">Connected to your cloud brain</p><p>${esc(S().cloud?.host)}. <button class="linkbtn" id="relinkbtn">Use another link</button></p></div></div>`;
  let box = '';
  if (pick === 'cloud') box = isCloud() && !manage && !PICK_RELINK ? connected : linkbox;
  const opts = S()
    .devices.map((d) => {
      const ok = d.self === true || d.connected === true;
      let meta: string;
      if (d.self === true) meta = `${esc(d.name)}, ${esc(OS[d.os])}. It must stay on.`;
      else meta = `${esc(OS[d.os])}${ok ? '. It must stay on.' : '. Connect it in step 2 first.'}`;
      return `<label class="opt ${ok ? '' : 'off'}"><input type="radio" name="brain" value="${esc(d.name)}" ${d.name === pick ? 'checked' : ''} ${ok ? '' : 'disabled'}>
      <span class="radio"></span><span class="ico ${ok ? 'on' : ''}">${glyph(d.os)}</span>
      <span class="grow"><span class="dname">${d.self === true ? 'This computer' : esc(d.name)}</span><br><span class="dmeta">${meta}</span></span></label>`;
    })
    .join('');
  return `<div class="stack" role="radiogroup" aria-label="Where is the brain">
    <label class="opt"><input type="radio" name="brain" value="cloud" ${pick === 'cloud' ? 'checked' : ''}><span class="radio"></span><span class="ico on">${glyph('cloud')}</span>
      <span class="grow"><span class="dname">My cloud brain</span> <span class="pill ok">Recommended</span><br><span class="dmeta">Your own server. Always on, reached from any network.</span></span></label>
    ${box}${opts}</div>`;
}
let PICK_RELINK = false;
// manage view: change the brain (a cloud link, or a computer with the keep-on confirmation)
function brainChange(): string {
  const pick = brainPick();
  const local = pick !== 'cloud';
  return `<p class="muted" style="margin-top:0">${isCloud() ? 'Connect with a new link, or make a computer the brain again.' : 'A cloud brain is always on. A computer must stay switched on.'}</p>
    ${brainChooser(pick, true)}
    ${
      local
        ? `<div class="note warn" style="margin-top:12px">${I.warn}<div><p class="t">The brain must stay on and plugged in.</p><p>When it sleeps or is off, sessions from your other computers stop arriving, and the panel cannot reach them.</p></div></div>
    <label class="ack"><input type="checkbox" id="ack"><span>I will keep the computer I chose switched on and plugged in.</span></label>`
        : ''
    }
    <div class="err" id="brainerr"></div>
    <div class="row" style="margin-top:14px">${has(S().brain) ? '<button class="btn ghost" id="brainno">Cancel</button>' : ''}${local ? '<button class="btn primary" id="brainyes">Use this computer as the brain</button>' : ''}</div>`;
}
function selfNote(): string {
  const c = S().cloud;
  if (!c) return '';
  const me = c.self ?? {};
  if (has(me.error))
    return `<div class="note warn" style="margin-bottom:16px">${I.warn}<div><p class="t">${esc(S().local)} is not sending its sessions</p><p>${esc(me.error)}</p></div></div>`;
  const p = me.push;
  let line = 'It sends its sessions every 5 minutes.';
  if (me.pushing === true && !p) line = 'It is sending its sessions now…';
  else if (p?.ok === true)
    line = `It sends its sessions every 5 minutes.${p.sessions === undefined ? '' : ` The brain has ${plural(p.sessions, 'session')} from it.`}`;
  else if (p) line = `The last send failed: ${p.message ?? ''}. It tries again in 5 minutes.`;
  const failed = p ? !p.ok : false;
  return `<div class="note ${failed ? 'warn' : 'ok'}" style="margin-bottom:16px">${failed ? I.warn : I.ok}<div><p class="t">This computer (${esc(S().local)}) is connected to the cloud brain</p><p>${esc(line)}</p></div></div>`;
}
function askCard(d: CloudDevice, later: boolean): string {
  return `<div class="box asking"><div class="row"><div class="ico">${glyph(d.os)}</div>
    <div class="grow"><div class="dname">${esc(d.name)} <b>wants to join</b></div><div class="dmeta">${esc(OS[d.os] ?? 'Unknown system')}${has(d.host) ? `, computer name ${esc(d.host)}` : ''}</div></div>
    <div class="decide"><button class="btn small primary" data-decide="approve" data-id="${esc(d.id)}">Approve</button><button class="btn small" data-decide="ignore" data-id="${esc(d.id)}">Ignore</button>${later ? '' : `<button class="btn small ghost" data-decide="later" data-id="${esc(d.id)}">Later</button>`}</div></div></div>`;
}
function cloudDevicesHtml(): string {
  const c = S().cloud;
  if (!c) return '';
  let h = '';
  if (!c.up)
    h += `<div class="note bad" role="alert">${I.bad}<div><p class="t">Your cloud brain does not answer</p><p>${esc(c.error)}</p><div class="acts"><button class="linkbtn" data-diag>Copy diagnostics</button></div></div></div>`;
  const pend = c.pending ?? [],
    later = c.later ?? [],
    appr = c.approved ?? [],
    ign = c.ignored ?? [];
  h +=
    `<h3>Wants to join</h3>` +
    (pend.length > 0
      ? `<div class="stack">${pend.map((d) => askCard(d, false)).join('')}</div>`
      : '<div class="list"><div class="none"><b>No computer is asking to join</b>Run the command below on a computer. It appears here within a few seconds.</div></div>');
  if (later.length > 0)
    h += `<details class="fold"><summary>Asked earlier (${n(later.length)})</summary><div class="stack">${later.map((d) => askCard(d, true)).join('')}</div></details>`;
  const live = CODE && CODE.expires > Date.now() ? CODE : null;
  h += `<h3>Add a computer</h3><p class="muted" style="margin-top:0">On the other computer, open a terminal, paste this command and press Enter. It needs Python 3.</p>
    <p class="oslabel">Mac or Linux (Terminal)</p>${cmdBlock(c.commands.posix)}
    <p class="oslabel">Windows (PowerShell)</p>${cmdBlock(c.commands.windows)}
    <details class="fold" id="codefold" ${live || CODE_ERR ? 'open' : ''}><summary>Get a pre-approved code (the computer joins without asking)</summary>
      <div class="row"><input type="text" id="codename" placeholder="Name, for example work-pc" autocomplete="off" spellcheck="false" aria-label="Computer name" style="flex:1;min-width:180px"><button class="btn small primary" id="codego">Get code</button></div>
      ${CODE_ERR ? `<div style="margin-top:10px">${errBox(CODE_ERR, 'Could not make a code')}</div>` : ''}
      ${
        live
          ? `<div class="how"><p style="margin:0">On <b>${esc(live.device)}</b>, run:</p><p class="oslabel">Mac or Linux</p>${cmdBlock(live.commands.posix)}<p class="oslabel">Windows</p>${cmdBlock(live.commands.windows)}
        <p class="small muted" style="margin:8px 0 0">Code <b>${esc(live.code)}</b>. It works once, for <span data-exp="${n(live.expires)}">${left(live.expires)}</span>.</p></div>`
          : ''
      }
    </details>`;
  h +=
    '<h3>Connected</h3>' +
    (appr.length > 0
      ? `<div class="stack">${appr
          .map(
            (d) => `<div class="box"><div class="row"><div class="ico on">${glyph(d.os)}</div>
      <div class="grow"><div class="dname">${esc(d.name)}</div><div class="dmeta">${esc((OS[d.os] ?? d.os) || 'Unknown system')}${d.self === true ? ', this computer' : ''}${nonZero(d.lastSeen) ? `, last sent ${ago(d.lastSeen)}` : ''}</div></div>
      <div class="dact"><span class="pill ok"><span class="d"></span>${plural(d.sessions, 'session')}</span>${d.self === true || d.joined !== true ? '' : `<button class="btn small ghost" data-decide="revoke" data-id="${esc(d.id)}" data-name="${esc(d.name)}">Disconnect</button>`}</div></div>
      ${has(d.error) ? `<p class="small" style="color:var(--red);margin:8px 0 0">${esc(d.error)}</p>` : ''}</div>`,
          )
          .join('')}</div>`
      : '<div class="list"><div class="none"><b>No computer is connected yet</b>Approved computers appear here.</div></div>');
  if (ign.length > 0)
    h += `<details class="fold"><summary>Ignored (${n(ign.length)})</summary><div class="stack">${ign
      .map(
        (d) => `<div class="box"><div class="row"><div class="ico">${glyph(d.os)}</div>
      <div class="grow"><div class="dname">${esc(d.name)}</div><div class="dmeta">${esc(OS[d.os] ?? 'Unknown system')}${has(d.host) ? `, computer name ${esc(d.host)}` : ''}. It cannot join until you choose Unignore.</div></div>
      <button class="btn small" data-decide="unignore" data-id="${esc(d.id)}">Unignore</button></div></div>`,
      )
      .join('')}</div></details>`;
  return h;
}
// a failed connect: the fix pop-up (one sentence, one button; what to check is folded away)
function showProblem(p: Problem): void {
  clearInterval(FIX.timer);
  FIX.open = null;
  $('fixtitle').textContent = (p.title ?? '') || 'Could not connect';
  $('fixcause').textContent = p.error ?? '';
  $('fixbtns').innerHTML = '<button class="btn primary" id="relink">Paste the link again</button>';
  $('fixsteps').innerHTML = (p.steps ?? []).map((t) => `<li>${esc(t)}</li>`).join('');
  $('fixbtns2').innerHTML = '<button class="linkbtn" data-diag>Copy diagnostics</button>';
  $('fixsum').textContent = 'What to check';
  $('fixclose').textContent = 'Close';
  $details('fixmanual').open = false;
  $('fixmanual').style.display = (p.steps ?? []).length > 0 ? '' : 'none';
  $('fixstatus').textContent = '';
  $('fixstatus').className = 'fixstatus';
  if (!$dialog('fixbox').open) $dialog('fixbox').showModal();
}
async function connectCloud(after: (() => void) | null): Promise<void> {
  const b = $button('connect'),
    input = $input('link');
  const link = input.value.trim();
  if (!link) {
    input.focus();
    showProblem({
      title: 'Paste the connect link first',
      error: 'Copy the line that starts with ccbrain:// from your server, then paste it here.',
    });
    return;
  }
  b.disabled = true;
  b.innerHTML = '<span class="spin"></span>Checking…';
  try {
    state = await api('/api/setupCloudConnect', { link });
    PICK = null;
    PICK_RELINK = false;
    if (after) after();
    render();
  } catch (error) {
    b.disabled = false;
    b.textContent = 'Connect';
    showProblem(
      (error instanceof ApiError ? error.problem : undefined) ?? { title: 'Could not connect', error: errMsg(error) },
    );
  }
}
function wireBrainChooser(manage: boolean): void {
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name=brain]'))
    r.addEventListener('change', () => {
      PICK = r.value;
      render();
    });
  const c = maybe('connect');
  if (c) {
    c.addEventListener('click', () => {
      void connectCloud(
        manage
          ? () => {
              CHANGING = false;
            }
          : null,
      );
    });
    $input('link').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') c.click();
    });
  }
  const rl = maybe('relinkbtn');
  if (rl)
    rl.addEventListener('click', () => {
      PICK_RELINK = true;
      render();
      maybe('link')?.focus();
    });
}
function wireCloudCode(): void {
  const g = maybe('codego');
  if (!(g instanceof HTMLButtonElement)) return;
  const go = async (): Promise<void> => {
    g.disabled = true;
    CODE_ERR = '';
    try {
      CODE = await api<Code>('/api/setupCloudCode', { name: $input('codename').value });
    } catch (error) {
      CODE = null;
      CODE_ERR = errMsg(error);
    }
    render();
  };
  g.addEventListener('click', () => {
    void go();
  });
  $input('codename').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void go();
  });
}

function brainMap(hub: Device): string {
  return deviceMap(
    { name: hub.name, os: hub.os, sub: 'the brain' },
    S()
      .devices.filter((d) => d.name !== hub.name)
      .map((d) => ({ name: d.name, os: d.os, on: d.self === true || d.connected === true })),
  );
}
function devRow(d: { name: string; os: string }): string {
  const id = Math.random().toString(36).slice(2, 8);
  return `<div class="box devrow dev"><input type="text" class="name" placeholder="Name, for example work-pc" value="${esc(d.name)}" aria-label="Computer name" autocomplete="off" spellcheck="false">
    <span class="seg" role="radiogroup" aria-label="Operating system">${Object.entries(OS)
      .map(
        ([k, v]) =>
          `<label><input type="radio" name="os-${id}" value="${k}" ${d.os === k ? 'checked' : ''}><span>${v}</span></label>`,
      )
      .join('')}</span>
    <button class="btn small ghost rm" aria-label="Remove ${esc(d.name || 'this computer')}">Remove</button></div>`;
}
function left(exp: number): string {
  const s = Math.max(0, Math.round((exp - Date.now()) / 1000));
  return s >= 60 ? `${n(Math.ceil(s / 60))} more minutes` : `${n(s)} more seconds`;
}
function devCard(d: Device): string {
  const p = PAIRS[d.name],
    live = (x: { expires: number } | null | undefined): boolean => !!x && x.expires > Date.now();
  let pill: string, btn: string;
  if (d.connected === true) {
    pill = `<span class="pill ok"><span class="d"></span>Connected, ${plural(d.sessions ?? 0, 'session')}</span>`;
    btn = `<button class="btn small ghost revoke" data-dev="${esc(d.name)}">Disconnect</button>`;
  } else if (live(d.pairing)) {
    pill = '<span class="pill wait"><span class="d"></span>Waiting for the computer</span>';
    btn = `<button class="btn small pair" data-dev="${esc(d.name)}">New code</button>`;
  } else {
    pill =
      d.revoked === true
        ? '<span class="pill bad"><span class="d"></span>Disconnected</span>'
        : '<span class="pill"><span class="d"></span>Not connected</span>';
    btn = `<button class="btn small primary pair" data-dev="${esc(d.name)}">Get join command</button>`;
  }
  const meta =
    d.connected === true
      ? `${esc(OS[d.os])}${nonZero(d.lastSeen) ? `, last sent ${ago(d.lastSeen)}` : ''}`
      : esc(OS[d.os]);
  let body = '';
  const pairErr = PAIR_ERR[d.name];
  if (has(pairErr))
    body = `<div style="margin-top:12px">${errBox(pairErr, `Could not make a join command for ${d.name}`)}</div>`;
  else if (d.connected !== true && p && live(p)) {
    const cmd = d.os === 'windows' ? p.commands.windows : p.commands.posix;
    let term = 'a <b>terminal</b>';
    if (d.os === 'windows') term = '<b>PowerShell</b> (Start menu, type PowerShell)';
    else if (d.os === 'macos') term = '<b>Terminal</b> (Spotlight, type Terminal)';
    const reach =
      p.addresses.length > 1
        ? ` If ${esc(d.name)} cannot reach this computer, replace ${esc(p.addresses[0])} with ${p.addresses
            .slice(1)
            .map((a) => esc(a))
            .join(' or ')}.`
        : '';
    body = `<div class="how"><ol>
        <li>On <b>${esc(d.name)}</b>, open ${term}.</li>
        <li>Paste this command and press Enter:${cmdBlock(cmd)}</li>
        <li>Come back here. This card turns green when ${esc(d.name)} is connected.</li></ol>
      <p class="small muted" style="margin:8px 0 0">Code <b>${esc(p.code)}</b>. It works once, for <span data-exp="${n(p.expires)}">${left(p.expires)}</span>.${reach}</p></div>`;
  } else if (d.connected !== true && live(d.pairing)) {
    body =
      '<p class="small muted" style="margin:10px 0 0">A code was made earlier. If you no longer have the command, choose New code.</p>';
  } else if (d.connected !== true && p) {
    body =
      '<p class="small muted" style="margin:10px 0 0">The code expired. Choose Get join command for a new one.</p>';
  }
  return `<div class="box"><div class="row"><div class="ico ${d.connected === true ? 'on' : ''}">${glyph(d.os)}</div>
    <div class="grow"><div class="dname">${esc(d.name)}</div><div class="dmeta">${meta}</div></div><div class="dact">${pill}${btn}</div></div>${body}</div>`;
}

function brainDeviceState(d: BrainDevice): string {
  if (has(d.error)) return '<span class="pill bad"><span class="d"></span>Collection failed</span>';
  if (d.known === true)
    return `<span class="pill ok"><span class="d"></span>${nonZero(d.lastSync) ? `Updated ${ago(d.lastSync)}` : 'Indexed'}</span>`;
  if (d.connected === true)
    return '<span class="pill wait"><span class="d"></span>Waiting for its first sessions</span>';
  return '<span class="pill">Not connected</span>';
}
function brainList(): string {
  if (!O)
    return '<div class="list"><div class="item"><div class="grow"><div class="skel"></div></div></div><div class="item"><div class="grow"><div class="skel" style="width:40%"></div></div></div></div>';
  if (has(O.error)) return errBox(O.error, 'Could not read the session lists');
  const b = O.brain;
  if (!b)
    return `<div class="note">${I.info}<div><p class="t">The brain does not run with this panel</p><p>Session counts appear here when the brain service runs on ${esc(S().local)}.</p></div></div>`;
  if (!b.up && b.cloud === true)
    return `<div class="note warn">${I.warn}<div><p class="t">${esc(b.error)}</p><p>${esc(b.fix)}</p>
    <div class="acts"><button class="linkbtn" data-diag>Copy diagnostics</button></div></div></div>`;
  if (!b.up)
    return `<div class="note warn">${I.warn}<div><p class="t">${esc(b.error)}</p><p>Without the brain, sessions from other computers do not arrive. To start it, run:</p>${cmdBlock(b.fix.replace(/^Start it:\s*/, ''))}
    <div class="acts"><button class="linkbtn" data-diag>Copy diagnostics</button></div></div></div>`;
  return `<div class="list">${b.devices
    .map(
      (d) => `<div class="item"><div class="ico ${d.known === true && !has(d.error) ? 'on' : ''}">${glyph(d.os)}</div>
      <div class="grow"><div class="dname">${esc(d.name)}</div><div class="dmeta">${esc(OS[d.os] ?? d.os)}${d.self === true ? ', this computer' : ''}</div></div>
      <div class="dact">${brainDeviceState(d)}<div class="count">${n(d.sessions)}<small>${d.sessions === 1 ? 'session' : 'sessions'}</small></div></div>
      ${has(d.error) ? `<div class="msg bad">${esc(d.error)}</div>` : ''}</div>`,
    )
    .join('')}</div>`;
}
function outRow(r: OutsideRow): string {
  const m = MOVE[r.sid];
  let act: string;
  if (m?.state === 'done') act = `<span class="pill ok">${I.check} In the panel</span>`;
  else if (!r.ok) act = '<span class="pill bad">Cannot move</span>';
  else if (m?.state === 'moving') act = '<button class="btn small" disabled><span class="spin"></span>Moving…</button>';
  else
    act = `<button class="btn small primary movein" data-sid="${esc(r.sid)}">${m?.state === 'error' ? 'Try again' : 'Move into the panel'}</button>`;
  let msg = '';
  if (m?.state === 'error') msg = `<div class="msg">${errBox(m.msg ?? '', `Could not move ${r.name}`)}</div>`;
  else if (m?.state === 'done')
    msg = `<div class="msg ok">Moved. ${r.move === 'attach' ? 'The background job keeps running; the panel is attached to it.' : 'The conversation continues in the panel.'}</div>`;
  else if (!r.ok) msg = `<div class="msg bad">${esc(r.problem)}</div>`;
  else if (r.move === 'attach') msg = `<div class="msg muted">${esc(r.moveText)}</div>`;
  return `<div class="item"><div class="ico">${glyph('session')}</div>
      <div class="grow"><div class="dname">${esc(r.name)}${r.agent === 'codex' ? ' <span class="pill">Codex</span>' : ''}</div>
        ${has(r.title) ? `<div class="dmeta" style="color:var(--text)">${esc(r.title)}</div>` : ''}
        <div class="dmeta">${esc((r.shown ?? '') || r.folder)}. ${r.kind === 'background' ? 'Background job' : esc(r.status)}.</div></div>
      <div class="dact">${act}</div>${msg}</div>`;
}
function outList(): string {
  if (!O)
    return '<div class="list"><div class="item"><div class="grow"><div class="skel" style="width:70%"></div></div></div></div>';
  if (has(O.error)) return '';
  const rows = O.outside;
  if (rows.length === 0)
    return '<div class="list"><div class="none"><b>No Claude Code or Codex sessions are open outside the panel</b>Nothing to move. New sessions you start in the panel stay there.</div></div>';
  return `<p class="small muted" style="margin:-4px 0 10px">Moving a session closes it where it runs now and opens the same conversation in the panel. Nothing is lost.</p>
    <div class="list">${rows.map((r) => outRow(r)).join('')}</div>`;
}

/* ---------- actions ---------- */
function showErr(msg: string): void {
  const e = maybe('err');
  if (e) {
    e.innerHTML = errBox(msg);
    e.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}
async function act(fn: () => Promise<Setup>, btn?: HTMLElement | null): Promise<void> {
  const e = maybe('err');
  if (e) e.innerHTML = '';
  if (btn instanceof HTMLButtonElement) btn.disabled = true;
  try {
    state = await fn();
    render();
  } catch (error) {
    if (btn instanceof HTMLButtonElement) btn.disabled = false;
    showErr(errMsg(error));
  }
}
const click = (el: HTMLElement | null, fn: () => unknown): void => {
  if (el)
    el.onclick = () => {
      void fn();
    };
};
function checkedOs(r: Element): string {
  return r.querySelector<HTMLInputElement>('.seg input:checked')?.value ?? '';
}
function nameOf(r: Element): string {
  return r.querySelector<HTMLInputElement>('.name')?.value ?? '';
}
function wire(): void {
  const step = welcome ? 0 : S().step;
  const back = maybe('back');
  click(back, () => {
    if (step === 1) {
      welcome = true;
      render();
      return;
    }
    return act(() => api('/api/setupStep', { step: step === 5 && isCloud() ? 3 : step - 1 }), back);
  });
  if (welcome)
    click($('start'), () => {
      welcome = false;
      store.set('cc-setup-welcomed', '1');
      render();
    });
  else if (step === 1) {
    click($('add'), () => {
      $('devlist').insertAdjacentHTML('beforeend', devRow({ name: '', os: 'windows' }));
      wireRows();
      const ins = $('devlist').querySelectorAll<HTMLInputElement>('.dev .name');
      ins[ins.length - 1]?.focus();
      $('hint').textContent = 'Names use small letters, digits and dashes, for example work-pc.';
    });
    wireRows();
    click($('next'), () =>
      act(
        () =>
          api('/api/setupDevices', {
            devices: [...document.querySelectorAll('.dev')]
              .map((r) => ({ name: nameOf(r), os: checkedOs(r) }))
              .filter((d) => d.name.trim()),
          }),
        $('next'),
      ),
    );
  } else if (step === 2) {
    // a cloud brain is chosen and always on: from here straight to step 5
    click($('next'), () => act(() => api('/api/setupStep', { step: isCloud() ? 5 : 3 }), $('next')));
    wirePairing();
    wireCloudCode();
  } else if (step === 3) {
    wireBrainChooser(false);
    const nx = maybe('next');
    click(nx, () =>
      brainPick() === 'cloud'
        ? act(() => api('/api/setupStep', { step: others().length > 0 ? 2 : 5 }), nx)
        : act(() => api('/api/setupBrain', { device: brainPick() }), nx),
    );
  } else if (step === 4) {
    $input('ack').onchange = () => {
      $('next').setAttribute('aria-disabled', String(!$input('ack').checked));
      if ($input('ack').checked) $('err').innerHTML = '';
    };
    click($('next'), () => {
      if (!$input('ack').checked) {
        $('err').innerHTML =
          `<div class="note warn" role="alert">${I.warn}<div><p>Tick the box to confirm that the brain stays on.</p></div></div>`;
        return;
      }
      return act(() => api('/api/setupKeepOn', { ack: true }), $('next'));
    });
  } else if (step === 5) {
    click($('next'), async () => {
      const b = $button('next');
      b.disabled = true;
      try {
        await api('/api/setupFinish', {});
        location.href = '/';
      } catch (error) {
        b.disabled = false;
        showErr(errMsg(error));
      }
    });
    wireMoves();
    if (!O) void loadOutside();
  }
}
function wirePairing(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.pair'))
    click(b, async () => {
      const dev = b.dataset['dev'] ?? '';
      b.disabled = true;
      PAIR_ERR[dev] = undefined;
      try {
        PAIRS[dev] = await api<Pair>('/api/setupPair', { device: dev });
        state = await api('/api/setup');
      } catch (error) {
        PAIR_ERR[dev] = errMsg(error);
      }
      render();
    });
  for (const b of document.querySelectorAll<HTMLButtonElement>('.revoke'))
    click(b, () => {
      const dev = b.dataset['dev'] ?? '';
      if (confirm(`Disconnect ${dev}? It stops sending sessions until you connect it again.`))
        return act(() => api('/api/setupRevoke', { device: dev }), b);
      return undefined;
    });
}
function wireManage(): void {
  wirePairing();
  wireCloudCode();
  wireBrainChooser(true);
  click(maybe('add'), () => {
    ADDING = true;
    render();
    document.querySelector<HTMLElement>('#newdev .name')?.focus();
  });
  click(maybe('addcancel'), () => {
    ADDING = false;
    render();
  });
  click(maybe('addsave'), () => {
    const r = $('newdev');
    const add = { name: nameOf(r), os: checkedOs(r) };
    const list = others()
      .map((d) => ({ name: d.name, os: d.os }))
      .concat([add]);
    return act(async () => {
      const s = await api('/api/setupDevices', { devices: list });
      ADDING = false;
      return s;
    }, maybe('addsave'));
  });
  click(maybe('brainchange'), () => {
    CHANGING = true;
    PICK = null;
    render();
  });
  click(maybe('brainno'), () => {
    CHANGING = false;
    PICK = null;
    render();
  });
  click(maybe('brainyes'), async () => {
    const dev = document.querySelector<HTMLInputElement>('input[name=brain]:checked')?.value;
    const box = $('brainerr');
    if (!$input('ack').checked) {
      box.innerHTML = `<div class="note warn" role="alert">${I.warn}<div><p>Tick the box to confirm that the brain stays on.</p></div></div>`;
      return;
    }
    if (
      isCloud() &&
      !confirm(
        'Stop using your cloud brain? This panel forgets its link. Computers that joined the cloud brain keep sending to it, not to this computer.',
      )
    )
      return;
    const b = $button('brainyes');
    b.disabled = true;
    try {
      await api('/api/setupBrain', { device: dev });
      state = await api('/api/setupKeepOn', { ack: true });
      CHANGING = false;
      PICK = null;
      render();
    } catch (error) {
      b.disabled = false;
      box.innerHTML = errBox(errMsg(error));
    }
  });
}
function wireRows(): void {
  for (const b of document.querySelectorAll<HTMLElement>('.dev .rm'))
    b.onclick = () => {
      b.closest('.dev')?.remove();
    };
}
function wireMoves(): void {
  for (const b of document.querySelectorAll<HTMLElement>('.movein'))
    click(b, async () => {
      const sid = b.dataset['sid'] ?? '';
      MOVE[sid] = { state: 'moving' };
      renderStep5();
      try {
        await api('/api/setupMoveIn', { sid });
        MOVE[sid] = { state: 'done' };
      } catch (error) {
        MOVE[sid] = { state: 'error', msg: errMsg(error) };
      }
      renderStep5();
    });
}
async function loadOutside(): Promise<void> {
  try {
    const o = await api<Outside>('/api/setupOutside');
    // a moved session is no longer "outside": keep showing it, marked as moved
    for (const [sid, m] of Object.entries(MOVE)) {
      if (m?.state !== 'done' || !O || o.outside.some((r) => r.sid === sid)) continue;
      const r = O.outside.find((x) => x.sid === sid);
      if (r) o.outside.push(r);
    }
    O = o;
  } catch (error) {
    O = { error: errMsg(error), outside: [] };
  }
  renderStep5();
}
function renderStep5(): void {
  if (!state || state.done || welcome || state.step !== 5 || !maybe('outlist')) return;
  $('brainlist').innerHTML = brainList();
  $('outlist').innerHTML = outList();
  wireMoves();
}

function render(): void {
  renderRail();
  const s = S();
  const bad = s.checks.filter((c) => !c.ok && c.optional !== true); // an optional tool (Codex) is never a problem
  const probs =
    bad.length > 0
      ? `<div class="note bad probs" role="alert">${I.bad}<div><p class="t">${esc(s.local)} has ${plural(bad.length, 'problem')}: ${bad.map((c) => esc(c.title)).join(', ')}</p>
    <p>The panel cannot work fully until ${bad.length === 1 ? 'it is' : 'they are'} fixed. The cause and the fix are under "This computer". <button class="linkbtn" data-showchecks>Show the fix</button></p></div></div>`
      : '';
  let screen: () => string = screenWelcome;
  if (s.done) screen = screenDone;
  else if (!welcome) {
    const f = STEP_SCREEN[s.step];
    if (!f) throw new Error(`no screen for step ${n(s.step)}`);
    screen = f;
  }
  $('view').innerHTML = probs + screen();
  if (s.done) wireManage();
  else wire();
  setTimeout(autoFix, 400);
}

document.addEventListener('click', (e) => {
  if (!(e.target instanceof Element)) return;
  const t = e.target;
  const c = t.closest<HTMLElement>('[data-copy]');
  if (c) {
    void copy(c.dataset['copy'] ?? '', c);
    return;
  }
  const fx = t.closest<HTMLElement>('[data-fix]');
  if (fx) {
    void runFix(fx.dataset['fix'] ?? '');
    return;
  }
  const fc = t.closest<HTMLElement>('[data-fixcheck]');
  if (fc) {
    const id = fc.dataset['fixcheck'] ?? '';
    FIX.dismissed.delete(id);
    openFix(id);
    return;
  }
  if (t.closest('#fixclose')) {
    closeFix();
    return;
  }
  if (t.closest('#relink')) {
    closeFix();
    const i = maybe('link');
    if (i instanceof HTMLInputElement) {
      i.focus();
      i.select();
    }
    return;
  }
  const dc = t.closest<HTMLElement>('[data-decide]');
  if (dc) {
    const decision = dc.dataset['decide'];
    if (
      decision === 'revoke' &&
      !confirm(`Disconnect ${dc.dataset['name'] ?? ''}? It can no longer send sessions to your cloud brain.`)
    )
      return;
    void act(() => api('/api/setupCloudDevice', { id: dc.dataset['id'], decision }), dc);
    return;
  }
  const d = t.closest<HTMLElement>('[data-diag]');
  if (d) {
    void copyDiagnostics(d);
    return;
  }
  if (t.closest('[data-showchecks]')) {
    const det = document.querySelector<HTMLDetailsElement>('#checks details');
    if (det) {
      det.open = true;
      det.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    return;
  }
  const g = t.closest<HTMLElement>('[data-goto]');
  if (g) void act(() => api('/api/setupStep', { step: Number(g.dataset['goto']) }));
});
$('copyclose').onclick = () => {
  $dialog('copybox').close();
};

void (async function load() {
  try {
    const loaded = await api('/api/setup');
    state = loaded;
    welcome =
      !loaded.done &&
      loaded.step === 1 &&
      others().length === 0 &&
      store.get('cc-setup-welcomed') === null &&
      !/[?&]skipwelcome/.test(location.search);
    render();
  } catch (error) {
    $('checks').innerHTML = '';
    $('view').innerHTML = `<h2>The panel server is not answering</h2>
      <p class="lead">This page needs the Thoth server on this computer.</p>
      ${errBox(errMsg(error), 'No answer from the server')}
      <h3>Start it</h3><p>Open a terminal and run:</p>${cmdBlock('thoth web')}<p class="muted">Then reload this page.</p>
      <div class="nav"><span></span><button class="btn primary" id="reload">Reload</button></div>`;
    $('reload').addEventListener('click', () => {
      location.reload();
    });
  }
})();

// every 10 s: the checks (the user may be fixing something in a terminal)
setInterval(() => {
  if (!state) return;
  api('/api/setup')
    .then((s) => {
      S().checks = s.checks;
      S().keepOn = s.keepOn;
      renderChecks();
    })
    .catch(() => {
      /* keep */
    });
}, 10_000);
// step 2: watch for devices to connect
const cloudKey = (x: Setup): string => {
  const c = x.cloud;
  if (!c) return '';
  const lists = [c.pending, c.later, c.approved, c.ignored]
    .map((l) => (l ?? []).map((d) => `${d.id}:${n(d.sessions)}`).join(','))
    .join('|');
  return `${lists}${String(c.up)}:${JSON.stringify(c.self?.push ?? {})}:${String(c.self?.pushing)}`;
};
const devicesKey = (x: Setup): string =>
  x.devices
    .map((d) => `${d.name}:${String(d.connected)}:${String(d.sessions)}:${String(!!d.pairing)}:${String(d.lastSeen)}`)
    .join('|') + cloudKey(x);
setInterval(() => {
  if (!state || welcome || (!state.done && state.step !== 2) || ADDING || CHANGING) return;
  api('/api/setup')
    .then((s) => {
      // do not redraw under the user's typing (pre-approved code name, connect link)
      if (document.activeElement?.matches('#view input[type=text]') === true) return;
      if (devicesKey(s) !== devicesKey(S())) {
        state = s;
        render();
      }
    })
    .catch(() => {
      /* keep */
    });
}, 3000);
// step 5: refresh the session lists
setInterval(() => {
  if (state && !state.done && !welcome && state.step === 5 && !Object.values(MOVE).some((m) => m?.state === 'moving'))
    void loadOutside();
}, 6000);
// join code countdown
setInterval(() => {
  let expired = false;
  for (const el of document.querySelectorAll<HTMLElement>('[data-exp]')) {
    const x = Number(el.dataset['exp']);
    el.textContent = left(x);
    if (x < Date.now()) expired = true;
  }
  if (expired) render();
}, 1000);

// ---- test only: the screenshot scripts close the fix pop-up and draw made-up
// step-5 data. The names of a module are not globals, so this one object gives them exactly that.
interface SetupTestHooks {
  /** This computer's name (the setup state's `local`). */
  local: () => string;
  /** Dismiss every fix pop-up of the page and close the open one. */
  dismissFixes: () => void;
  /** Draw step 5 with these lists and move states instead of the server's. */
  showStep5: (outside: Outside, move: Record<string, Move>) => void;
}
declare global {
  interface Window {
    __thothSetupTest: SetupTestHooks;
  }
}
window.__thothSetupTest = {
  local: () => S().local,
  dismissFixes: () => {
    for (const x of allFixable()) FIX.dismissed.add(x.id ?? '');
    closeFix();
  },
  showStep5: (outside, move) => {
    O = outside;
    Object.assign(MOVE, move);
    renderStep5();
  },
};

export {};
