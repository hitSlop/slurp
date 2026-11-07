import type { QueryResult } from '../api/types';
import type { Config } from 'vega-lite';
import { numeric, utcDate } from '../format';
import { contrast, readable, mix } from '../themes/palette';

export const chartSize = { width: 640, height: 260 } as const;
export const embedOptions = {
  actions: false,
  renderer: 'svg',
  ast: true,
} as const;
export const parseOptions = { ast: true } as const;

export function safeSpec(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(safeSpec);
  if (node && typeof node === 'object')
    return Object.fromEntries(
      Object.entries(node)
        .filter(([key]) => !['data', 'datasets', 'url', 'href'].includes(key))
        .map(([k, v]) => [k, safeSpec(v)]),
    );
  return node;
}

// SQL integers/decimals arrive as strings to preserve their precision on the wire.
// Coerce every numeric field, including sort/color/text, but preserve wide values.
export function chartNumber(value: unknown, type: string) {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    !numeric(type) ||
    /^U?HUGEINT/i.test(type)
  )
    return value;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER
    ? n
    : value;
}

function discreteYFields(node: unknown, fields = new Set<string>()) {
  if (!node || typeof node !== 'object') return fields;
  const obj = node as Record<string, unknown>;
  const y = (
    obj.encoding as Record<string, Record<string, unknown>> | undefined
  )?.y;
  if (
    typeof y?.field === 'string' &&
    ['nominal', 'ordinal'].includes(String(y.type))
  )
    fields.add(y.field);
  for (const key of ['layer', 'spec', 'hconcat', 'vconcat', 'concat']) {
    const child = obj[key];
    if (Array.isArray(child)) child.forEach((v) => discreteYFields(v, fields));
    else discreteYFields(child, fields);
  }
  return fields;
}

// Dates follow their encoding, not their column type. A field the spec encodes as
// temporal (`type: temporal` or a `timeUnit`, anywhere in the spec) becomes epoch
// milliseconds, which time scales need. Every other DATE/TIMESTAMP value keeps its ISO
// text, so a nominal or ordinal axis, legend or tooltip reads `2025-12-29`, never
// `1766966400000`.
export function rowValues(
  spec: unknown,
  result: Pick<QueryResult, 'columns' | 'rows'>,
) {
  const temporal = new Set<string>();
  const geographic = new Set<string>();
  const findGeographic = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const def = node as Record<string, unknown>;
    if (def.type === 'geojson' && typeof def.field === 'string') geographic.add(def.field);
    Object.values(node).forEach(findGeographic);
  };
  findGeographic(spec);
  temporalDefinitions(spec, (def) => {
    if (typeof def.field === 'string') temporal.add(def.field);
  });
  return result.rows.map((row) =>
    Object.fromEntries(
      result.columns.map((c, i) => {
        const v = row[i];
        const date =
          typeof v === 'string' && temporal.has(c.name)
            ? utcDate(v).getTime()
            : NaN;
        const shape = geographic.has(c.name) && v && typeof v === 'object' && !Array.isArray(v) && 'type' in v && ['Point','MultiPoint','LineString','MultiLineString','Polygon','MultiPolygon','GeometryCollection'].includes(String(v.type))
          ? { type: 'Feature', properties: {}, geometry: v } : v;
        return [c.name, Number.isFinite(date) ? date : chartNumber(shape, c.type)];
      }),
    ),
  );
}

// Traverse layers, facets, conditions and tooltip arrays through the same shared path.
function temporalDefinitions(
  node: unknown,
  visit: (def: Record<string, unknown>) => void,
) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((v) => temporalDefinitions(v, visit));
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.type === 'temporal' || obj.timeUnit) visit(obj);
  Object.values(obj).forEach((v) => temporalDefinitions(v, visit));
}
function utcEncodings(node: unknown) {
  temporalDefinitions(node, (def) => {
    if (def.scale !== null && def.scale !== false)
      def.scale = { ...((def.scale as object) ?? {}), type: 'utc' };
    if (typeof def.timeUnit === 'string')
      def.timeUnit = { unit: def.timeUnit.replace(/^utc/, ''), utc: true };
    else if (def.timeUnit && typeof def.timeUnit === 'object')
      def.timeUnit = { ...def.timeUnit, utc: true };
  });
}

function nominalLabels(node: unknown) {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const encoding = obj.encoding as
    Record<string, Record<string, unknown>> | undefined;
  for (const channel of ['x', 'y']) {
    const def = encoding?.[channel];
    if (def?.type === 'nominal' && def.axis !== null && def.axis !== false)
      def.axis = {
        labelLimit: 220,
        labelOverlap: false,
        ...((def.axis as object) ?? {}),
      };
  }
  Object.values(obj).forEach(nominalLabels);
}

export const miniSize = { width: 96, height: 32 } as const;

const positionalChannels = ['x', 'y', 'x2', 'y2', 'xOffset', 'yOffset'];
const legendChannels = [
  'color',
  'fill',
  'stroke',
  'size',
  'shape',
  'opacity',
  'fillOpacity',
  'strokeOpacity',
  'strokeWidth',
  'strokeDash',
  'angle',
  'radius',
  'theta',
];

function markType(mark: unknown) {
  return typeof mark === 'string'
    ? mark
    : mark && typeof mark === 'object' && 'type' in mark
      ? String((mark as { type: unknown }).type)
      : '';
}

