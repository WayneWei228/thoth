// Code highlighting with shiki (VS Code grammars), the highlighter the Claude
// app uses, with GitHub light/dark themes. Output uses CSS variables so the
// page can follow the system appearance (see public/chat.css .shiki).
'use strict';

let hl = null;
const cache = new Map();
const MAX_CACHE = 500;
const ALIASES = { sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', py: 'python', js: 'javascript', ts: 'typescript', yml: 'yaml', md: 'markdown', objc: 'objective-c', 'c++': 'cpp' };

async function highlighter() {
  if (!hl) {
    const { createHighlighter } = await import('shiki');
    hl = createHighlighter({ themes: ['github-light', 'github-dark'], langs: [] });
  }
  return hl;
}

async function highlight(code, lang) {
  const key = `${lang}\u0000${code}`;
  if (cache.has(key)) return cache.get(key);
  const h = await highlighter();
  const { bundledLanguages } = await import('shiki');
  let l = String(lang || '').toLowerCase();
  l = ALIASES[l] || l;
  if (!bundledLanguages[l]) l = 'text';
  if (l !== 'text' && !h.getLoadedLanguages().includes(l)) await h.loadLanguage(l);
  const html = h.codeToHtml(String(code), { lang: l, themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false });
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(key, html);
  return html;
}

module.exports = { highlight };
