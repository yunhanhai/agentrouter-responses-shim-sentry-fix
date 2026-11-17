// cursor-retry extension (local patch, 2026-10-28) — CLI glue for bin entry.
// Merges retry/routing/proxy flags into parseArgs options and resolves them
// into the server config. Kept separate so server.mjs changes stay minimal.

import { configFromOverrides, RETRY_OPTIONS } from './retry-routing.mjs';

export { RETRY_OPTIONS };

export const EXTRA_HELP = `
Cursor-retry patch options (all optional, default off):

  --retry-429 N        Retry retryable statuses before first upstream byte (default 0 = off)
  --retry-statuses S   Comma list / range of retryable statuses (default 429,502,503,504;
                       e.g. "404,429,502-504")
  --retry-stream       Also retry a 200 stream whose *first* events are a transient
                       upstream failure (e.g. "Concurrency limit exceeded")
  --retry-stream-hold-ms N  Max time to hold the response head while waiting for the
                       first content event (default 6000)
  --retry-backoff-ms N Initial backoff, doubles per attempt (default 30000)
  --retry-max-wait-ms N Backoff ceiling (default 180000)
  --max-images N       Keep only the newest N image blocks in replayed history,
                       older ones become text placeholders (default 0 = off)
  --routes FILE        JSON prefix-routing table (multi-upstream mode)
  --proxy URL          Outbound http proxy via CONNECT (per-route "proxy" overrides)

Routes file example:
  { "any":  { "upstream": "https://aynrouter.top/v1", "proxy": "http://127.0.0.1:10808" },
    "ely":  { "upstream": "https://elysiver.h-e.top/v1" } }
Client API base: http://127.0.0.1:18081/<prefix>/v1
`;

/**
 * Extends the raw CLI parse result with retry config and returns the final
 * merged config plus a resolved-routes getter.
 *
 * Returns { config, retry, routes } where:
 *   - config is the original shim config (untouched fields)
 *   - retry: { retry429, retryBackoffMs, retryMaxWaitMs, maxImages, proxyUrl }
 *   - routes: Map|null (prefix → { base: URL, proxy: URL|null })
 */
export function applyRetryOptions(env, parsedValues, baseConfig) {
  const overrides = {
    'retry-429': parsedValues['retry-429'],
    'retry-backoff-ms': parsedValues['retry-backoff-ms'],
    'retry-max-wait-ms': parsedValues['retry-max-wait-ms'],
    'retry-statuses': parsedValues['retry-statuses'],
    'retry-stream': parsedValues['retry-stream'],
    'retry-stream-hold-ms': parsedValues['retry-stream-hold-ms'],
    'max-images': parsedValues['max-images'],
    routes: parsedValues.routes,
    proxy: parsedValues.proxy,
  };
  const retry = configFromOverrides(env, overrides);
  return { config: baseConfig, retry, routes: retry.routes };
}
