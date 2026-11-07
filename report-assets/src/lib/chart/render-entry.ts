import { compile } from 'vega-lite';
import type { TopLevelSpec } from 'vega-lite';
import { parse, View, logger as vegaLogger } from 'vega';
import { expressionInterpreter } from 'vega-interpreter';
import { prepareChart, parseOptions, chartSize } from './prepare';
import { vegaTheme } from '../vegaTheme';
import { paletteFor, type Theme } from '../themes/palette';
import type { QueryResult } from '../api/types';

export async function compileChart(
  spec: Record<string, unknown>,
  result: Pick<QueryResult, 'columns' | 'rows'>,
  {
    theme = 'light',
    font = 'Geist',
    width = chartSize.width,
    height = chartSize.height,
  }: {
    theme?: string | Theme;
    font?: string;
    width?: number;
    height?: number;
  } = {},
) {
  const warnings: string[] = [];
  const logger = vegaLogger();
  logger.warn = (...messages: unknown[]) => {
    warnings.push(messages.join(' '));
    return logger;
  };
  logger.info = logger.debug = () => logger;
  logger.error = (...messages: unknown[]) => {
    throw new Error(messages.join(' '));
  };
  let view: View | undefined;
  try {
    const prepared = prepareChart(spec, result, {
      theme: vegaTheme(paletteFor(theme), font),
      width,
      height,
    });
    const units = new Map<string, string>();
    const tagUnits = (
      node: Record<string, unknown>,
      path: string,
      source: Record<string, unknown>,
    ) => {
      if (node.mark) {
        const name =
          typeof node.name === 'string'
            ? node.name
            : `slurp_unit_${units.size}`;
        node.name = name;
        units.set(name + '_marks', path);
      }
      for (const key of ['layer', 'concat', 'hconcat', 'vconcat']) {
        const children = node[key];
        if (Array.isArray(children))
          children.forEach((child, i) => {
            const original = (
              source[key] as Record<string, unknown>[] | undefined
            )?.[i];
            tagUnits(
              child,
              original ? `${path}.${key}[${i}]` : path,
              original ?? source,
            );
          });
      }
      if (node.spec)
        tagUnits(
          node.spec as Record<string, unknown>,
          path + '.spec',
          (source.spec ?? source) as Record<string, unknown>,
        );
    };
    tagUnits(prepared, '', spec);
    const compiled = compile(prepared as TopLevelSpec, { logger }).spec;
    view = new View(parse(compiled, undefined, parseOptions), {
      expr: expressionInterpreter,
      renderer: 'none',
      logger,
    });
    await view.runAsync();
    const emptyData: string[] = [];
    // Faceted/rounded bars put marks in group scopes. Resolve those aliases back
    // to their compiled source and inspect scoped datasets as well as root data.
    const aliases = new Map<string, string>();
    const scoped = new Map<string, number>();
    const state = view.getState({ data: () => true, recurse: true });
    const collect = (state: {
      data?: Record<string, unknown>;
      subcontext?: unknown[];
    }) => {
      for (const [name, values] of Object.entries(state.data ?? {}))
        if (Array.isArray(values))
          scoped.set(name, (scoped.get(name) ?? 0) + values.length);
      state.subcontext?.forEach((child) => collect(child as typeof state));
    };
    collect(state);
    const size = (
      name: string,
      seen = new Set<string>(),
    ): number | undefined => {
      if (seen.has(name)) return undefined;
      seen.add(name);
      try {
        return view!.data(name).length;
      } catch {
        /* Scoped dataset. */
      }
      if (scoped.has(name)) return scoped.get(name);
      const source = aliases.get(name);
      return source ? size(source, seen) : undefined;
    };
    const inspect = (marks: unknown) => {
      if (!Array.isArray(marks)) return;
      for (const mark of marks) {
        if (mark.from?.facet)
          aliases.set(mark.from.facet.name, mark.from.facet.data);
        const path = units.get(mark.name);
        const dataset = mark.from?.data;
        if (
          path !== undefined &&
          dataset &&
          size(dataset) === 0 &&
          !emptyData.includes(path)
        )
          emptyData.push(path);
        inspect(mark.marks);
      }
    };
    inspect(compiled.marks);
    return {
      svg: await view.toSVG(),
      warnings: emptyData.length
        ? warnings.filter((w) => !w.startsWith('Infinite extent'))
        : warnings,
      emptyData,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    view?.finalize();
  }
}

Object.assign(globalThis, {
  slurpChart: { compile: compileChart },
});
