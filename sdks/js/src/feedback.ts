import { track as defaultTrack } from './index.ts'

/** What the widget needs from a client: just `track`. Pass the result of `createClient`, or omit it to use the client from `init`. */
export interface FeedbackClient {
  track(event: string, data?: Record<string, unknown>): string
}

export interface FeedbackOptions {
  /** Where the feedback event goes. Defaults to the client created by `init`. */
  client?: FeedbackClient
  /** Text of the floating button. */
  label?: string
  title?: string
  placeholder?: string
  /** Message shown after feedback is queued. */
  thankYou?: string
  /** Show a 1 to 5 rating. Default true. */
  ratings?: boolean
  /** Ask for an email address (optional for the person). Default false. */
  askEmail?: boolean
  position?: 'bottom-right' | 'bottom-left'
  /** Accent color for the button and the submit button. */
  accent?: string
  /** `auto` follows the visitor's system dark mode; `light` or `dark` match your own page. Default `auto`. */
  theme?: 'auto' | 'light' | 'dark'
  /** Event name. Default `feedback`. */
  event?: string
  /** Extra properties added to every feedback event, evaluated when it is sent (the current screen, plan, release...). */
  data?: () => Record<string, unknown>
  /** Show the floating button. Default true; set false and call `open()` from your own button. */
  button?: boolean
  /** Where to attach the widget. Default `document.body`. */
  container?: HTMLElement
  /** Show the small "Powered by Slurp" link under the form. Default true; set false to hide it. */
  poweredBy?: boolean
}

export interface FeedbackHandle {
  open(): void
  close(): void
  /** Remove the widget from the page. */
  destroy(): void
}

