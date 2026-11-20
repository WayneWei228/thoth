// ?theme=dark|light forces a theme (screenshots, users who want it); default follows the system.
// A classic script in <head> (setup.html): it runs before the first paint. The block keeps its names local.
{
  const t = new URLSearchParams(location.search).get('theme');
  if (t === 'dark' || t === 'light') document.documentElement.dataset['theme'] = t;
}
