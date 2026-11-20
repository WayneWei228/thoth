// The web panel's page rules that need no DOM (app.ts uses them; a test tests them).

/** A page of the panel, as MainWindow.swift Page: #/home #/sessions #/devices #/session/<id>. */
export type Page = { name: 'home' | 'sessions' | 'devices' } | { name: 'session'; id: string };
export const PAGES = ['home', 'sessions', 'devices'] as const;
export const HASH_RE = /^#\/(home|sessions|devices|session\/(.+))$/;

export const isPage = (p: string | undefined): p is (typeof PAGES)[number] => PAGES.some((x) => x === p);

export function hashFor(p: Page): string {
  // tmux window ids start with @: keep it readable in the address bar
  return p.name === 'session' ? '#/session/' + encodeURIComponent(p.id).replaceAll('%40', '@') : `#/${p.name}`;
}

export function parseHash(hash: string): Page {
  const m = HASH_RE.exec(hash);
  if (!m) return { name: 'home' };
  if (m[2] !== undefined) {
    try {
      return { name: 'session', id: decodeURIComponent(m[2]) };
    } catch {
      return { name: 'home' }; // a broken %-escape
    }
  }
  return isPage(m[1]) ? { name: m[1] } : { name: 'home' };
}

/** "Choose…" opens a macOS folder dialog on the server's screen: offered when the server runs on macOS
 * (or before the state said which system it runs on). */
export const canChooseFolder = (platform: string): boolean => platform === '' || platform === 'darwin';

const STATES = new Set(['needs', 'working', 'idle', 'stopped', 'elsewhere']);
/** A session state that is safe as a CSS class name: one of the known states, else "idle". */
export const stateClass = (state: string): string => (STATES.has(state) ? state : 'idle');
