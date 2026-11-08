// slurp.run measures itself with Slurp: one `page_view` per load, the feedback widget, and two clicks (the Deploy to Cloudflare button
// and copying an install command). Events go to the Worker at events.slurp.run in the project's own Cloudflare account. An empty key in
// links.mjs turns all of it off. See docs/dogfood.md.
import { init, track } from '@hitslop/slurp-sdk';
import { slurpEndpoint, slurpKey } from './links.mjs';
import { clickEvent, pageContext, pageProperties } from './measure.ts';

if (slurpKey) {
  const page = () => ({ origin: location.origin, pathname: location.pathname, search: location.search });
  init({ key: slurpKey, endpoint: slurpEndpoint, context: () => pageContext(page(), document.referrer, document.title) });
  track('page_view', pageProperties(page(), document.referrer));
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-track]') : null;
    const click = clickEvent(target);
    if (click) track(click.event, click.properties);
  }, true);
  // The widget is not needed to read the page, so it loads after it.
  void import('@hitslop/slurp-sdk/feedback').then(({ mountFeedback }) => mountFeedback({
    accent: '#e8002a',
    title: 'Send feedback about Slurp',
    placeholder: 'What is confusing, missing or broken?',
    data: () => ({ path: location.pathname }),
  }));
}
