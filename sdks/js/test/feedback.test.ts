import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { mountFeedback } from '../src/feedback.ts'

let dom: JSDOM
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body><main id="app">page</main></body></html>', { url: 'https://app.example.test/pricing' })
  const g = globalThis as any
  g.document = dom.window.document
  g.window = dom.window
})
afterEach(() => { const g = globalThis as any; delete g.document; delete g.window })

const shadow = () => dom.window.document.querySelector('[data-slurp-feedback]')!.shadowRoot!
const q = <T extends Element>(selector: string) => shadow().querySelector(selector) as unknown as T
const click = (node: Element) => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
function recorder() {
  const sent: { event: string; data: Record<string, unknown> | undefined }[] = []
  return { sent, client: { track: (event: string, data?: Record<string, unknown>) => { sent.push({ event, data }); return 'id' } } }
}

test('the button opens a form and a rated message is sent as one feedback event', () => {
  const { sent, client } = recorder()
  mountFeedback({ client, data: () => ({ screen: 'pricing' }) })
  assert.ok(q('.panel').hasAttribute('hidden'), 'closed to start with')
  assert.equal(q('.fab').textContent, 'Feedback')
  click(q('.fab'))
  assert.ok(!q('.panel').hasAttribute('hidden'))
  assert.equal(q('.fab').getAttribute('aria-expanded'), 'true')
  q<HTMLTextAreaElement>('textarea').value = '  Exports fail at 90%  '
  click(shadow().querySelectorAll('.rating button')[1])
  assert.equal(shadow().querySelectorAll('.rating button')[1].getAttribute('aria-pressed'), 'true')
  click(q('.send'))
  assert.deepEqual(sent, [{ event: 'feedback', data: { screen: 'pricing', message: 'Exports fail at 90%', rating: 2 } }])
  assert.match(q('.thanks').textContent!, /Thank you/)
  assert.ok(q('form').hasAttribute('hidden'))
})

test('a small "Powered by Slurp" link sits under the form, opens elsewhere without a referrer, and can be turned off', () => {
  const { sent, client } = recorder()
  mountFeedback({ client })
  const link = q<HTMLAnchorElement>('.powered a')
  assert.equal(q('.powered').textContent, 'Powered by Slurp')
  assert.equal(link.getAttribute('href'), 'https://slurp.run/?utm_source=feedback-widget')
  assert.equal(link.getAttribute('target'), '_blank')
  assert.match(link.getAttribute('rel')!, /noopener/); assert.match(link.getAttribute('rel')!, /noreferrer/)
  assert.ok(!link.href.includes('app.example.test'), 'it does not carry the host page address')
  click(q('.fab')); click(link)
  assert.deepEqual(sent, [], 'opening the link sends no event')
  // After sending, the thank-you is above the credit line, which stays.
  q<HTMLTextAreaElement>('textarea').value = 'Great'
  click(q('.send'))
  const children = [...q('.panel').children].map(c => c.className || c.tagName.toLowerCase())
  assert.ok(children.indexOf('thanks') < children.indexOf('powered'), children.join(','))
  mountFeedback({ client, poweredBy: false })
  assert.equal(shadow().querySelector('.powered'), null, 'poweredBy: false removes it')
})

test('an empty message is refused with a visible reason and nothing is sent', () => {
  const { sent, client } = recorder()
  mountFeedback({ client })
  click(q('.fab'))
  q<HTMLTextAreaElement>('textarea').value = '   '
  click(q('.send'))
  assert.deepEqual(sent, [])
  assert.ok(!q('.error').hasAttribute('hidden')); assert.match(q('.error').textContent!, /few words/)
})

