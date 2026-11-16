// Instance settings. One "instance" = one server port + one tmux server + one
// state folder. The default instance is the one the user works in. Verify runs
// and other worktrees start their own instances, so they never touch it.
//
//   CC_PANEL_PORT          HTTP port                      (default 7878)
//   CC_PANEL_TMUX_SOCKET   tmux server socket name (-L)   (default: tmux's default server)
//   CC_PANEL_HOME          state folder                   (default ~/.config/cc-panel)
//   CC_PANEL_INSTANCE      set for a test instance (verify): its tag. A test instance never starts
//                          Remote Control in its Claude sessions (lib/claude_args.js).
'use strict';
const os = require('os');
const path = require('path');

function instance(env = process.env) {
  const socket = (env.CC_PANEL_TMUX_SOCKET || '').trim();
  if (socket && !/^[A-Za-z0-9._-]+$/.test(socket)) throw new Error(`bad CC_PANEL_TMUX_SOCKET: ${socket}`);
  return {
    port: Number(env.CC_PANEL_PORT || 7878),
    home: env.CC_PANEL_HOME || path.join(os.homedir(), '.config', 'cc-panel'),
    socket,
    /** Tag of a test instance (verify); '' for the instance the user works in. */
    test: (env.CC_PANEL_INSTANCE || '').trim(),
    /** Arguments that go before every tmux command. -u: without a UTF-8 locale (a server started
     *  with no LANG, as an unattended build has) tmux 3.5 prints "_" for the tab between
     *  the fields of list-windows -F, and every session lost its id, name and folder. */
    tmuxArgs: socket ? ['-u', '-L', socket] : ['-u'],
  };
}

module.exports = { instance };
