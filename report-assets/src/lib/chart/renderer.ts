import type { View } from 'vega';
import type { VisualizationSpec } from 'vega-embed';
import { embedOptions } from './prepare';

export type PlotBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};
export type ViewportUpdate = {
  signals: Record<string, unknown>;
  dimensions: { width?: number; height?: number };
};

/** Owns one renderer lifetime; UI state and data requests remain outside it. */
export function createRenderer(
  host: HTMLElement,
  tooltipId: string,
  onerror: (error: unknown) => void,
  onlayout?: (box: PlotBounds) => void,
) {
  const surface = document.createElement('div');
  host.appendChild(surface);
  let view: View | undefined,
    disposed = false,
    frame = 0,
    running = false,
    dirty = false;
  let latest: ViewportUpdate = { signals: {}, dimensions: {} };
  function bounds() {
    if (!view || disposed) return;
    const [x, y] = view.origin(),
      b = host.getBoundingClientRect();
    onlayout?.({
      left: b.left + x,
      top: b.top + y,
      width: view.width(),
      height: view.height(),
    });
  }
  function schedule() {
    if (
      disposed ||
      running ||
      frame ||
      !view ||
      !host.getClientRects().length ||
      host.clientWidth === 0
    )
      return;
    frame = requestAnimationFrame(async () => {
      frame = 0;
      if (
        disposed ||
        !view ||
        !host.getClientRects().length ||
        host.clientWidth === 0
      )
        return;
      running = true;
      dirty = false;
      try {
        const { signals, dimensions } = latest;
        if (dimensions.width !== undefined) view.width(dimensions.width);
        if (dimensions.height !== undefined) view.height(dimensions.height);
        for (const [key, value] of Object.entries(signals))
          view.signal(key, value);
        await view.runAsync();
        bounds();
      } catch (e) {
        if (!disposed) onerror(e);
      } finally {
        running = false;
        if (dirty) schedule();
      }
    });
  }
  const observer = new ResizeObserver(() => {
    if (
      !view ||
      disposed ||
      !host.getClientRects().length ||
      host.clientWidth === 0
    )
      return;
    view.resize();
    dirty = true;
    schedule();
  });
  observer.observe(host);
  return {
    async mount(spec: VisualizationSpec) {
      try {
        const [{ default: embed }, { expressionInterpreter }] =
          await Promise.all([import('vega-embed'), import('vega-interpreter')]);
        if (disposed) return;
        const result = await embed(surface, spec, {
          ...embedOptions,
          tooltip: { id: tooltipId, disableDefaultStyle: true },
          expr: expressionInterpreter,
        });
        if (disposed) {
          result.view.finalize();
          return;
        }
        view = result.view;
        dirty = true;
        schedule();
      } catch (e) {
        if (!disposed) onerror(e);
      }
    },
    updateViewport(update: ViewportUpdate) {
      latest = update;
      dirty = true;
      schedule();
    },
    resize() {
      if (view) {
        view.resize();
        dirty = true;
        schedule();
      }
    },
    destroy() {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      view?.finalize();
      document.getElementById(tooltipId)?.remove();
      surface.remove();
    },
  };
}
