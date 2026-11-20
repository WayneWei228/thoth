// Claude Code commands in the Ask box: the list under the box (CommandMenu.swift SuggestionList). The
// picker's rules and state are in commands.ts (makePicker); this file only draws the rows and turns
// mouse moves, clicks and keys into its calls.
import { makePicker } from './commands.js';
import type { Command, Picker, PickerDeps } from './commands.js';

export interface MenuParts extends Omit<PickerDeps, 'view' | 'text' | 'fetchList'> {
  text: HTMLTextAreaElement;
  list: HTMLElement; // holds .cmd-head and .cmd-scroll
}
export interface Menu {
  /** A key in the Ask box; true = the list used it (the box does not see it). */
  key: (e: KeyboardEvent) => boolean;
  /** The Ask box is about to send; true = do not send and keep the text (a command waits for its session). */
  sending: (text: string, files: string[]) => boolean;
  /** The text of the Ask box changed. */
  textChanged: () => void;
}

function part(root: ParentNode, s: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(s);
  if (!el) throw new Error(`missing ${s}`);
  return el;
}

async function fetchList(): Promise<Command[]> {
  // a cap, so a request that never ends cannot hold every later load (the server answers in about 8 s)
  const r = await fetch('/api/commands', { signal: AbortSignal.timeout(20_000) });
  const j = (await r.json()) as { commands?: unknown };
  return Array.isArray(j.commands) ? (j.commands as Command[]) : [];
}

export function makeCommandMenu(p: MenuParts): Menu {
  const head = part(p.list, '.cmd-head');
  const scroll = part(p.list, '.cmd-scroll');
  let rows: HTMLElement[] = [];
  // Where the mouse was when it last selected a row. A row that scrolls in under a mouse that did not
  // move must not take the selection from the arrow keys (CommandMenu.swift hover).
  let mouseAt = '';

  /** Scroll just enough to show row `i`, with a short smooth scroll. */
  function reveal(i: number): void {
    const r = rows[i];
    if (!r) return;
    const top = r.offsetTop;
    const bottom = top + r.offsetHeight;
    if (top < scroll.scrollTop) scroll.scrollTo({ top, behavior: 'smooth' });
    else if (bottom > scroll.scrollTop + scroll.clientHeight)
      scroll.scrollTo({ top: bottom - scroll.clientHeight, behavior: 'smooth' });
  }

  const picker: Picker = makePicker({
    ...p,
    text: () => p.text.value,
    fetchList,
    setText: (t) => {
      p.setText(t);
      p.text.focus();
    },
    view: {
      show(items, title) {
        head.textContent = title;
        p.list.setAttribute('aria-label', title);
        rows = items.map((it, i) => {
          const r = document.createElement('div');
          r.className = 'cmd-row';
          r.setAttribute('role', 'option');
          r.setAttribute('aria-selected', String(i === 0));
          r.dataset['testid'] = `home.commands.${String(i + 1)}`;
          r.title = it.detail === '' ? it.title : `${it.title}: ${it.detail}`;
          const t = document.createElement('span');
          t.className = 'cmd-title';
          t.textContent = it.title;
          const d = document.createElement('span');
          d.className = 'cmd-detail';
          d.textContent = it.detail;
          r.append(t, d);
          // the Ask box keeps the focus (and the keys)
          r.addEventListener('mousedown', (e) => {
            e.preventDefault();
          });
          r.addEventListener('click', () => {
            picker.pick(i);
          });
          r.addEventListener('mousemove', (e) => {
            const at = `${String(e.screenX)},${String(e.screenY)}`;
            if (at === mouseAt) return; // the row moved under the mouse, the mouse did not move
            mouseAt = at;
            picker.hover(i);
          });
          return r;
        });
        scroll.replaceChildren(...rows);
        scroll.scrollTop = 0;
        p.list.classList.toggle('hidden', items.length === 0);
      },
      hide() {
        rows = [];
        scroll.replaceChildren();
        p.list.classList.add('hidden');
      },
      select(i, show) {
        for (const [n, r] of rows.entries()) r.setAttribute('aria-selected', String(n === i));
        if (show) reveal(i);
      },
    },
  });

  return {
    key(e) {
      const used = picker.key({ key: e.key, shift: e.shiftKey, composing: e.isComposing });
      if (used) e.preventDefault();
      return used;
    },
    sending: picker.sending,
    textChanged: picker.textChanged,
  };
}
