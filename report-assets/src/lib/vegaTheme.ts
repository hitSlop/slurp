import type { Config } from 'vega-lite';
import { type Theme, monoFont, readable, themeTokens } from './themes/palette';
export type ChartScheme = 'light' | 'dark';

export function vegaTheme(t: Theme, font = monoFont): Config {
  const fg = themeTokens(t)['--ink-2'];
  return {
    background: 'transparent',
    font,
    // prepareChart supplies UTC scales/time units, so these formats use UTC.
    timeFormat: '%Y-%m-%d %H:%M UTC',
    view: { stroke: null },
    axis: {
      labelFontSize: 11,
      labelColor: readable(t.axisTicks, t.bg, fg),
      titleFontSize: 13,
      titleFontWeight: 500,
      titleColor: fg,
      gridColor: t.grid,
      domainColor: t.axisLines,
      tickColor: t.axisLines,
      labelPadding: 8,
      labelOverlap: 'greedy',
      labelSeparation: 8,
      titlePadding: 12,
    },
    axisX: { tickCount: 5 },
    axisY: { domain: false, ticks: false },
    legend: {
      labelLimit: 220,
      labelColor: readable(t.legend, t.bg, fg),
      titleColor: fg,
      labelFontSize: 11,
      orient: 'bottom',
      symbolType: 'circle',
    },
    range: { category: t.series },
    bar: { cornerRadiusEnd: 0, color: t.series[0] },
    line: { strokeWidth: 1.5, color: t.series[0] },
    point: { color: t.series[0] },
    text: { color: fg },
    area: { opacity: 0.15 },
    mark: { tooltip: true },
  };
}
