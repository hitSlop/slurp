import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const scenegraph = dirname(dirname(require.resolve('vega-scenegraph', { paths: [dirname(require.resolve('vega'))] })));
export const nativeTextMetrics = {
  name: 'native-text-metrics',
  setup(builder) {
    // Use the pinned source entry so only text measurement gets the native context.
    // Other scenegraph modules keep their normal, absent canvas context.
    builder.onResolve({ filter: /^vega-scenegraph$/ }, () => ({ path: resolve(scenegraph, 'index.js') }));
    builder.onResolve({ filter: /^\.\/canvas\/context\.js$/ }, args =>
      args.importer === resolve(scenegraph, 'src/util/text.js')
        ? { path: resolve('src/lib/chart/text-context.ts') } : undefined);
  },
};