const MAX_MESSAGE = 5000
const HOST_ATTRIBUTE = 'data-slurp-feedback'
/** The "Powered by" link opens in a new tab without telling slurp.run which site it came from; the utm tag says only that it was this widget. */
const POWERED_BY_URL = 'https://slurp.run/?utm_source=feedback-widget'

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
.fab { position: fixed; bottom: 20px; z-index: 2147483000; border: 0; border-radius: 999px; padding: 11px 18px; background: var(--accent); color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.22); }
.fab:hover { filter: brightness(1.06); }
.right { right: 20px; } .left { left: 20px; }
.panel { position: fixed; bottom: 70px; z-index: 2147483001; width: min(340px, calc(100vw - 24px)); background: #fff; color: #17191c; border: 1px solid #dfe3e8; border-radius: 14px; box-shadow: 0 18px 50px rgba(0,0,0,.25); padding: 16px; }
.panel[hidden] { display: none; }
h2 { margin: 0 0 10px; font-size: 16px; }
textarea, input[type=email] { width: 100%; border: 1px solid #c9ced6; border-radius: 8px; padding: 9px 10px; font-size: 14px; color: inherit; background: #fff; }
textarea { min-height: 96px; resize: vertical; }
input[type=email] { margin-top: 8px; }
textarea:focus-visible, input:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.rating { display: flex; gap: 6px; margin: 0 0 10px; padding: 0; border: 0; }
.rating legend { font-size: 12px; color: #5b616a; padding: 0; margin-bottom: 4px; }
.rating button { width: 34px; height: 34px; border-radius: 8px; border: 1px solid #c9ced6; background: #fff; color: #17191c; font-size: 14px; font-weight: 600; cursor: pointer; }
.rating button[aria-pressed=true] { background: var(--accent); border-color: var(--accent); color: #fff; }
.row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
.row button { border-radius: 8px; padding: 8px 14px; font-size: 14px; font-weight: 600; cursor: pointer; border: 1px solid #c9ced6; background: #fff; color: #17191c; }
.row .send { background: var(--accent); border-color: var(--accent); color: #fff; }
.error { margin: 8px 0 0; font-size: 13px; color: #b3001f; }
.powered { margin: 12px 0 0; text-align: center; font-size: 11px; color: #8a919b; }
.powered a { color: inherit; text-decoration: none; }
.powered a:hover, .powered a:focus-visible { color: var(--accent); text-decoration: underline; }
.thanks { margin: 6px 0 2px; font-size: 15px; }
@media (prefers-color-scheme: dark) {
  :host([data-theme=auto]) .panel { background: #1f2327; color: #f2f4f6; border-color: #3a4048; }
  :host([data-theme=auto]) textarea, :host([data-theme=auto]) input[type=email] { background: #15181b; border-color: #3a4048; }
  :host([data-theme=auto]) .rating button, :host([data-theme=auto]) .row button { background: #15181b; border-color: #3a4048; color: #f2f4f6; }
  :host([data-theme=auto]) .rating legend { color: #9aa1aa; }
  :host([data-theme=auto]) .row .send { background: var(--accent); border-color: var(--accent); color: #fff; }
  :host([data-theme=auto]) .powered { color: #7d858f; }
}
:host([data-theme=dark]) .panel { background: #1f2327; color: #f2f4f6; border-color: #3a4048; }
:host([data-theme=dark]) textarea, :host([data-theme=dark]) input[type=email] { background: #15181b; border-color: #3a4048; }
:host([data-theme=dark]) .rating button, :host([data-theme=dark]) .row button { background: #15181b; border-color: #3a4048; color: #f2f4f6; }
:host([data-theme=dark]) .rating legend { color: #9aa1aa; }
:host([data-theme=dark]) .row .send { background: var(--accent); border-color: var(--accent); color: #fff; }
:host([data-theme=dark]) .powered { color: #7d858f; }
`

function element<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value)
  if (text !== undefined) node.textContent = text
  return node
}

/**
 * A floating "Feedback" button that opens a small form and sends the answer as one event (default name `feedback`) with
 * `message`, and `rating` and `email` when asked for. Everything is built with DOM methods and `textContent`, so nothing a person types
 * is ever parsed as HTML, and the styles live in a shadow root so they neither affect nor inherit from your page. Browser only.
 */
export function mountFeedback(options: FeedbackOptions = {}): FeedbackHandle {
  if (typeof document === 'undefined') throw new Error('mountFeedback needs a browser document')
  const {
    label = 'Feedback', title = 'Send feedback', placeholder = 'What is working, and what is not?',
    ratings = true, askEmail = false, position = 'bottom-right', accent = '#e8002a', event = 'feedback', button = true, theme = 'auto', poweredBy = true,
  } = options
  const container = options.container ?? document.body
  for (const old of container.querySelectorAll(`[${HOST_ATTRIBUTE}]`)) old.remove() // mounting twice replaces, never stacks

  const host = element('div', { [HOST_ATTRIBUTE]: '', 'data-theme': theme })
  const root = host.attachShadow({ mode: 'open' })
  root.appendChild(element('style', {}, STYLE))
  host.style.setProperty('--accent', accent)

  const fab = element('button', { type: 'button', class: `fab ${position === 'bottom-left' ? 'left' : 'right'}`, 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, label)
  const panel = element('div', { class: `panel ${position === 'bottom-left' ? 'left' : 'right'}`, role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'slurp-feedback-title', hidden: '' })
  const heading = element('h2', { id: 'slurp-feedback-title' }, title)
  const form = element('form', { novalidate: '' })
  const message = element('textarea', { name: 'message', placeholder, 'aria-label': title, maxlength: String(MAX_MESSAGE), required: '' })
  let rating: number | undefined
  const ratingButtons: HTMLButtonElement[] = []
  let ratingGroup: HTMLElement | undefined
  if (ratings) {
    ratingGroup = element('fieldset', { class: 'rating' })
    ratingGroup.appendChild(element('legend', {}, 'How would you rate it?'))
    for (let value = 1; value <= 5; value++) {
      const choice = element('button', { type: 'button', 'aria-pressed': 'false', 'aria-label': `${value} out of 5` }, String(value))
      choice.addEventListener('click', () => {
        rating = rating === value ? undefined : value
        for (const [index, other] of ratingButtons.entries()) other.setAttribute('aria-pressed', String(rating === index + 1))
      })
      ratingButtons.push(choice)
      ratingGroup.appendChild(choice)
    }
  }
  const email = askEmail ? element('input', { type: 'email', name: 'email', placeholder: 'Email (optional, if you want a reply)', autocomplete: 'email', 'aria-label': 'Email (optional)' }) : undefined
  const error = element('p', { class: 'error', role: 'alert', hidden: '' })
  const cancel = element('button', { type: 'button', class: 'cancel' }, 'Cancel')
  const send = element('button', { type: 'submit', class: 'send' }, 'Send')
  const row = element('div', { class: 'row' })
  row.append(cancel, send)
  form.append(...[ratingGroup, message, email, error, row].filter((node): node is HTMLElement => node !== undefined))
  panel.append(heading, form)
  let credit: HTMLElement | undefined
  if (poweredBy) {
    credit = element('p', { class: 'powered' })
    credit.append('Powered by ', element('a', { href: POWERED_BY_URL, target: '_blank', rel: 'noopener noreferrer' }, 'Slurp'))
    panel.append(credit)
  }
  root.append(...(button ? [fab, panel] : [panel]))

  let timer: ReturnType<typeof setTimeout> | undefined
  let thanks: HTMLElement | undefined
  const show = (visible: boolean) => {
    if (visible) panel.removeAttribute('hidden'); else panel.setAttribute('hidden', '')
    fab.setAttribute('aria-expanded', String(visible))
  }
  const reset = () => {
    message.value = ''
    if (email) email.value = ''
    rating = undefined
    for (const choice of ratingButtons) choice.setAttribute('aria-pressed', 'false')
    error.setAttribute('hidden', '')
    thanks?.remove()
    thanks = undefined
    form.removeAttribute('hidden')
  }
  const open = () => {
    clearTimeout(timer)
    if (thanks) reset()
    show(true)
    message.focus()
  }
  const close = () => {
    clearTimeout(timer)
    show(false)
    fab.focus?.()
  }
  fab.addEventListener('click', () => (panel.hasAttribute('hidden') ? open() : close()))
  cancel.addEventListener('click', close)
  panel.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Escape') close() })
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const text = message.value.trim()
    if (!text) {
      error.textContent = 'Please write a few words first.'
      error.removeAttribute('hidden')
      message.focus()
      return
    }
    const address = email?.value.trim()
    if (address && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      error.textContent = 'That email address does not look right.'
      error.removeAttribute('hidden')
      email?.focus()
      return
    }
    const properties: Record<string, unknown> = { ...(options.data?.() ?? {}), message: text.slice(0, MAX_MESSAGE) }
    if (rating !== undefined) properties.rating = rating
    if (address) properties.email = address
    try {
      ;(options.client ?? { track: defaultTrack }).track(event, properties)
    } catch (failure) {
      error.textContent = failure instanceof Error && /call init/.test(failure.message) ? 'Feedback is not set up on this page yet.' : 'Could not send. Please try again.'
      error.removeAttribute('hidden')
      return
    }
    form.setAttribute('hidden', '')
    thanks = element('p', { class: 'thanks', role: 'status' }, options.thankYou ?? 'Thank you! We read every message.')
    panel.insertBefore(thanks, credit ?? null) // the thank-you sits above the credit line
    timer = setTimeout(() => { show(false); reset() }, 2500)
  })

  container.appendChild(host)
  return {
    open,
    close,
    destroy() { clearTimeout(timer); host.remove() },
  }
}