test('rating is optional and toggles off; email is only asked for on request and must look like an address', () => {
  const { sent, client } = recorder()
  mountFeedback({ client, ratings: false })
  assert.equal(shadow().querySelectorAll('.rating').length, 0)
  assert.equal(shadow().querySelectorAll('input[type=email]').length, 0)
  click(q('.fab'))
  q<HTMLTextAreaElement>('textarea').value = 'hello'
  click(q('.send'))
  assert.deepEqual(sent[0].data, { message: 'hello' })
  mountFeedback({ client, askEmail: true })
  click(q('.fab'))
  q<HTMLTextAreaElement>('textarea').value = 'needs a reply'
  q<HTMLInputElement>('input[type=email]').value = 'nope'
  click(q('.send'))
  assert.equal(sent.length, 1, 'a bad address is not sent'); assert.match(q('.error').textContent!, /email/i)
  q<HTMLInputElement>('input[type=email]').value = 'pat@example.test'
  click(shadow().querySelectorAll('.rating button')[4]); click(shadow().querySelectorAll('.rating button')[4])
  click(q('.send'))
  assert.deepEqual(sent[1].data, { message: 'needs a reply', email: 'pat@example.test' }, 'pressing a rating twice clears it')
})

test('what a person types is never parsed as HTML, and an event name can be chosen', () => {
  const { sent, client } = recorder()
  mountFeedback({ client, event: 'beta_feedback' })
  click(q('.fab'))
  q<HTMLTextAreaElement>('textarea').value = '<img src=x onerror=alert(1)><b>bold</b>'
  click(q('.send'))
  assert.equal(sent[0].event, 'beta_feedback'); assert.equal(sent[0].data!.message, '<img src=x onerror=alert(1)><b>bold</b>')
  assert.equal(shadow().querySelectorAll('img').length, 0, 'the text is data, not markup')
  assert.equal(dom.window.document.querySelectorAll('[data-slurp-feedback]').length, 1)
})

test('Escape and Cancel close it, mounting again replaces it, and destroy removes it', () => {
  const { client } = recorder()
  const handle = mountFeedback({ client })
  handle.open()
  assert.ok(!q('.panel').hasAttribute('hidden'))
  q('.panel').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  assert.ok(q('.panel').hasAttribute('hidden'))
  handle.open(); click(q('.cancel')); assert.ok(q('.panel').hasAttribute('hidden'))
  mountFeedback({ client })
  assert.equal(dom.window.document.querySelectorAll('[data-slurp-feedback]').length, 1, 'mounting twice does not stack widgets')
  const again = mountFeedback({ client, button: false })
  assert.equal(shadow().querySelectorAll('.fab').length, 0, 'with button: false it is opened from your own code')
  again.open(); assert.ok(!q('.panel').hasAttribute('hidden'))
  again.destroy()
  assert.equal(dom.window.document.querySelectorAll('[data-slurp-feedback]').length, 0)
})

test('the thank-you message closes itself and the form is clean the next time', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { sent, client } = recorder()
  mountFeedback({ client })
  click(q('.fab'))
  q<HTMLTextAreaElement>('textarea').value = 'one'
  click(q('.send'))
  t.mock.timers.tick(2600)
  assert.ok(q('.panel').hasAttribute('hidden'))
  click(q('.fab'))
  assert.equal(q<HTMLTextAreaElement>('textarea').value, ''); assert.ok(!q('form').hasAttribute('hidden'))
  assert.equal(sent.length, 1)
})

test('without init and without a client it says so instead of throwing into the page', () => {
  mountFeedback()
  click(q('.fab'))
  q<HTMLTextAreaElement>('textarea').value = 'hi'
  click(q('.send'))
  assert.match(q('.error').textContent!, /not set up/)
})

test('the theme is set on the host so a page can match itself', () => {
  const { client } = recorder()
  mountFeedback({ client })
  assert.equal(dom.window.document.querySelector('[data-slurp-feedback]')!.getAttribute('data-theme'), 'auto')
  mountFeedback({ client, theme: 'light' })
  assert.equal(dom.window.document.querySelector('[data-slurp-feedback]')!.getAttribute('data-theme'), 'light')
})

test('it needs a browser', () => {
  delete (globalThis as any).document
  assert.throws(() => mountFeedback(), /browser document/)
})
