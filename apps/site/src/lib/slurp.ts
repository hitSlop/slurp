// slurp.run measures itself with Slurp: one `page_view` per load, the custom feedback form, and two clicks (the Deploy to Cloudflare button
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
 }

const dialog = document.querySelector<HTMLDialogElement>('#site-feedback');
if (dialog) {
  const form = dialog.querySelector<HTMLFormElement>('form')!;
  const message = form.querySelector<HTMLTextAreaElement>('textarea')!;
  const error = form.querySelector<HTMLElement>('[role="alert"]')!;
  const success = dialog.querySelector<HTMLElement>('.feedback-success')!;
  let opener: HTMLElement | null = null;
  let submitted = false;
  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-feedback-open]') : null;
    if (!target) return;
    opener = target;
    if (submitted) { form.reset(); form.hidden = false; success.hidden = true; submitted = false; }
    error.hidden = true;
    if (!dialog.open) dialog.showModal();
    message.focus();
  });
  for (const button of dialog.querySelectorAll('[data-feedback-close]')) button.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => opener?.focus());
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (submitted) return;
    const text = message.value.trim();
    if (!text) { error.textContent = 'Please write a few words first.'; error.hidden = false; message.focus(); return; }
    const rating = new FormData(form).get('rating');
    try {
      if (production) {
        if (!slurpKey) throw new Error('Feedback is unavailable. Please try again later.');
        track('feedback', { message: text.slice(0, 5000), ...(rating ? { rating: Number(rating) } : {}), path: location.pathname });
      }
      submitted = true;
      form.hidden = true;
      success.querySelector('p')!.textContent = production
        ? 'Thanks—your feedback is queued for our agents to read.'
        : 'Demo complete. Nothing was sent from this local preview.';
      success.hidden = false;
      success.querySelector('button')!.focus();
    } catch {
      error.textContent = 'Could not queue your feedback. Please try again.';
      error.hidden = false;
    }
  });
}
