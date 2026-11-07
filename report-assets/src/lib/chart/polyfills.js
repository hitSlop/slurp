// Deliberately limited to the plain JSON report/config trees used by Vega-Lite.
// Not a general structured-clone implementation (no transfer, Map, cycles, etc).
globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));
// Static-render scheduling only: these are microtasks, not elapsed-time timers.
// Vega runAsync/toSVG in this fixture needs no transitions or real clock timers.
let timerId = 0;
const timers = new Map();
globalThis.setTimeout = (fn, _delay, ...args) => {
  const id = ++timerId;
  timers.set(id, true);
  Promise.resolve().then(() => {
    if (timers.delete(id)) fn(...args);
  });
  return id;
};
globalThis.clearTimeout = (id) => timers.delete(id);
// Vega captures these during module initialization; static fixtures do not call them.
globalThis.setInterval = () => {
  throw new Error('Intervals are unavailable in static rendering');
};
globalThis.clearInterval = globalThis.clearTimeout;
