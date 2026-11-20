// Globals of the vendor scripts the pages load as classic scripts before their own modules
// (server.ts STATIC: /xterm.js, /addon-fit.js, /addon-web-links.js, /vendor/*.js). Types come from the packages.
import type * as XtermFit from '@xterm/addon-fit';
import type * as XtermWebLinks from '@xterm/addon-web-links';
import type { Terminal as XtermTerminal } from '@xterm/xterm';
import type DOMPurifyType from 'dompurify';
import type * as Marked from 'marked';
import type markedKatexType from 'marked-katex-extension';
import type mermaidType from 'mermaid';

declare global {
  const Terminal: typeof XtermTerminal;
  const FitAddon: typeof XtermFit;
  const WebLinksAddon: typeof XtermWebLinks;
  const marked: typeof Marked;
  const markedKatex: typeof markedKatexType;
  const DOMPurify: typeof DOMPurifyType;
  const mermaid: typeof mermaidType;

  // the Mac app's WKWebView bridge (WKScriptMessageHandler "panel")
  interface Window {
    webkit?: { messageHandlers?: { panel?: { postMessage: (message: unknown) => void } } };
    // the app calls this right after a send (public/chat.ts)
    pollNow?: () => void;
  }
}
