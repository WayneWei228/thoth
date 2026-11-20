// Thinking labels, copied from the Claude app (claude.ai bundle, 2026-11):
// the live label changes with elapsed thinking time; a finished block reads
// "Thought for {seconds}s". Shared by the chat page (public/chat.ts) and the unit tests.

const STEPS: readonly (readonly [number, string])[] = [
  [60, 'Almost done thinking…'],
  [45, 'Thinking some more…'],
  [30, 'Thinking more…'],
  [15, 'Still thinking…'],
];

export function thinkingLabel(seconds: number): string {
  for (const [min, text] of STEPS) if (seconds >= min) return text;
  return 'Thinking…';
}

export function thoughtFor(seconds: number): string {
  return `Thought for ${String(Math.max(1, Math.round(seconds)))}s`;
}

// "Copy as quote": each line prefixed with "> "
export function asQuote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n');
}

// the live spinner line while thinking, e.g. "Propagating… (12s · thinking with medium effort)"
export function liveThinkingSeconds(live: string | null | undefined): number | null {
  const m = /\((?:(\d+)m\s*)?(\d+)s\b[^)]*thinking/i.exec(live ?? '');
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : null;
}

// The Claude app keeps the "active" label at least 2 s, then shows the
// finished label for 2 s more (VO = HO = 2000 ms in its bundle).
export const MIN_ACTIVE_MS = 2000;
export const DONE_SHOW_MS = 2000;

// One rough time per turn, e.g. "Worked for ~3 min" (not exact seconds per step).
export function roughDuration(secs: number | null | undefined): string {
  if (secs === null || secs === undefined || secs < 60) return '<1 min';
  const min = Math.round(secs / 60);
  if (min < 60) return `~${String(min)} min`;
  const h = Math.floor(min / 60),
    m = Math.round((min % 60) / 5) * 5;
  return m ? `~${String(h)} h ${String(m)} min` : `~${String(h)} h`;
}
