// What the site tells Slurp about its own visitors: the page, where they came from, and two clicks. Pure functions, so tests can pin
// exactly what is captured. Nothing here reads a form field or any text a person typed (the feedback widget sends what its form holds).

export interface PageSource { origin: string; pathname: string; search: string }

/** `https://example.com/a/b?token=1#x` becomes `https://example.com/a/b`: the query string and fragment can hold anything. */
export function origin_and_path(url: string): string {
  try {
    const u = new URL(url)
    return u.origin + u.pathname
  } catch { return '' }
}

const UTM = ['utm_source', 'utm_medium', 'utm_campaign'] as const

/** The properties of the `page_view` event. */
export function pageProperties(page: PageSource, referrer: string): Record<string, string> {
  const properties: Record<string, string> = { path: page.pathname }
  const from = origin_and_path(referrer)
  if (from) properties.referrer = from
  const query = new URLSearchParams(page.search)
  for (const key of UTM) {
    const value = query.get(key)
    if (value) properties[key] = value.slice(0, 100)
  }
  return properties
}

/** Replaces the SDK's automatic page context so no event carries a query string, a fragment or a full referrer. */
export function pageContext(page: PageSource, referrer: string, title: string): { page: Record<string, string> } {
  return { page: { url: page.origin + page.pathname, path: page.pathname, referrer: origin_and_path(referrer), title } }
}

/** The two tracked clicks are named by `data-track` on the element; `data-track-where` says which instance. */
export const TRACKED = ['deploy_clicked', 'install_copied'] as const
export function clickEvent(element: { dataset: DOMStringMap } | null): { event: string; properties: Record<string, string> } | null {
  const name = element?.dataset.track
  if (!name || !(TRACKED as readonly string[]).includes(name)) return null
  const where = element?.dataset.trackWhere
  return { event: name, properties: where ? { where } : {} }
}
