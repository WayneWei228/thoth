// Screen parser: turns the text of a Claude Code pane into a state.
// Pure function, no I/O, so it can be tested against saved screens
// When Claude Code changes its screen text,
// those tests fail first.
'use strict';

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function parseScreen(text) {
  const lines = text.replace(ANSI, '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const tail = lines.slice(-30);
  const tailText = tail.join('\n');

  // choice menu near the bottom: a "❯ option" line plus sibling lines at the same
  // indent (numbered or not). The input box ("❯ " between ─ rules) has no siblings.
  const options = [];
  let selected = -1;
  let question = '';
  let at = -1;
  for (let i = tail.length - 1; i >= Math.max(0, tail.length - 14); i--) {
    if (/^[\s│]*❯ \S/.test(tail[i])) { at = i; break; }
  }
  if (at >= 0) {
    const col = tail[at].indexOf('❯');
    const isOpt = (l) => l.length > col + 2 && /^[\s│]*$/.test(l.slice(0, col)) &&
      (l[col] === '❯' || l[col] === ' ') && l[col + 1] === ' ' && /\S/.test(l[col + 2]);
    // A long option wraps onto lines that are indented deeper than its text
    // (seen in the permission prompt). Those lines continue the option above.
    const isCont = (l) => l.length > col + 3 && /^[\s│]*$/.test(l.slice(0, col + 3)) && /\S/.test(l.slice(col + 3));
    const inMenu = (l) => isOpt(l) || isCont(l);
    let a = at, b = at;
    while (a - 1 >= 0 && inMenu(tail[a - 1])) a--;
    while (a < at && !isOpt(tail[a])) a++; // a menu starts with an option, not a continuation
    while (b + 1 < tail.length && inMenu(tail[b + 1])) b++;
    const clean = (l) => l.replace(/│/g, ' ').replace(/\s+/g, ' ').trim();
    for (let i = a; i <= b; i++) {
      if (isOpt(tail[i])) {
        options.push({ n: options.length + 1, label: clean(tail[i].slice(col + 2)).replace(/^\d+\.\s+/, '') });
        if (i === at) selected = options.length;
      } else if (options.length) {
        options[options.length - 1].label += ' ' + clean(tail[i]);
      }
    }
    if (options.length >= 2) {
      for (let i = a - 1; i >= Math.max(0, a - 10); i--) {
        const q = tail[i].replace(/[│╭╰─]/g, '').trim();
        // the first sentence that asks ("Quick safety check: Is this … trust? (Like your …" → up to the "?")
        if (q && /\?|Do you|Allow|want/i.test(q)) { question = q.replace(/^(.*?\?)\s.*$/, '$1'); break; }
      }
    }
  }
  // A real Claude Code menu always has a key hint just below it ("Enter to confirm ·
  // Esc to cancel", "Esc to cancel · Tab to amend"). A queued message ("❯ text" plus a
  // wrapped line, then "ctrl+x ctrl+s to send now") looks like a menu without one.
  let hinted = false;
  if (options.length) {
    for (let i = at + 1; i < Math.min(tail.length, at + 2 + options.length + 4); i++) {
      if (/Esc to cancel|Enter to confirm|Enter to select|to navigate/i.test(tail[i])) { hinted = true; break; }
    }
  }
  // A real menu replaces the input box. A "❯" block above the input box ("❯" + NBSP)
  // is a message in the history (a sent or queued message), never a menu, even when a
  // status line below it happens to read like a key hint ("… · Esc to cancel").
  const aboveInput = at >= 0 && tail.slice(at + 1).some((l) => /^[\s│]*❯\u00a0/.test(l));
  const validMenu = options.length >= 2 && selected > 0 && hinted && !aboveInput;

  // Where to look for "working" signs. With an input box on screen, the spinner line is one
  // of the last few non-blank lines just above the box's top rule. Text higher up is a reply
  // or a message, and a reply can quote "esc to interrupt" or a spinner line.
  let zone = tail;
  const boxAt = tail.findLastIndex((l) => /^[\s│]*❯ /.test(l));
  if (boxAt > 0 && /^─{10,}/.test(tail[boxAt - 1].trim())) {
    zone = tail.slice(0, boxAt - 1).filter((l) => l.trim()).slice(-5);
  }
  // Spinner and "esc to interrupt" lines start at column 0. Reply and message text is indented.
  const zoneText = zone.filter((l) => /^\S/.test(l)).join('\n');

  // the live spinner line while Claude works, e.g. "✳ Zigzagging… (8s · ↓ 237 tokens)"
  const SPIN = /^(\S)\s+(\S[^\n]*…\s*\((?:[^()\n]*?\s)?(?:\d+h\s*)?(?:\d+m\s*)?\d+s\b[^\n]*\))/;  // \"(8s · …)\" or \"(running … hook · 14s)\"
  let live = '';
  for (let i = zone.length - 1; i >= 0; i--) {
    if (!/^\S/.test(zone[i])) continue; // the spinner starts at column 0; reply text is indented
    const m = zone[i].trim().match(SPIN);
    if (m) { live = m[2].replace(/\s+/g, ' ').trim(); break; }
  }

  // The text fallback ("Do you want to…") counts only when there is no input box. A real
  // prompt replaces the input box; with the box on screen, the words are part of a reply
  // or a message (for example a reply that quotes these rules) and Claude is not waiting.
  const inputBox = tail.some((l) => /^[\s│]*❯ /.test(l));
  const promptText = !inputBox && /Do you want to|Enter to confirm · Esc/i.test(tailText);

  let state;
  if (validMenu || promptText) state = 'needs';
  else if (/esc to interrupt|ctrl\+c to interrupt/i.test(zoneText) || /^\S\s+\S[^\n]*…\s*\((?:[^()\n]*?\s)?(\d+h\s*)?(\d+m\s*)?\d+s\b/m.test(zoneText)) state = 'working';
  else state = 'idle';

  // last Claude reply line (⏺ ...)
  let last = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l.startsWith('⏺')) { last = l.replace(/^⏺\s*/, ''); break; }
  }
  return { state, last, options: validMenu ? options.map(({ n, label }) => ({ n, label })) : [], selected, question,
    live: state === 'working' ? live : '' };
}

// The input box of Claude Code, from the screen: the text after "❯ " between the two rules.
function inputBoxText(screen) {
  const lines = screen.replace(ANSI, '').split('\n');
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) { if (/^─{10,}/.test(lines[i].trim())) { end = i; break; } }
  if (end < 0) return '';
  let start = -1;
  for (let i = end - 1; i >= 0; i--) { if (/^─{10,}/.test(lines[i].trim())) { start = i; break; } }
  if (start < 0) return '';
  const text = lines.slice(start + 1, end).join(' ').replace(/^\s*❯\s?/, '').trim();
  // an empty box shows a dim placeholder hint such as: Try "write a test for <filepath>"
  return /^Try ".*"$/.test(text) ? '' : text;
}

module.exports = { parseScreen, ANSI, inputBoxText };
