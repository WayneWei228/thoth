// Screen parser: turns the text of a Claude Code pane into a state.
// Pure function, no I/O, so it can be tested against saved screens
// When Claude Code changes its screen text,
// those tests fail first.

// an ANSI escape sequence: ESC [ parameters letter
const ESC = String.fromCodePoint(27);
export const ANSI = new RegExp(String.raw`${ESC}\[[\d;?]*[A-Za-z]`, 'g');

export interface MenuOption {
  n: number;
  label: string;
}

export interface ScreenState {
  state: 'needs' | 'working' | 'idle' | 'starting';
  last: string;
  options: MenuOption[];
  selected: number;
  question: string;
  live: string;
}

const at0 = (lines: readonly string[], i: number): string => lines[i] ?? '';

export function parseScreen(text: string): ScreenState {
  const lines = text.replace(ANSI, '').split('\n');
  while (lines.length > 0 && !at0(lines, lines.length - 1).trim()) lines.pop();
  const tail = lines.slice(-30);
  const tailText = tail.join('\n');

  // choice menu near the bottom: a "❯ option" line plus sibling lines at the same
  // indent (numbered or not). The input box ("❯ " between ─ rules) has no siblings.
  // AskUserQuestion shows a description of several lines under each option, so its menu
  // can start 20+ lines above the bottom: look in the last 60 lines.
  const menu = lines.slice(-60);
  const options: MenuOption[] = [];
  let selected = -1;
  let question = '';
  let at = -1;
  let end = -1; // the menu's last line
  for (let i = menu.length - 1; i >= 0; i--) {
    if (/^[\s│]*❯ \S/.test(at0(menu, i))) {
      at = i;
      break;
    }
  }
  if (at >= 0) {
    const col = at0(menu, at).indexOf('❯');
    const isOpt = (l: string): boolean =>
      l.length > col + 2 &&
      /^[\s│]*$/.test(l.slice(0, col)) &&
      (l[col] === '❯' || l[col] === ' ') &&
      l[col + 1] === ' ' &&
      /\S/.test(l[col + 2] ?? '');
    // A long option wraps onto lines that are indented deeper than its text
    // (seen in the permission prompt). Those lines continue the option above.
    const isCont = (l: string): boolean =>
      l.length > col + 3 && /^[\s│]*$/.test(l.slice(0, col + 3)) && /\S/.test(l.slice(col + 3));
    const inMenu = (l: string): boolean => isOpt(l) || isCont(l);
    // AskUserQuestion puts its last option ("Chat about this") below a ─ rule: a rule between
    // menu lines is part of the menu
    const isRule = (l: string): boolean => /^\s*─{3,}\s*$/.test(l);
    let a = at,
      b = at;
    while (a - 1 >= 0 && (inMenu(at0(menu, a - 1)) || (isRule(at0(menu, a - 1)) && inMenu(at0(menu, a - 2))))) a--;
    while (a < at && !isOpt(at0(menu, a))) a++; // a menu starts with an option, not a continuation
    while (b + 1 < menu.length && (inMenu(at0(menu, b + 1)) || (isRule(at0(menu, b + 1)) && isOpt(at0(menu, b + 2)))))
      b++;
    end = b;
    const clean = (l: string): string => l.replaceAll('│', ' ').replaceAll(/\s+/g, ' ').trim();
    const heads: string[] = []; // each option's own line, without the lines below it
    for (let i = a; i <= b; i++) {
      const line = at0(menu, i);
      const prev = options.at(-1);
      if (isRule(line)) continue;
      if (isOpt(line)) {
        const head = clean(line.slice(col + 2)).replace(/^\d+\.\s+/, '');
        options.push({ n: options.length + 1, label: head });
        heads.push(head);
        if (i === at) selected = options.length;
      } else if (prev) {
        prev.label += ' ' + clean(line);
      }
    }
    // AskUserQuestion: the question is the bordered block ("│ …" lines) just above the menu,
    // often on several lines; it is the question as a whole.
    let q0 = a - 1;
    while (q0 >= 0 && !at0(menu, q0).trim()) q0--;
    const boxed: string[] = [];
    for (let i = q0; i >= 0 && /^\s*│/.test(at0(menu, i)); i--) boxed.unshift(clean(at0(menu, i)));
    // a wrapped line goes on without a space when either side is non-ASCII (CJK has no spaces between words)
    const joinWrapped = (x: string, y: string): string =>
      /\P{ASCII}$/u.test(x) || /^\P{ASCII}/u.test(y) ? x + y : `${x} ${y}`;
    if (options.length >= 2 && boxed.length > 0) {
      question = boxed.reduce(joinWrapped);
      // the lines under an AskUserQuestion option are its description, not a wrapped label
      for (const [i, o] of options.entries()) o.label = heads[i] ?? o.label;
    } else if (options.length >= 2) {
      for (let i = a - 1; i >= Math.max(0, a - 10); i--) {
        const q = at0(menu, i)
          .replaceAll(/[│╭╰─]/g, '')
          .trim();
        // the first sentence that asks ("Quick safety check: Is this … trust? (Like your …" → up to the "?")
        if (q && /\?|Do you|Allow|want/i.test(q)) {
          question = q.replace(/^(.*?\?)\s.*$/, '$1');
          break;
        }
      }
    }
  }
  // A real Claude Code menu always has a key hint just below it ("Enter to confirm ·
  // Esc to cancel", "Esc to cancel · Tab to amend"). A queued message ("❯ text" plus a
  // wrapped line, then "ctrl+x ctrl+s to send now") looks like a menu without one.
  let hinted = false;
  if (options.length > 0) {
    // below the menu's last line: AskUserQuestion puts a rule and "Chat about this" between
    for (let i = at + 1; i < Math.min(menu.length, end + 6); i++) {
      if (/Esc to cancel|Enter to confirm|Enter to select|to navigate/i.test(at0(menu, i))) {
        hinted = true;
        break;
      }
    }
  }
  // A real menu replaces the input box. A "❯" block above the input box ("❯" + NBSP)
  // is a message in the history (a sent or queued message), never a menu, even when a
  // status line below it happens to read like a key hint ("… · Esc to cancel").
  const aboveInput = at >= 0 && menu.slice(at + 1).some((l) => /^[\s│]*❯\u00A0/.test(l));
  const validMenu = options.length >= 2 && selected > 0 && hinted && !aboveInput;

  // Where to look for "working" signs. With an input box on screen, the spinner line is one
  // of the last few non-blank lines just above the box's top rule. Text higher up is a reply
  // or a message, and a reply can quote "esc to interrupt" or a spinner line.
  let zone = tail;
  const boxAt = tail.findLastIndex((l) => /^[\s│]*❯\u00A0/.test(l));
  if (boxAt > 0 && /^─{10,}/.test(at0(tail, boxAt - 1).trim())) {
    zone = tail
      .slice(0, boxAt - 1)
      .filter((l) => l.trim())
      .slice(-5);
  }
  // Spinner and "esc to interrupt" lines start at column 0. Reply and message text is indented.
  const zoneText = zone.filter((l) => /^\S/.test(l)).join('\n');

  // the live spinner line while Claude works, e.g. "✳ Zigzagging… (8s · ↓ 237 tokens)"
  const SPIN = /^(\S)\s+(\S[^\n]*…\s*\((?:[^()\n]*?\s)?(?:\d+h\s*)?(?:\d+m\s*)?\d+s\b[^\n]*\))/; // \"(8s · …)\" or \"(running … hook · 14s)\"
  let live = '';
  for (let i = zone.length - 1; i >= 0; i--) {
    const line = at0(zone, i);
    if (!/^\S/.test(line)) continue; // the spinner starts at column 0; reply text is indented
    const m = SPIN.exec(line.trim());
    if (m) {
      live = (m[2] ?? '').replaceAll(/\s+/g, ' ').trim();
      break;
    }
  }

  // The text fallback ("Do you want to…") counts only when there is no input box. A real
  // prompt replaces the input box; with the box on screen, the words are part of a reply
  // or a message (for example a reply that quotes these rules) and Claude is not waiting.
  const inputBox = tail.some((l) => /^[\s│]*❯\u00A0/.test(l));
  const promptText = !inputBox && /Do you want to|Enter to confirm · Esc/i.test(tailText);

  // Claude's input box: a "❯" line plus the ─ rules around it. Without it, Claude has not drawn its
  // screen yet (it is still starting, or hangs at start) and cannot read keys. Such a screen is
  // 'starting', not 'idle': text typed into it waits in the terminal and goes to the shell when
  // Claude exits, where zsh runs it (2026-11-17: a handoff prompt ran `bin/thoth restart`).
  const hasBox = /─{10,}/.test(tailText) && tail.some((l) => /^[\s│─]*❯/.test(l));

  let state: ScreenState['state'];
  if (validMenu || promptText) state = 'needs';
  else if (
    /esc to interrupt|ctrl\+c to interrupt/i.test(zoneText) ||
    /^\S\s+\S[^\n]*…\s*\((?:[^()\n]*?\s)?(\d+h\s*)?(\d+m\s*)?\d+s\b/m.test(zoneText)
  )
    state = 'working';
  else if (!hasBox) state = 'starting';
  else state = 'idle';

  // last Claude reply line (⏺ ...)
  let last = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = at0(lines, i).trim();
    if (l.startsWith('⏺')) {
      last = l.replace(/^⏺\s*/, '');
      break;
    }
  }
  return {
    state,
    last,
    options: validMenu ? options.map(({ n, label }) => ({ n, label })) : [],
    selected,
    question,
    live: state === 'working' ? live : '',
  };
}

