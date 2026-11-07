import source from './perspective.json';

export type Theme = (typeof source)[number] & { uiAccent?: string };
const pitchBlack: Theme = {
  ...source.find((t) => t.id === 'pro-dark')!,
  id: 'pitch-black',
  name: 'Pitch Black',
  source: 'Slurp',
  scheme: 'dark',
  bg: '#000000',
  fg: '#e6e6e6',
  inactive: '#777777',
  border: '#262626',
  accent: '#e6d75a',
  uiAccent: '#e6d75a',
  positive: '#88c6eb',
  negative: '#ed8897',
  grid: '#1c1c1c',
  axisTicks: '#a8a8a8',
  axisLines: '#444444',
  legend: '#b8b8b8',
  tooltipBg: '#080808',
  tooltipFg: '#e6e6e6',
  gradient: 'linear-gradient(#ed8897 0%, #000000 50%, #88c6eb 100%)',
};
export const themes: Theme[] = [...source, pitchBlack];
export const themeById = Object.fromEntries(themes.map((t) => [t.id, t]));
// A theme is a built-in id, or a complete palette object (a user's own theme file, filled in by the CLI).
export function paletteFor(theme: string | Theme): Theme {
  if (typeof theme === 'object' && theme) return theme;
  return themeById[
    theme === 'light' ? 'pro-light' : theme === 'dark' ? 'pro-dark' : theme
  ];
}
export const monoFont =
  "ui-monospace, 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

export function rgb(color: string): number[] {
  if (color === 'white') return [255, 255, 255];
  if (color === 'black') return [0, 0, 0];
  if (color.startsWith('#')) {
    const h = color.slice(1);
    const full =
      h.length === 3
        ? h
            .split('')
            .map((c) => c + c)
            .join('')
        : h;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  }
  if (/^hsla?\(/i.test(color)) {
    const values = color.match(/[-\d.]+/g)?.map(Number) ?? [];
    const h = (((values[0] % 360) + 360) % 360) / 60;
    const s = values[1] / 100,
      l = values[2] / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h % 2) - 1)),
      m = l - c / 2;
    const parts =
      h < 1
        ? [c, x, 0]
        : h < 2
          ? [x, c, 0]
          : h < 3
            ? [0, c, x]
            : h < 4
              ? [0, x, c]
              : h < 5
                ? [x, 0, c]
                : [c, 0, x];
    return parts.map((v) => Math.round((v + m) * 255));
  }
  const m = color.match(/[\d.]+/g);
  return m ? m.slice(0, 3).map(Number) : [0, 0, 0];
}
export function mix(a: string, b: string, weight: number) {
  const aa = rgb(a),
    bb = rgb(b);
  return (
    '#' +
    aa
      .map((v, i) =>
        Math.round(v * weight + bb[i] * (1 - weight))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}
function luminance(color: string) {
  const c = rgb(color).map((v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
}
export function contrast(a: string, b: string) {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
// Keep original palette data intact; adapt text roles where upstream uses colors
// intended for decorative marks rather than small application text.
export function readable(color: string, bg: string, fg: string, ratio = 4.5) {
  if (contrast(color, bg) >= ratio) return color;
  for (let i = 1; i <= 20; i++) {
    const next = mix(fg, color, i / 20);
    if (contrast(next, bg) >= ratio) return next;
  }
  return fg;
}
export function hueSat(color: string): [number, number] {
  const [r, g, b] = rgb(color).map((v) => v / 255);
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    d = max - min,
    l = (max + min) / 2;
  if (d === 0) return [0, 0];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h =
    max === r
      ? ((g - b) / d) % 6
      : max === g
        ? (b - r) / d + 2
        : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s];
}
// Status colors (ok/stale) must keep their meaning in every theme: take the palette
// color nearest the target hue, else a neutral default. Never a fixed series slot,
// whose hue varies by palette (e.g. slot 3 is red in Pro Light).
export function semanticColor(
  series: string[],
  targetHue: number,
  fallback: string,
) {
  let best: string | undefined,
    bestDistance = 30;
  for (const color of series) {
    const [h, s] = hueSat(color);
    const distance = Math.min(
      Math.abs(h - targetHue),
      360 - Math.abs(h - targetHue),
    );
    if (s >= 0.3 && distance < bestDistance) {
      best = color;
      bestDistance = distance;
    }
  }
  return best ?? fallback;
}
export function themeTokens(t: Theme): Record<string, string> {
  const fg = readable(t.fg, t.bg, t.scheme === 'dark' ? '#ffffff' : '#161616');
  const muted = readable(mix(fg, t.bg, 0.65), t.bg, fg),
    faint = readable(mix(fg, t.bg, 0.5), t.bg, fg);
  const accent = readable(
    t.uiAccent ?? (t.scheme === 'dark' ? t.positive : t.accent),
    t.bg,
    fg,
  );
  const line =
    contrast(t.border, t.bg) >= 1.25 ? t.border : mix(fg, t.bg, 0.22);
  const raised = mix(fg, t.bg, t.scheme === 'dark' ? 0.025 : 0.018);
  // Status colors darken or lighten toward black/white so contrast fixes keep their hue.
  const neutral = t.scheme === 'dark' ? '#ffffff' : '#000000';
  return {
    '--window': t.bg,
    '--sidebar': t.bg,
    '--bg': t.bg,
    '--panel': t.bg,
    '--panel-2': raised,
    '--ink': fg,
    '--fg': fg,
    '--ink-2': readable(t.legend, t.bg, fg),
    '--muted': muted,
    '--faint': faint,
    '--line': line,
    '--line-2': t.grid,
    '--hover': mix(accent, t.bg, 0.08),
    '--selected': mix(accent, t.bg, 0.15),
    '--pill': raised,
    '--pill-active': mix(accent, t.bg, 0.18),
    '--blue': accent,
    '--accent': accent,
    '--blue-soft': mix(accent, t.bg, 0.12),
    '--red': readable(t.negative, t.bg, fg),
    '--red-deep': t.negative,
    '--red-soft': mix(t.negative, t.bg, 0.1),
    '--red-line': mix(t.negative, t.bg, 0.4),
    '--green': readable(semanticColor(t.series, 135, '#2f9e5b'), t.bg, neutral),
    '--amber': readable(semanticColor(t.series, 38, '#c98a10'), t.bg, neutral),
    '--on-accent':
      contrast(accent, '#000000') > contrast(accent, '#ffffff')
        ? '#000000'
        : '#ffffff',
    '--shadow-md': `0 8px 32px ${mix(fg, t.bg, 0.08)}`,
    '--font': "'Geist Variable', sans-serif",
    '--mono': monoFont,
    '--prose-font': "'Geist Variable', sans-serif",
    '--r-sm': '6px',
    '--r-md': '8px',
    '--r-lg': '12px',
    '--r-xl': '16px',
  };
}
