// The look, as in the Mac app (Theme.swift: Original | Website). ?look= wins; else localStorage 'thoth.look'.
// A classic script in <head> (index.html): it runs before the stylesheet, so the page never flashes the other look.
{
  let l = new URLSearchParams(location.search).get('look');
  if (l !== 'website' && l !== 'original') {
    try {
      l = localStorage.getItem('thoth.look');
    } catch {
      l = null;
    }
  }
  if (l === 'website') document.documentElement.classList.add('website');
}
