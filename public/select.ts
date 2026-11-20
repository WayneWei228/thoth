// Sidebar select mode (MainWindow.swift SidebarViewController, "Select mode"): "Select" on the first
// session header, tick sessions (a click on the row or its check box), the bar at the bottom of the
// sidebar with "N selected", All/None, "Close N" and Done. Close N closes each ticked session as "Close"
// in its menu does (POST /api/close, no confirmation: the conversation is saved and can be resumed).
// No imports: a test imports this file directly.

/** The part of a session that select mode reads. */
export interface Pickable {
  id: string;
  name?: string;
  device?: string;
  state: string;
}

/** A helper computer's session cannot be closed from here yet (Session.isRemote): no check box. */
export const canTick = (s: Pickable): boolean => (s.device ?? '') === '';

export class SelectMode {
  selecting = false;
  checked = new Set<string>();
  /** AI tidy: the reason for each suggestion, shown under the name in select mode. */
  hints = new Map<string, string>();
  /** The sessions the AI ticked (not the user): only these are unticked when they start working. */
  aiTicked = new Set<string>();

  setSelecting(on: boolean, checked: Iterable<string> = []): void {
    this.selecting = on;
    this.checked = on ? new Set(checked) : new Set();
    if (!on) {
      this.hints = new Map();
      this.aiTicked = new Set();
    }
  }

  toggle(id: string): void {
    if (!this.checked.delete(id)) this.checked.add(id);
    this.aiTicked.delete(id); // the user decided this one now
  }

  /** "All" ticks every session of this computer; "None" (when all are ticked) unticks them. */
  checkAll(list: Pickable[]): void {
    const ids = list.filter(canTick).map((s) => s.id);
    const all = ids.length === this.checked.size && ids.every((id) => this.checked.has(id));
    this.checked = all ? new Set() : new Set(ids);
    this.aiTicked = new Set(); // the user's choice now
  }

  /** On each new state: a session that closed is no longer ticked; with no session left select mode
   * ends; a session the AI ticked that started working or asks for the user is unticked. */
  reload(list: Pickable[]): void {
    const ids = new Set(list.map((s) => s.id));
    for (const id of this.checked) if (!ids.has(id)) this.checked.delete(id);
    if (this.selecting && !list.some(canTick)) this.setSelecting(false); // nothing left to tick
    for (const s of list)
      if (this.aiTicked.has(s.id) && (s.state === 'working' || s.state === 'needs')) {
        this.checked.delete(s.id);
        this.aiTicked.delete(s.id);
      }
  }

  barText(): string {
    const n = this.checked.size;
    if (n > 0) return `${String(n)} selected`;
    return this.hints.size === 0 ? 'Tick sessions to close' : 'AI: nothing to close';
  }

  closeTitle(): string {
    const n = this.checked.size;
    return n === 0 ? 'Close' : `Close ${String(n)}`;
  }

  allTitle(list: Pickable[]): string {
    const n = this.checked.size;
    return n > 0 && n === list.filter(canTick).length ? 'None' : 'All';
  }
}

/** The ids Close N closes: the ticked sessions of this computer that are still listed. */
export const closeIds = (list: Pickable[], sel: SelectMode): string[] =>
  list.filter((s) => canTick(s) && sel.checked.has(s.id)).map((s) => s.id);

/** Arrow keys in select mode: the nearest row that can be ticked after (dir 1) or before (-1) the current
 * row; stays at the ends. With no current row, Down starts at the first such row and Up at the last. */
export function nextRow(rows: { id: string; tick: boolean }[], current: string | null, dir: 1 | -1): string | null {
  const i = current === null ? -1 : rows.findIndex((r) => r.id === current);
  const ticks = rows.filter((r) => r.tick);
  if (i < 0) return (dir === 1 ? ticks[0] : ticks.at(-1))?.id ?? null;
  for (let j = i + dir; j >= 0 && j < rows.length; j += dir) if (rows[j]?.tick === true) return rows[j]?.id ?? null;
  return rows[i]?.tick === true ? current : null;
}

// ---------- DOM (called by app.ts; nothing here runs on import) ----------

export interface SelectHooks {
  sessions: () => Pickable[];
  render: () => void;
  close: (ids: string[]) => void;
}