// Reduce a spec to a bare sparkline, in place: one view, no axes, legends, titles,
// headers or annotation layers, whatever depth the encodings live at.
export function miniSpec(node: unknown): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  // Composite specs render their first view only.
  for (const key of ['concat', 'hconcat', 'vconcat'])
    if (Array.isArray(obj[key])) {
      const [first] = obj[key] as Record<string, unknown>[];
      delete obj[key];
      Object.assign(obj, first);
      return miniSpec(obj);
    }
  if ('facet' in obj || 'repeat' in obj) {
    const inner = obj.spec as Record<string, unknown> | undefined;
    delete obj.facet;
    delete obj.repeat;
    delete obj.spec;
    if (inner) Object.assign(obj, inner);
    return miniSpec(obj);
  }
  for (const key of ['title', 'header', 'width', 'height', 'autosize'])
    delete obj[key];
  if (Array.isArray(obj.layer)) {
    const kept = (obj.layer as Record<string, unknown>[]).filter(
      (layer) => !['text', 'rule'].includes(markType(layer.mark)),
    );
    if (kept.length) obj.layer = kept;
    (obj.layer as unknown[]).forEach(miniSpec);
  }
  if (obj.spec) miniSpec(obj.spec);
  const encoding = obj.encoding as
    Record<string, Record<string, unknown>> | undefined;
  if (encoding)
    for (const [channel, def] of Object.entries(encoding)) {
      if (!def || typeof def !== 'object' || Array.isArray(def)) continue;
      if (positionalChannels.includes(channel)) def.axis = null;
      if (legendChannels.includes(channel)) def.legend = null;
      delete def.title;
    }
}

export function prepareChart(
  spec: Record<string, unknown>,
  result: Pick<QueryResult, 'columns' | 'rows'>,
  {
    theme,
    width = chartSize.width,
    height = chartSize.height,
    mini = false,
  }: {
    theme: Config;
    width?: number | 'container';
    height?: number;
    mini?: boolean;
  },
) {
  let config = mini
    ? {
        ...theme,
        axis: {
          ...theme.axis,
          labels: false,
          title: null,
          ticks: false,
          grid: false,
          domain: false,
        },
        legend: { disable: true },
      }
    : theme;
  const clean = safeSpec(spec) as Record<string, unknown>;
  // A chart surface may differ from the app surface. Repair static text colors
  // against that surface, while preserving authored data colors.
  const bg =
    typeof clean.background === 'string' && clean.background !== 'transparent'
      ? clean.background
      : undefined;
  if (bg) {
    const fg =
      contrast('#161616', bg) >= contrast('#ffffff', bg)
        ? '#161616'
        : '#ffffff';
    const repair = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(repair);
        return;
      }
      const obj = node as Record<string, unknown>;
      for (const key of ['labelColor', 'titleColor']) {
        if (typeof obj[key] === 'string')
          obj[key] = readable(obj[key] as string, bg, fg);
      }
      Object.values(obj).forEach(repair);
    };
    config = structuredClone(config);
    repair(config);
    repair(clean);
    for (const key of ['axis', 'axisX', 'axisY']) {
      const axis = (config[key as keyof typeof config] ?? {}) as Record<
        string,
        unknown
      >;
      Object.assign(axis, {
        labelColor: fg,
        titleColor: fg,
        gridColor: mix(fg, bg, 0.15),
        domainColor: mix(fg, bg, 0.4),
        tickColor: mix(fg, bg, 0.4),
      });
      Object.assign(config, { [key]: axis });
    }
    config = {
      ...config,
      text: { ...config.text, color: fg },
      title: { color: fg },
      header: { labelColor: fg, titleColor: fg },
      legend: { ...config.legend, labelColor: fg, titleColor: fg },
    };
  }
  nominalLabels(clean);
  utcEncodings(clean);
  const mark = clean.mark;
  const encoding = clean.encoding as
    Record<string, Record<string, unknown>> | undefined;
  if (
    !mini &&
    (mark === 'line' ||
      (typeof mark === 'object' &&
        mark !== null &&
        'type' in mark &&
        mark.type === 'line')) &&
    encoding?.x?.field
  ) {
    delete clean.mark;
    clean.layer = [
      { mark },
      {
        params: [
          {
            name: 'slurp_hover',
            select: {
              type: 'point',
              nearest: true,
              on: 'pointerover',
              clear: 'pointerout',
              fields: [encoding.x.field],
            },
          },
        ],
        mark: { type: 'point', filled: true, size: 45 },
        encoding: {
          opacity: {
            condition: { param: 'slurp_hover', empty: false, value: 1 },
            value: 0,
          },
        },
      },
    ];
  }
  if (mini) miniSpec(clean);

  const values = rowValues(spec, result);
  const step = clean.height as { step?: unknown } | undefined;
  const explicitStep =
    typeof step === 'object' &&
    step !== null &&
    ((typeof step.step === 'number' &&
      Number.isFinite(step.step) &&
      step.step > 0) ||
      (typeof step.step === 'object' &&
        step.step !== null &&
        'expr' in step.step));
  const autoStep =
    clean.height === undefined &&
    [...discreteYFields(clean)].some(
      (field) => new Set(values.map((row) => row[field])).size > 12,
    );
  if (mini)
    return {
      ...clean,
      ...miniSize,
      padding: 0,
      autosize: { type: 'none' },
      background: 'transparent',
      data: { values },
      config: { ...config, view: { ...config.view, stroke: null } },
    };
  return {
    ...clean,
    width:
      typeof clean.width === 'object' || typeof clean.width === 'number'
        ? clean.width
        : width,
    height:
      explicitStep || typeof clean.height === 'number'
        ? clean.height
        : autoStep
          ? { step: 20 }
          : height,
    data: { values },
    config,
  };
}
