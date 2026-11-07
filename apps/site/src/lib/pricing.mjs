// Monthly USD price comparison for product-analytics event volume. Vendor figures are the published prices read on
// `asOf`; where a vendor does not publish a price for a volume the cell is null and the table says so.
export const asOf = 'November 6, 2026';
export const volumes = [1_000_000, 10_000_000, 50_000_000, 100_000_000, 1_000_000_000, 10_000_000_000];
export const headlineVolume = 50_000_000;
export const money = n => n === null ? null : n === 0 ? 'Free' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n);
export const count = n => n >= 1e9 ? n / 1e9 + 'B' : n >= 1e6 ? n / 1e6 + 'M' : n / 1e3 + 'K';
const round2 = n => Math.round(n * 100) / 100;

// Cloudflare list prices (developers.cloudflare.com, read on asOf) and the measured behavior of this Worker.
export const assumptions = {
  eventsPerRequest: 20,          // events per ingest request (SDK batch); server SDKs often send more
  compressedBytesPerEvent: 320,  // gzip NDJSON in R2, varied real-world events
  retentionMonths: 12,           // months of archives kept in R2 (steady state)
  rowsPerRequest: 0.25,          // Durable Object rows written per request with group commit (measured locally, not yet billed-side)
  cpuMsPerRequest: 1,            // Worker CPU per ingest request (measured on the real edge: p50 0 ms, p95 1 ms)
  gzipRatio: 4,                  // raw JSON bytes per stored byte (measured 6.5 on synthetic events; real events compress less)
  sealMaxBytes: 8 * 1024 * 1024, // the Worker seals an archive when this much is buffered (one R2 write each)
  sealIntervalSeconds: 600,      // ... or this long after the first buffered batch
  eventsPerSecondPerSource: 5000, // measured: one source sustains this with every request accepted (measured with backend/scripts/load.mjs; see docs/self-hosting.md)
  peakFactor: 3,                 // peak traffic over the monthly average, for deciding how many sources the volume needs
  doGBMemory: 0.128, doGBsIncluded: 400_000, doPerMillionGBs: 12.5, // Durable Object duration: an always-busy source is ~332K GB-s a month
  r2WritesIncluded: 1e6, r2PerMillionWrites: 4.5,
  days: 30,
  freeRequestsPerDay: 100_000,   // Workers Free: requests/day; the Durable Object has the same daily request cap
  freeHeadroom: 0.5,             // assume you move to Workers Paid before using half the daily cap
  paidBase: 5,                   // Workers Paid, per month
  workerRequestsIncluded: 10e6, workerPerMillion: 0.30,
  cpuMsIncluded: 30e6, cpuPerMillionMs: 0.02,
  doRequestsIncluded: 1e6, doPerMillion: 0.15,
  rowsIncluded: 50e6, rowsPerMillion: 1.0,
  r2FreeGB: 10, r2PerGBMonth: 0.015,
};
/** How many sources (Durable Objects) a monthly volume needs so peak traffic stays under what one source sustains. */
export const sourcesNeeded = (events, a = assumptions) =>
  Math.max(1, Math.ceil(events / (a.days * 86400) * a.peakFactor / a.eventsPerSecondPerSource));

/**
 * Estimated Cloudflare bill for a steady month of ingestion with `retentionMonths` of archives kept.
 * R2 storage is billed on its own (above 10 GB-month free) whatever the Workers plan; request, CPU and Durable Object
 * usage is free on the Free plan until its daily cap, so we switch to Workers Paid ($5) before half the cap is used.
 */
export function cloudflareCost(events, a = assumptions) {
  const requests = events / a.eventsPerRequest;
  const storedGB = events * a.compressedBytesPerEvent * a.retentionMonths / 1e9;
  const storage = Math.max(0, storedGB - a.r2FreeGB) * a.r2PerGBMonth;
  if (requests / a.days <= a.freeRequestsPerDay * a.freeHeadroom) return round2(storage);
  const workers = Math.max(0, requests - a.workerRequestsIncluded) / 1e6 * a.workerPerMillion;
  const cpu = Math.max(0, requests * a.cpuMsPerRequest - a.cpuMsIncluded) / 1e6 * a.cpuPerMillionMs;
  const durable = Math.max(0, requests - a.doRequestsIncluded) / 1e6 * a.doPerMillion;
  const rows = Math.max(0, requests * a.rowsPerRequest - a.rowsIncluded) / 1e6 * a.rowsPerMillion;
  const seconds = a.days * 86400;
  const sources = sourcesNeeded(events, a);
  const duration = Math.max(0, sources * a.doGBMemory * seconds - a.doGBsIncluded) / 1e6 * a.doPerMillionGBs;
  const writes = Math.max(sources * seconds / a.sealIntervalSeconds, events * a.compressedBytesPerEvent * a.gzipRatio / a.sealMaxBytes);
  const archives = Math.max(0, writes - a.r2WritesIncluded) / 1e6 * a.r2PerMillionWrites;
  return round2(a.paidBase + workers + cpu + durable + rows + duration + archives + storage);
}

