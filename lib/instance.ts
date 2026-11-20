// Instance settings. One "instance" = one server port + one tmux server + one
// state folder. The default instance is the one the user works in. Verify runs
// and other worktrees start their own instances, so they never touch it.
//
//   CC_PANEL_PORT          HTTP port                      (default 7878)
//   CC_PANEL_TMUX_SOCKET   tmux server socket name (-L)   (default: tmux's default server)
//   CC_PANEL_HOME          state folder                   (default ~/.config/cc-panel)
//   CC_PANEL_INSTANCE      set for a test instance (verify): its tag. A test instance never starts
//                          Remote Control in its Claude sessions (lib/claude_args.ts).
import os from 'node:os';
import path from 'node:path';

export interface Instance {
  port: number;
  home: string;
  socket: string;
  /** Tag of a test instance (verify); '' for the instance the user works in. */
  test: string;
  /** Arguments that go before every tmux command. */
  tmuxArgs: string[];
}

export function instance(env: NodeJS.ProcessEnv = process.env): Instance {
  const socket = (env['CC_PANEL_TMUX_SOCKET'] ?? '').trim();
  if (socket && !/^[\w.-]+$/.test(socket)) throw new Error(`bad CC_PANEL_TMUX_SOCKET: ${socket}`);
  return {
    port: Number((env['CC_PANEL_PORT'] ?? '') || 7878),
    home: (env['CC_PANEL_HOME'] ?? '') || path.join(os.homedir(), '.config', 'cc-panel'),
    socket,
    /** Tag of a test instance (verify); '' for the instance the user works in. */
    test: (env['CC_PANEL_INSTANCE'] ?? '').trim(),
    /** Arguments that go before every tmux command. -u: without a UTF-8 locale (a server started
     *  with no LANG, as an unattended build has) tmux 3.5 prints "_" for the tab between
     *  the fields of list-windows -F, and every session lost its id, name and folder. */
    tmuxArgs: socket ? ['-u', '-L', socket] : ['-u'],
  };
}

// Folders macOS guards with a permission prompt per app (Desktop, Documents, Downloads, iCloud
// Drive). Each verify instance is a new app to macOS, so a check of a folder in one of them asks
// the user again on every run ("Panel Verify … would like to access files in your Desktop
// folder"). A test instance does not look inside them.
const GUARDED = ['Desktop', 'Documents', 'Downloads', path.join('Library', 'Mobile Documents')];
export function guardedFolder(p: string | null | undefined, home: string = os.homedir()): boolean {
  const abs = path.resolve(p ?? '');
  return GUARDED.some((g) => {
    const root = path.join(home, g);
    return abs === root || abs.startsWith(root + path.sep);
  });
}