// The input box of Claude Code, from the screen: the text after "❯ " between the two rules.
export function inputBoxText(screen: string): string {
  // A window made narrower and wider again (a remote client's terminal view resizes it) leaves rows
  // marked as wrapped, so `capture-pane -J` joins a rule with the line below or above it
  // ("──── ❯ text"). Put each rule back on its own line.
  const lines = screen
    .replace(ANSI, '')
    .replaceAll(/[ \t]*(─{10,})[ \t]*/g, '\n$1\n')
    .split('\n');
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^─{10,}/.test(at0(lines, i).trim())) {
      end = i;
      break;
    }
  }
  if (end < 0) return '';
  let start = -1;
  for (let i = end - 1; i >= 0; i--) {
    if (/^─{10,}/.test(at0(lines, i).trim())) {
      start = i;
      break;
    }
  }
  if (start < 0) return '';
  const text = lines
    .slice(start + 1, end)
    .join(' ')
    .replace(/^\s*❯\s?/, '')
    .trim();
  // an empty box shows a dim placeholder hint such as: Try "write a test for <filepath>"
  return /^Try ".*"$/.test(text) ? '' : text;
}

/**
 * Text in Claude Code's input box that was typed (or pasted) but never sent, from `tmux capture-pane
 * -p -e` (with the escape codes, without -J), or ''. When the box is empty, Claude Code shows a prompt
 * suggestion there in dim text (ESC[2m); that is not a draft. The box is the part between the last two
 * rules; its text starts after "❯ ". A draft has at least one character that is not dim.
 */