/**
 * Low and high estimates for volumes we have not load-tested. The low case is compact events sent in big batches; the high
 * case is 1 KB events sent a few at a time. Both keep 12 months of archives. The headline volume does not use these.
 */
export const scenarios = {
  low: { ...assumptions, compressedBytesPerEvent: 200, eventsPerRequest: 100 },
  high: { ...assumptions, compressedBytesPerEvent: 1000, eventsPerRequest: 5 },
};
export const cloudflareRange = n => [cloudflareCost(n, scenarios.low), cloudflareCost(n, scenarios.high)];
/** From this volume up, the Slurp row is shown as a range because it is extrapolated, not measured. */
export const rangeFrom = 1_000_000_000;
/** Round an extrapolated figure to what it can honestly claim: $1 under $100, $10 under $1,000, $100 above. */
export const roughly = n => n >= 1000 ? Math.round(n / 100) * 100 : n >= 100 ? Math.round(n / 10) * 10 : Math.round(n);

// PostHog Product Analytics: usage based, per-event marginal rates. https://posthog.com/docs/product-analytics/pricing
export const posthogTiers = [[1e6, 0], [2e6, .00005], [15e6, .0000343], [50e6, .0000295], [100e6, .0000218], [250e6, .000015], [Infinity, .000009]];
export function posthogCost(n) {
  let from = 0, total = 0;
  for (const [to, rate] of posthogTiers) { total += Math.max(0, Math.min(n, to) - from) * rate; from = to; if (n <= to) break; }
  return round2(total);
}
// Mixpanel Growth, yearly billing, USD per month by events per month (1M free). Above 20M: contact sales. https://mixpanel.com/pricing/
export const mixpanelTiers = [[1e6, 0], [1.5e6, 100], [2e6, 185], [3e6, 270], [4e6, 360], [5e6, 438], [6.5e6, 561], [8e6, 680], [10e6, 840], [12.5e6, 1047], [15e6, 1230], [17.5e6, 1431], [20e6, 1635]];
export const mixpanelCost = n => mixpanelTiers.find(([cap]) => n <= cap)?.[1] ?? null;
// Amplitude: 2M events/month free; paid event pricing is not published (estimator / sales). https://amplitude.com/pricing
export const amplitudeCost = n => n <= 2e6 ? 0 : null;
// OpenPanel Cloud, billed monthly, by events per month. Above 50M: custom plan. Self-hosting is free. https://openpanel.dev/pricing
export const openpanelTiers = [[5e3, 2.5], [10e3, 5], [100e3, 20], [250e3, 30], [500e3, 50], [1e6, 90], [2.5e6, 180], [5e6, 250], [10e6, 350], [20e6, 530], [30e6, 680], [40e6, 800], [50e6, 900]];
export const openpanelCost = n => openpanelTiers.find(([cap]) => n <= cap)?.[1] ?? null;

export const tools = [
  { name: 'Slurp, self-hosted on Cloudflare', url: '/self-host/', cost: cloudflareCost, range: cloudflareRange, unpublished: '', self: true },
  { name: 'PostHog · Product Analytics', url: 'https://posthog.com/docs/product-analytics/pricing', cost: posthogCost, unpublished: 'See pricing' },
  { name: 'Mixpanel · Growth (yearly billing)', url: 'https://mixpanel.com/pricing/', cost: mixpanelCost, unpublished: 'Contact sales' },
  { name: 'Amplitude · Plus', url: 'https://amplitude.com/pricing', cost: amplitudeCost, unpublished: 'Not published' },
  { name: 'OpenPanel · Cloud (monthly)', url: 'https://openpanel.dev/pricing', cost: openpanelCost, unpublished: 'Custom plan' },
];
