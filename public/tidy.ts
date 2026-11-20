// AI tidy in the web panel (MainWindow.swift SidebarViewController.tidy): "Tidy" left of "Select" on the
// first session header. POST /api/tidy (lib/tidy.ts) asks the AI which sessions are one-off tasks that
// are done; select mode (public/select.ts) ticks them with the reason under each name; the user confirms
// with "Close N". A session the AI ticked that starts working or asks the user is unticked
// (SelectMode.reload). Nothing runs on import: a test imports this file directly.
import type { SelectMode } from './select.js';

/** One decision of the server's answer (lib/tidy.ts TidyDecision). */
interface TidyDecision {
  id?: unknown;
  close?: unknown;
  reason?: unknown;
}

export interface TidyPick {
  /** the sessions to tick (the AI says close) */
  close: Set<string>;
  /** id -> the reason shown under the name in select mode */
  hints: Map<string, string>;
}

/** The answer of POST /api/tidy -> the ticks and the reasons (MainWindow.swift tidy()). */
export function pick(answer: unknown): TidyPick {
  const close = new Set<string>();
  const hints = new Map<string, string>();
  const list = (answer as { sessions?: unknown } | null | undefined)?.sessions;
  for (const d of Array.isArray(list) ? (list as (TidyDecision | null)[]) : []) {
    if (!d || typeof d.id !== 'string') continue;
    if (typeof d.reason === 'string' && d.reason !== '') hints.set(d.id, d.reason);
    if (d.close === true) close.add(d.id);
  }
  return { close, hints };
}

/** Select mode with the AI's suggestion: its picks ticked (and remembered as the AI's), its reasons shown.
 * Ticks the user made by hand while the AI worked stay ticked and stay the user's (not unticked when the
 * session starts working). */
export function applyPick(sel: SelectMode, p: TidyPick): void {
  const hand = sel.selecting ? [...sel.checked] : [];
  sel.setSelecting(true, [...hand, ...p.close]);
  sel.hints = p.hints;
  sel.aiTicked = new Set([...p.close].filter((id) => !hand.includes(id)));
}

export interface TidyHooks {
  /** POST /api/tidy; rejects after the error is shown */
  ask: () => Promise<unknown>;
  render: () => void;
}

let tidying = false;
export const isTidying = (): boolean => tidying;

/** The Tidy click: "Tidying…" until the AI answers, then select mode with its picks; back to "Tidy" on an
 * error. null when a tidy is already on the way (a second click does nothing). */
export function startTidy(sel: SelectMode, hooks: TidyHooks): Promise<void> | null {
  if (tidying) return null;
  tidying = true;
  hooks.render();
  return hooks
    .ask()
    .then((answer) => {
      applyPick(sel, pick(answer));
    })
    .catch(() => {
      /* the error is shown as a toast */
    })
    .finally(() => {
      tidying = false;
      hooks.render();
    });
}

// ---------- DOM (called by app.ts) ----------

/** "Tidy" / "Tidying…" on the first session header (sidebar.tidy), left of Select / Done. */
export function tidyButton(sel: SelectMode, hooks: TidyHooks): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'side-h-tidy'; // not side-h-btn: Select's focus code looks for that one
  b.textContent = tidying ? 'Tidying…' : 'Tidy';
  b.disabled = tidying;
  b.title = 'AI suggests which sessions to close (one-off tasks that are done)';
  b.dataset['testid'] = 'sidebar.tidy';
  b.addEventListener('click', () => {
    void startTidy(sel, hooks)?.then(() => {
      // the header was rebuilt: the keyboard place goes back to Tidy (it was lost while disabled)
      const focused = document.activeElement;
      if (focused === null || focused === document.body)
        document.querySelector<HTMLElement>('#rows .side-h-tidy')?.focus();
    });
  });
  return b;
}