export function draftText(screen: string): string {
  // OSC sequences (hyperlinks: ESC ] … ESC \ or BEL) carry no text
  const text = screen.replaceAll(new RegExp(String.raw`${ESC}\][^\u0007${ESC}]*(?:\u0007|${ESC}\\)`, 'g'), '');
  const sgr = new RegExp(String.raw`${ESC}\[([\d;:]*)m|${ESC}\[[\d;?]*[A-Za-z]`, 'y');
  // every line as characters with their dim flag (tmux carries the attributes across lines)
  const lines: { ch: string; dim: boolean }[][] = [[]];
  let dim = false;
  for (let i = 0; i < text.length;) {
    sgr.lastIndex = i;
    const m = sgr.exec(text);
    if (m) {
      const params = (m[1] ?? 'x').split(';');
      for (let k = 0; k < params.length; k++) {
        const p = params[k] ?? '';
        if (p === '' || p === '0' || p === '22') dim = false;
        else if (p === '2') dim = true;
        else if (/^[345]8$/.test(p)) k += params[k + 1] === '5' ? 2 : params[k + 1] === '2' ? 4 : 0; // a colour, not attributes
      }
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(text.codePointAt(i) ?? 0);
    if (ch === '\n') lines.push([]);
    else lines.at(-1)?.push({ ch, dim });
    i += ch.length;
  }
  const plain = lines.map((l) => l.map((c) => c.ch).join(''));
  const rules = plain.flatMap((l, i) => (/^─{10,}/.test(l.trim()) ? [i] : []));
  const end = rules.at(-1) ?? -1;
  const start = rules.at(-2) ?? -1;
  if (start < 0) return '';
  const cells = lines.slice(start + 1, end).flatMap((l, i) => (i ? [{ ch: ' ', dim: false }, ...l] : l));
  const at = cells.findIndex((c) => c.ch === '❯');
  if (at < 0) return '';
  const rest = cells.slice(at + 1);
  if (!rest.some((c) => !c.dim && c.ch.trim() !== '')) return '';
  return rest
    .map((c) => c.ch)
    .join('')
    .replaceAll(/\s+/g, ' ')
    .trim();
}
