import { native } from '../api/bridge';
import { writable, get } from 'svelte/store';
import { type Theme, paletteFor, themeById, themeTokens } from './palette';
export * from './palette';

export type ThemePreference = string;
export const themePreference = writable<ThemePreference>('system');
export const activeTheme = writable<Theme>(paletteFor('dark'));

export function chooseTheme(id: ThemePreference) {
  if (id === 'system' || themeById[id]) {
    themePreference.set(id);
    void import('../api/slurpd')
      .then(({ call }) =>
        call('set_setting', { key: 'app.theme', value: id, actor: 'desktop' }),
      )
      .catch(console.error);
  }
}
export function initializeTheme() {
  const media = matchMedia('(prefers-color-scheme: dark)');
  let stored: string | null = null;
  try {
    stored = localStorage.getItem('slurp:app-theme');
    if (!stored) {
      const old = localStorage.getItem('slurp:source-theme');
      stored = old
        ? (
            {
              charcoal: 'pro-dark',
              light: 'pro-light',
              blueprint: 'blueprint',
            } as Record<string, string>
          )[old]
        : null;
    }
  } catch {}
  if (stored && (stored === 'system' || themeById[stored]))
    themePreference.set(stored);
  const apply = () => {
    const preference = get(themePreference),
      t = paletteFor(
        preference === 'system'
          ? media.matches
            ? 'dark'
            : 'light'
          : preference,
      );
    const root = document.documentElement;
    for (const [key, value] of Object.entries(themeTokens(t)))
      root.style.setProperty(key, value);
    root.style.colorScheme = t.scheme;
    root.style.backgroundColor = t.bg;
    document.body.style.backgroundColor = t.bg;
    root.dataset.theme = t.id;
    activeTheme.set(t);
    if ('__TAURI_INTERNALS__' in window)
      void native({ op: 'window_background', color: t.bg }).catch(
        console.error,
      );
  };
  const unsubscribe = themePreference.subscribe((value) => {
    try {
      localStorage.setItem('slurp:app-theme', value);
    } catch {}
    apply();
  });
  async function loadPreference() {
    const before = get(themePreference);
    try {
      const { call } = await import('../api/slurpd');
      const { value } = await call('get_setting', { key: 'app.theme' });
      if (
        get(themePreference) === before &&
        (value === 'system' || themeById[value])
      )
        themePreference.set(value);
    } catch {
      /* Local preference keeps startup readable while the daemon reconnects. */
    }
  }
  void loadPreference();
  window.addEventListener('focus', loadPreference);
  const update = () => {
    if (get(themePreference) === 'system') apply();
  };
  media.addEventListener('change', update);
  const storage = (e: StorageEvent) => {
    if (
      e.key === 'slurp:app-theme' &&
      e.newValue &&
      (e.newValue === 'system' || themeById[e.newValue])
    )
      themePreference.set(e.newValue);
  };
  window.addEventListener('storage', storage);
  return () => {
    unsubscribe();
    window.removeEventListener('focus', loadPreference);
    media.removeEventListener('change', update);
    window.removeEventListener('storage', storage);
  };
}