/** The bar at the bottom of the sidebar (sidebar.selectBar): label, All, Close N, Done. */
export function mountBar(sel: SelectMode, hooks: SelectHooks): { update: () => void } {
  const bar = document.createElement('div');
  bar.id = 'select-bar';
  bar.className = 'select-bar hidden';
  bar.dataset['testid'] = 'sidebar.selectBar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Select sessions');
  const lbl = document.createElement('span');
  lbl.className = 'sb-label';
  lbl.setAttribute('aria-live', 'polite');
  const mk = (text: string, testid: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small';
    b.textContent = text;
    b.dataset['testid'] = testid;
    b.addEventListener('click', fn);
    return b;
  };
  const all = mk('All', 'sidebar.selectAll', () => {
    sel.checkAll(hooks.sessions());
    hooks.render();
  });
  const close = mk('Close', 'sidebar.closeSelected', () => {
    const ids = closeIds(hooks.sessions(), sel);
    sel.setSelecting(false);
    hooks.close(ids);
    hooks.render();
    focusSelect();
  });
  const done = mk('Done', 'sidebar.selectDone', () => {
    sel.setSelecting(false);
    hooks.render();
    focusSelect();
  });
  bar.append(lbl, all, close, done);
  document.querySelector('#sidebar')?.append(bar);
  return {
    update: (): void => {
      bar.classList.toggle('hidden', !sel.selecting);
      lbl.textContent = sel.barText();
      close.textContent = sel.closeTitle();
      close.disabled = sel.checked.size === 0;
      all.textContent = sel.allTitle(hooks.sessions());
    },
  };
}

/** The bar hides after Done / Close N: the keyboard focus goes to Select on the header. */
function focusSelect(): void {
  document.querySelector<HTMLElement>('#rows .side-h-btn')?.focus();
}

/** "Select" / "Done" on the first session header (sidebar.select). */
export function headerButton(sel: SelectMode, hooks: SelectHooks): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'side-h-btn';
  b.textContent = sel.selecting ? 'Done' : 'Select';
  b.dataset['testid'] = 'sidebar.select';
  b.addEventListener('click', () => {
    sel.setSelecting(!sel.selecting);
    hooks.render();
  });
  return b;
}

/** A session row in select mode: a check box in place of the status dot; a click ticks (role checkbox,
 * so Space ticks too and screen readers say checked / not checked). A helper's session keeps its dot
 * and a click does nothing. */
export function asCheckRow(b: HTMLButtonElement, s: Pickable, sel: SelectMode): void {
  b.classList.remove('sel'); // select mode: no row is highlighted
  if (!canTick(s)) {
    b.classList.add('no-tick');
    return;
  }
  const on = sel.checked.has(s.id);
  b.setAttribute('role', 'checkbox');
  b.setAttribute('aria-checked', String(on));
  b.classList.add('ticking');
  const box = document.createElement('span');
  box.className = 'tick' + (on ? ' on' : '');
  box.dataset['testid'] = `select.${s.name ?? s.id}`;
  box.setAttribute('aria-hidden', 'true');
  b.querySelector('.dot')?.replaceWith(box);
  const hint = sel.hints.get(s.id);
  if (hint !== undefined && hint !== '') {
    let sub = b.querySelector<HTMLElement>('.sub');
    if (!sub) {
      sub = document.createElement('span');
      sub.className = 'sub';
      b.querySelector('.rt')?.append(sub);
      b.classList.add('tall');
    }
    sub.textContent = hint;
    sub.classList.add(on ? 'hint-close' : 'hint-keep');
  }
}

/** A click on a session row in select mode: tick it. Returns true when select mode took the click. */
export function rowClick(s: Pickable, sel: SelectMode, hooks: SelectHooks): boolean {
  if (!sel.selecting) return false;
  if (canTick(s)) {
    sel.toggle(s.id);
    hooks.render(); // render() keeps the focus on this row
  }
  return true;
}

/** Up / Down in the session list while selecting: move the focus over the rows that can be ticked. */
export function onRowsKey(e: KeyboardEvent, sel: SelectMode): void {
  if (!sel.selecting || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
  const els = [...document.querySelectorAll<HTMLElement>('#rows .row')];
  const rows = els.map((r) => ({ id: r.dataset['id'] ?? '', tick: r.classList.contains('ticking') }));
  const now = document.activeElement instanceof HTMLElement ? (document.activeElement.dataset['id'] ?? null) : null;
  const next = nextRow(rows, now, e.key === 'ArrowDown' ? 1 : -1);
  const el = els[rows.findIndex((r) => r.id === next)];
  if (!el) return;
  e.preventDefault();
  el.focus();
}
