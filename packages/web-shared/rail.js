// Shared by the static site and the self-contained setup page.
export function trackSections(root) {
  if (!root) return () => {};
  const pairs = [...root.querySelectorAll('a[href^="#"]')].map(link => ({link, section:document.getElementById(link.hash.slice(1))})).filter(p => p.section && p.link.hash !== '#main');
  let frame=0;
  const apply=()=>{
    frame=0;
    const line=window.innerWidth<=900?root.getBoundingClientRect().height+24:120;
    let active=null;
    for(const p of pairs) if(p.section.getBoundingClientRect().top<=line) active=p;
    if(window.innerHeight+window.scrollY>=document.documentElement.scrollHeight-2) active=pairs.at(-1);
    for(const p of pairs) {if(p===active)p.link.setAttribute('aria-current','location');else p.link.removeAttribute('aria-current');}
  };
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(apply)};
  window.addEventListener('scroll',schedule,{passive:true});window.addEventListener('resize',schedule);window.addEventListener('hashchange',schedule);apply();
  return ()=>{cancelAnimationFrame(frame);window.removeEventListener('scroll',schedule);window.removeEventListener('resize',schedule);window.removeEventListener('hashchange',schedule)};
}
