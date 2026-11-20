// Code highlighting with shiki (VS Code grammars), the highlighter the Claude
// app uses, with GitHub light/dark themes. Output uses CSS variables so the
// page can follow the system appearance (see public/chat.css .shiki).
import type { BundledLanguage, Highlighter } from 'shiki';

let hl: Promise<Highlighter> | null = null;
const cache = new Map<string, string>();
const MAX_CACHE = 500;
const ALIASES: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  py: 'python',
  js: 'javascript',
  ts: 'typescript',
  yml: 'yaml',
  md: 'markdown',
  objc: 'objective-c',
  'c++': 'cpp',
};

async function highlighter(): Promise<Highlighter> {
  if (!hl) {
    const { createHighlighter } = await import('shiki');
    hl = createHighlighter({ themes: ['github-light', 'github-dark'], langs: [] });
  }
  return hl;
}

export async function highlight(code: unknown, lang: string | null | undefined): Promise<string> {
  const key = `${lang ?? 'undefined'}\u0000${String(code)}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const h = await highlighter();
  const { bundledLanguages } = await import('shiki');
  let l = (lang ?? '').toLowerCase();
  l = ALIASES[l] ?? l;
  if (!Object.hasOwn(bundledLanguages, l)) l = 'text';
  if (l !== 'text' && !h.getLoadedLanguages().includes(l)) await h.loadLanguage(l as BundledLanguage);
  const html = h.codeToHtml(String(code), {
    lang: l,
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
  });
  if (cache.size >= MAX_CACHE) {
    const first = cache.keys().next();
    if (first.done !== true) cache.delete(first.value);
  }
  cache.set(key, html);
  return html;
}
