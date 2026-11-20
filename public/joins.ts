// Join requests in the web panel, as the Mac app: a computer ran `thoth setup --role helper` and waits
// for the owner's Approve on the cloud brain. The server puts the requests in the state message (`joins`)
// and sends one `joinNotice` per request id (server.ts announceJoins). The sidebar shows them under the
// pages (MainWindow.swift joinCell); the notice is shown also when the panel is in front (main.swift
// notifyJoin). The rules without DOM are tested in a test

/** A computer waiting for the owner's Approve on the cloud brain (lib/join_requests.ts). */
export interface JoinRequest {
  id: string;
  name: string;
  os: string;
  host?: string;
  title: string;
  system: string;
  notice?: string;
}

export const HEADER = 'Wants to Join';

// whole characters, as Swift's String.prefix: an emoji is not cut in half
const segmenter = new Intl.Segmenter();
function prefix(s: string, n: number): string {
  let out = '';
  let i = 0;
  for (const { segment } of segmenter.segment(s)) {
    if (i++ >= n) break;
    out += segment;
  }
  return out;
}

/** The notification's title and text (main.swift notifyJoin limits them to 80 and 200 characters). */
export const joinNotice = (j: JoinRequest): { title: string; body: string } => ({
  title: prefix(j.title, 80),
  body: prefix(j.notice ?? j.system, 200),
});

export const approveTip = (name: string): string => `Let ${name} send its sessions to your brain`;
export const ignoreTip = (name: string): string =>
  `Do not let ${name} join (you can Unignore it in File > Set Up Devices…)`;

/** The list redraws only when this changes (Backend.swift uses the same fields). */
export const joinsKey = (list: JoinRequest[]): string => JSON.stringify(list.map((r) => [r.id, r.name, r.os]));

// SF Symbol desktopcomputer
const ICON =
  '<svg class="ji" viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><rect x="2" y="3" width="16" height="10.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 13.5v3M6.5 16.8h7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

/** The item's inside: icon, name, the server's notice (system, host, time asked, warning), Approve, Ignore. */
export function joinRowHtml(r: JoinRequest, esc: (s: string) => string): string {
  const n = esc(r.name);
  return (
    `<span class="jh">${ICON}<span class="nm">${n}</span></span>` +
    `<span class="sub">${esc(r.notice ?? r.system)}</span>` +
    `<span class="jb"><button class="btn small primary" title="${esc(approveTip(r.name))}" data-testid="join.approve.${n}">Approve</button>` +
    `<button class="btn small" title="${esc(ignoreTip(r.name))}" data-testid="join.ignore.${n}">Ignore</button></span>`
  );
}

export interface JoinDeps {
  esc: (s: string) => string;
  header: (t: string) => HTMLElement;
  /** POST /api/<name>; shows the error as a toast and throws */
  api: (name: string, body: Record<string, unknown>) => Promise<unknown>;
  toast: (t: string) => void;
}

/** The sidebar list and the notice. `show` takes the state's `joins`, `notice` a `joinNotice` message. */
export function joinRequests(
  box: HTMLElement,
  d: JoinDeps,
): { show: (list: JoinRequest[]) => void; notice: (j: JoinRequest) => void } {
  let key: string | null = null;
  const deciding = new Set<string>(); // ids with an Approve / Ignore on the way

  function row(r: JoinRequest): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'join';
    el.dataset['testid'] = `join.${r.name}`;
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', r.title);
    el.title = r.title;
    el.innerHTML = joinRowHtml(r, d.esc);
    const [ok, no] = el.querySelectorAll('button');
    if (ok === undefined || no === undefined) return el;
    const set = (busy: boolean): void => {
      ok.disabled = no.disabled = busy;
    };
    const decide = (decision: 'approve' | 'ignore') => (): void => {
      set(true);
      deciding.add(r.id);
      d.api('setupCloudDevice', { id: r.id, decision }).then(
        () => {
          d.toast(decision === 'approve' ? `${r.name} can join now` : `${r.name} is ignored`);
        },
        () => {
          // the error is shown as a toast; the buttons work again
          deciding.delete(r.id);
          set(false);
        },
      );
    };
    ok.addEventListener('click', decide('approve'));
    no.addEventListener('click', decide('ignore'));
    set(deciding.has(r.id));
    return el;
  }

  function show(list: JoinRequest[]): void {
    const k = joinsKey(list);
    if (k === key) return;
    key = k;
    for (const id of deciding) if (!list.some((r) => r.id === id)) deciding.delete(id);
    box.innerHTML = '';
    if (list.length === 0) return;
    box.append(d.header(HEADER));
    for (const r of list) box.append(row(r));
  }

  function notice(j: JoinRequest): void {
    if (!('Notification' in globalThis)) return;
    if (Notification.permission === 'default') {
      // the browser has not answered yet: ask (public/fixes.ts mayAskNotices); the notice shows on a yes
      void Notification.requestPermission()
        .then((p) => {
          if (p === 'granted') post(j);
        })
        .catch(() => undefined);
      return;
    }
    if (Notification.permission === 'granted') post(j);
  }
  function post(j: JoinRequest): void {
    const { title, body } = joinNotice(j);
    try {
      // one per request id; the request is at the top of the sidebar, so a click only brings the page up
      const n = new Notification(title, { body, tag: `join-${j.id}` });
      n.addEventListener('click', () => {
        globalThis.focus();
        n.close();
      });
    } catch {
      /* some browsers allow notices only from a service worker */
    }
  }

  return { show, notice };
}
