// Thinking labels, copied from the Claude app (claude.ai bundle, 2026-11):
// the live label changes with elapsed thinking time; a finished block reads
// "Thought for {seconds}s". Shared by the chat page and the unit tests.
(function (root) {
  const STEPS = [[60, 'Almost done thinking…'], [45, 'Thinking some more…'], [30, 'Thinking more…'], [15, 'Still thinking…']];
  function thinkingLabel(seconds) {
    for (const [min, text] of STEPS) if (seconds >= min) return text;
    return 'Thinking…';
  }
  function thoughtFor(seconds) { return `Thought for ${Math.max(1, Math.round(seconds))}s`; }
  // "Copy as quote": each line prefixed with "> "
  function asQuote(text) { return String(text).trim().split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'); }
  // the live spinner line while thinking, e.g. "Propagating… (12s · thinking with medium effort)"
  function liveThinkingSeconds(live) {
    const m = /\((?:(\d+)m\s*)?(\d+)s\b[^)]*thinking/i.exec(live || '');
    return m ? (Number(m[1] || 0) * 60 + Number(m[2])) : null;
  }
  // The Claude app keeps the "active" label at least 2 s, then shows the
  // finished label for 2 s more (VO = HO = 2000 ms in its bundle).
  const MIN_ACTIVE_MS = 2000, DONE_SHOW_MS = 2000;
  // One rough time per turn, e.g. "Worked for ~3 min" (not exact seconds per step).
  function roughDuration(secs) {
    if (!secs || secs < 60) return '<1 min';
    const min = Math.round(secs / 60);
    if (min < 60) return `~${min} min`;
    const h = Math.floor(min / 60), m = Math.round((min % 60) / 5) * 5;
    return m ? `~${h} h ${m} min` : `~${h} h`;
  }
  const api = { thinkingLabel, thoughtFor, asQuote, liveThinkingSeconds, roughDuration, MIN_ACTIVE_MS, DONE_SHOW_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
