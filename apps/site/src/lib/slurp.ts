// slurp.run measures itself with Slurp: one `page_view` per load, the feedback widget, and two clicks (the Deploy to Cloudflare button
// and copying an install command). Events go to the Worker at events.slurp.run in the project's own Cloudflare account. An empty key in
// links.mjs turns all of it off. See apps/site/slurp/README.md.
import { init, track } from '@hitslop/slurp-sdk';
import { slurpEndpoint, slurpKey } from './links.mjs';
import { clickEvent, pageContext, pageProperties } from './measure.ts';

// Previews and local servers must not add to the real project's data: there the feedback form opens and sends nothing.
const production = !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
if (slurpKey) {
  const page = () => ({ origin: location.origin, pathname: location.pathname, search: location.search });
  if (production) init({ key: slurpKey, endpoint: slurpEndpoint, context: () => pageContext(page(), document.referrer, document.title) });
  const record = (event: string, data?: Record<string, unknown>): string => (production ? track(event, data) : '');
  record('page_view', pageProperties(page(), document.referrer));
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-track]') : null;
    const click = clickEvent(target);
    if (click) record(click.event, click.properties);
  }, true);
  // The widget is not needed to read the page, so it loads after it. On a phone its floating button would sit on top of the text, so
  // there it is hidden and the "Feedback" entry in the header opens the same form.
  const compact = matchMedia('(max-width: 900px)');
  let widget: { open(): void; destroy(): void } | undefined;
  const mount = () => import('@hitslop/slurp-sdk/feedback').then(({ mountFeedback }) => {
    widget?.destroy();
    widget = mountFeedback({
      accent: '#e8002a',
      theme: 'light', // the site is always light, whatever the visitor's system setting
      title: 'Send feedback about Slurp',
      placeholder: 'What is confusing, missing or broken?',
      thankYou: 'Thank you. Our agent reads every message.',
      data: () => ({ path: location.pathname }),
      client: { track: record },
      button: !compact.matches,
    });
    for (const entry of document.querySelectorAll<HTMLElement>('[data-feedback-open]')) entry.hidden = !compact.matches;
  });
  void mount();
  compact.addEventListener('change', () => void mount());
  document.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('[data-feedback-open]')) widget?.open();
  });
}
