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

const STATES = new Set(['needs', 'working', 'starting', 'idle', 'stopped', 'elsewhere']);
/** A session state that is safe as a CSS class name: one of the known states, else "idle". */
// a new session on a helper (lib/remote_new.ts): preparing looks like working, failed like needs
const LOOKS: Record<string, string> = { preparing: 'working', failed: 'needs' };
export const stateClass = (state: string): string => LOOKS[state] ?? (STATES.has(state) ? state : 'idle');

/** "Fetch result" of a helper session (lib/fetch_result.ts; Models.swift FetchInfo). */
export interface FetchInfo {
  id: string;
  state: string; // fetching | fetched | failed
  step: string;
  error: string;
  branch: string;
  commit: string;
  repo: string;
  dirty: number;
}

/** A helper session that has started and answers: its work can be fetched (Session.canFetch). */
export const canFetch = (s: { device?: string; state: string; offline?: boolean }): boolean =>
  (s.device ?? '') !== '' && s.state !== 'preparing' && s.state !== 'failed' && s.offline !== true;

/** The notice line of a fetch (FetchInfo.text in Models.swift). */
export function fetchText(f: FetchInfo, device: string): string {
  if (f.state === 'fetching') return `Fetching the result from ${device}: ${f.step}…`;
  if (f.state === 'fetched') {
    const left = f.dirty > 0 ? ` ${String(f.dirty)} uncommitted file(s) on ${device} were not fetched.` : '';
    return `${f.step}: ${f.branch} at ${f.commit} in ${f.repo}. Your checkout did not change.${left}`;
  }
  return `Fetch result failed: ${f.error}`;
}
