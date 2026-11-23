// cursor-retry extension (local patch, 2026-10-28)
//
// Adds opt-in features on top of agentrouter-responses-shim 2.0.1:
//   1. --routes FILE      path-prefix based multi-upstream routing (multi-provider mode)
//   2. --proxy URL        outbound HTTP(S) proxy via CONNECT tunnel (per-route or global)
//   3. --retry-429 N      retry 429/5xx before the first upstream byte with exponential backoff
//
// All three default OFF. Without them, server.mjs behaves exactly like the
// unpatched shim (the running Codex instance on :18080 passes no such flags).
// Retry happens ONLY before any upstream byte reaches the client: Azure/OpenAI
// rate limits reject at request entry with an HTTP 429 status and empty body,
// which is precisely the pre-first-byte window. Once the shim has written the
// response head (or any SSE byte) to the client, retrying is impossible —
// the client already consumed content.

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { readFileSync } from 'node:fs';

// ── CLI/env surface ─────────────────────────────────────────────────────────

export const RETRY_OPTIONS = {
  'retry-429': { type: 'string' },
  'retry-backoff-ms': { type: 'string' },
  'retry-max-wait-ms': { type: 'string' },
  'retry-statuses': { type: 'string' },
  'retry-stream': { type: 'boolean' },
  'retry-stream-hold-ms': { type: 'string' },
  'stream-idle-timeout-ms': { type: 'string' },
  'ensure-prompt-cache-key': { type: 'boolean' },
  'max-images': { type: 'string' },
  routes: { type: 'string' },
  proxy: { type: 'string' },
};

export const RETRY_ENV = {
  retry429: { env: 'SHIM_RETRY_429', fallback: 0 },
  retryBackoffMs: { env: 'SHIM_RETRY_BACKOFF_MS', fallback: 30000 },
  retryMaxWaitMs: { env: 'SHIM_RETRY_MAX_WAIT_MS', fallback: 180000 },
  retryStatuses: { env: 'SHIM_RETRY_STATUSES', fallback: '429,502,503,504' },
  retryStream: { env: 'SHIM_RETRY_STREAM', fallback: '' },
  retryStreamHoldMs: { env: 'SHIM_RETRY_STREAM_HOLD_MS', fallback: 6000 },
  streamIdleTimeoutMs: { env: 'SHIM_STREAM_IDLE_TIMEOUT_MS', fallback: 600000 },
  ensurePromptCacheKey: { env: 'SHIM_ENSURE_PROMPT_CACHE_KEY', fallback: '' },
  maxImages: { env: 'SHIM_MAX_IMAGES', fallback: 0 },
  routesFile: { env: 'SHIM_ROUTES_FILE', fallback: '' },
  proxyUrl: { env: 'SHIM_PROXY', fallback: '' },
};

// Transient transport failures retried before any client byte is written:
// relay domains rotate and their DNS occasionally drops for seconds.
export const RETRYABLE_TRANSPORT = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPROTO',
  'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

/** Parse + validate the retry/routing/proxy options. Returns null-safe defaults when disabled. */
export function configFromOverrides(env = process.env, overrides = {}) {
  const pick = (key, mapping) => {
    const fromArgs = overrides[key];
    if (fromArgs !== undefined) return fromArgs;
    const raw = env[mapping.env];
    return raw === undefined || raw === '' ? mapping.fallback : raw;
  };
  const retry429 = integer2(pick('retry-429', RETRY_ENV.retry429), 0, 'retry-429', 50);
  const retryBackoffMs = integer2(pick('retry-backoff-ms', RETRY_ENV.retryBackoffMs), 30000, 'retry-backoff-ms', 600000);
  const retryMaxWaitMs = integer2(pick('retry-max-wait-ms', RETRY_ENV.retryMaxWaitMs), 180000, 'retry-max-wait-ms', 3600000);
  // stream-error retry: an upstream may answer 200 + SSE `response.failed`
  // (e.g. "Concurrency limit exceeded"). Buffering until the first content
  // event lets the shim retry without the client ever seeing the failure.
  const retryStatuses = statusList(pick('retry-statuses', RETRY_ENV.retryStatuses));
  const retryStream = booleanish(pick('retry-stream', RETRY_ENV.retryStream));
  // Upper bound on how long the head may be held waiting for the first content
  // event. Prevents a slow first token from looking like a hung request.
  const retryStreamHoldMs = integer2(pick('retry-stream-hold-ms', RETRY_ENV.retryStreamHoldMs), 6000, 'retry-stream-hold-ms', 60000);
  // Idle budget for an already-open SSE stream: reasoning models can stay
  // silent for minutes; a short socket timeout here truncates the client body.
  const streamIdleTimeoutMs = integer2(pick('stream-idle-timeout-ms', RETRY_ENV.streamIdleTimeoutMs), 600000, 'stream-idle-timeout-ms', 3600000);
  // Some relays reject /responses without prompt_cache_key; opt-in injection.
  const ensurePromptCacheKey = booleanish(pick('ensure-prompt-cache-key', RETRY_ENV.ensurePromptCacheKey));
  // image-limit extension: keep only the newest N images in replayed history.
  // Gateways commonly cap images per request (e.g. 50); 0 disables the trim.
  const maxImages = integer2(pick('max-images', RETRY_ENV.maxImages), 0, 'max-images', 1000);
  const routesFile = String(pick('routes', RETRY_ENV.routesFile) || '');
  const proxyUrl = String(pick('proxy', RETRY_ENV.proxyUrl) || '');
  const routes = routesFile ? loadRoutes(routesFile) : null;
  if (proxyUrl) proxyURL(proxyUrl); // validate early
  return { retry429, retryBackoffMs, retryMaxWaitMs, retryStatuses, retryStream, retryStreamHoldMs, streamIdleTimeoutMs, ensurePromptCacheKey, maxImages, routes, routesFile, proxyUrl };
}

/** "429,404,5xx" -> [429,404,500,501,...]; unknown tokens are ignored, order preserved. */
function statusList(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return [429, 502, 503, 504];
  const out = [];
  for (const token of raw.split(',')) {
    const t = token.trim().toLowerCase();
    if (!t) continue;
    const range = t.match(/^(\d{3})-(\d{3})$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (!(from >= 100 && to <= 599 && from <= to)) throw new Error(`--retry-statuses: bad range ${t}`);
      for (let s = from; s <= to; s++) if (!out.includes(s)) out.push(s);
      continue;
    }
    const code = Number(t);
    if (!Number.isInteger(code) || code < 100 || code > 599) throw new Error(`--retry-statuses: bad status ${t}`);
    if (!out.includes(code)) out.push(code);
  }
  return out.length ? out : [429, 502, 503, 504];
}

function booleanish(value) {
  if (value === true) return true;
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function integer2(value, fallback, name, maximum) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 0 and ${maximum}.`);
  }
  return parsed;
}

function proxyURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('--proxy must be an absolute http:// URL.'); }
  if (url.protocol !== 'http:') throw new Error('--proxy only supports http:// proxies (CONNECT tunnel).');
  return url;
}

/** routes file: { "<prefix>": { "upstream": "https://...", "proxy": "http://..." | "" } , ... } */
function loadRoutes(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (error) {
    throw new Error(`--routes: cannot read ${file}: ${error.message}`);
  }
  const routes = new Map();
  for (const [prefix, entry] of Object.entries(parsed)) {
    if (!prefix || !/^[a-z0-9_-]+$/i.test(prefix)) throw new Error(`--routes: invalid prefix "${prefix}".`);
    if (prefix === 'healthz' || prefix === 'v1') throw new Error(`--routes: prefix "${prefix}" is reserved.`);
    if (!entry?.upstream) throw new Error(`--routes: prefix "${prefix}" is missing "upstream".`);
    const upstream = new URL(entry.upstream);
    if (upstream.protocol !== 'https:' && upstream.protocol !== 'http:') {
      throw new Error(`--routes: prefix "${prefix}" upstream must be http(s).`);
    }
    const proxy = entry.proxy ? proxyURL(entry.proxy) : null;
    // Optional active/standby: when the primary keeps failing, switch to fallback.
    let fallback = null;
    if (entry.fallback) {
      const fb = typeof entry.fallback === 'string' ? { upstream: entry.fallback } : entry.fallback;
      if (!fb.upstream) throw new Error(`--routes: prefix "${prefix}" fallback is missing "upstream".`);
      const fbUpstream = new URL(fb.upstream);
      if (fbUpstream.protocol !== 'https:' && fbUpstream.protocol !== 'http:') {
        throw new Error(`--routes: prefix "${prefix}" fallback upstream must be http(s).`);
      }
      fbUpstream.pathname = fbUpstream.pathname.replace(/\/+$/, '');
      fallback = { base: fbUpstream, proxy: fb.proxy ? proxyURL(fb.proxy) : null };
    }
    const failover = {
      failures: Number(entry.failover?.failures) > 0 ? Number(entry.failover.failures) : 3,
      cooldownMs: Number(entry.failover?.cooldownMs) > 0 ? Number(entry.failover.cooldownMs) : 120000,
    };
    // Per-route budget overrides: slow upstreams (long prompts) need a much
    // larger header timeout than fast ones, and fewer retries to stay inside
    // the client's first-byte budget.
    const budget = {
      timeoutMs: Number(entry.timeoutMs) > 0 ? Number(entry.timeoutMs) : null,
      retries: Number.isFinite(Number(entry.retries)) && Number(entry.retries) >= 0 ? Number(entry.retries) : null,
      backoffMs: Number(entry.backoffMs) > 0 ? Number(entry.backoffMs) : null,
      maxWaitMs: Number(entry.maxWaitMs) > 0 ? Number(entry.maxWaitMs) : null,
    };
    routes.set(`/${prefix}`, {
      prefix: `/${prefix}`,
      base: upstream, // URL, pathname already as given (trailing slash stripped below)
      proxy,
      fallback,
      failover,
      budget,
    });
    const record = routes.get(`/${prefix}`);
    record.base.pathname = record.base.pathname.replace(/\/+$/, '');
  }
  if (routes.size === 0) throw new Error('--routes: file must define at least one prefix.');
  return routes;
}

// ── Request-path resolution ─────────────────────────────────────────────────

/**
 * Splits a request URL into (route, remainder path+search).
 * In multi-route mode: "/<prefix>/v1/responses" → route "<prefix>", "/v1/responses".
 * In single-upstream mode: returns null route (caller uses the fixed base).
 */
export function resolveRoute(pathnameWithSearch, routes) {
  if (!routes) return { route: null, rest: pathnameWithSearch };
  const queryStart = pathnameWithSearch.indexOf('?');
  const pathname = queryStart === -1 ? pathnameWithSearch : pathnameWithSearch.slice(0, queryStart);
  const search = queryStart === -1 ? '' : pathnameWithSearch.slice(queryStart);
  const match = pathname.match(/^\/([a-z0-9_-]+)(?=\/|$)/i);
  if (!match) throw new Error('missing route prefix');
  const route = routes.get(`/${match[1].toLowerCase()}`);
  if (!route) throw new Error(`unknown route prefix "/${match[1]}"`);
  return { route, rest: `${pathname.slice(match[1].length + 1)}${search}` };
}

// ── Proxy tunneling ─────────────────────────────────────────────────────────

/**
 * Establishes a CONNECT tunnel through proxyUrl to targetHost:targetPort and
 * invokes cb(err, socket). https.request to the CONNECT endpoint.
 */
function connectViaProxy(proxy, targetHost, targetPort, timeoutMs, cb) {
  const req = http.request({
    host: proxy.hostname,
    port: Number(proxy.port) || 80,
    method: 'CONNECT',
    path: `${targetHost}:${targetPort}`,
    headers: { host: `${targetHost}:${targetPort}` },
  });
  req.setTimeout(timeoutMs, () => req.destroy(new Error('proxy CONNECT timed out')));
  req.once('connect', (res, socket) => {
    if (res.statusCode !== 200) {
      socket.destroy();
      cb(new Error(`proxy CONNECT failed: ${res.statusCode}`));
      return;
    }
    cb(null, socket);
  });
  req.once('error', (error) => cb(error));
  req.end();
}

/**
 * Creates the transport request for an upstream call.
 *
 * - no proxy  → plain http/https.request (original shim behavior, http/1.1)
 * - proxy     → undici ProxyAgent. This is deliberate: several pooled gateways
 *               (e.g. Azure-fronted CDNs) REJECT http/1.1-only ALPN ClientHellos
 *               (alert 40) and require h2. undici negotiates h2 transparently
 *               (allowH2 defaults true in its connector) and matches the exact
 *               transport stack Cursor++ itself uses (undici ^8.3 + ProxyAgent).
 *
 * The returned "outgoing" mimics the minimal ClientRequest surface used by
 * forwardWithRetry: .on('response'), .on('error'), .setTimeout, .destroy, .end.
 */
export function createUpstreamRequest(target, options, headers, onRequestReady) {
  const proxy = options.proxy || null;

  if (!proxy) {
    const transport = target.protocol === 'https:' ? https : http;
    const outgoing = transport.request(target, { method: options.method, headers });
    onRequestReady(null, outgoing, null);
    return;
  }

  // undici path — h2-capable, proxy-aware. Lazily loaded so the plain (no-proxy)
  // path keeps zero new runtime deps.
  import('undici').then(({ ProxyAgent, request }) => {
    const dispatcher = new ProxyAgent({ uri: proxy.href });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('upstream timeout')), options.timeoutMs || 300000);
    if (typeof timer.unref === 'function') timer.unref();

    let settled = false;
    let aborted = false;

    const outgoing = {
      destroyed: false,
      once(event, fn) {
        if (event === 'response') this._onResponse = fn;
        else if (event === 'error') this._onError = fn;
        return this;
      },
      setTimeout() { /* abort timer above covers it */ return this; },
      destroy() {
        this.destroyed = true;
        aborted = true;
        controller.abort(new Error('client gone'));
      },
      end(payload) {
        const hostHeader = `${target.hostname}${target.port ? `:${target.port}` : ''}`;
        request(target.href, {
          method: options.method,
          headers: { ...headers, host: hostHeader },
          dispatcher,
          body: payload,
          signal: controller.signal,
        }).then((response) => {
          if (aborted) { response.body.destroy(); return; }
          settled = true;
          clearTimeout(timer);
          // Shim a minimal response surface: statusCode + headers + pipe + events.
          const shimmed = {
            statusCode: response.statusCode,
            headers: Object.fromEntries(response.headers.entries ? [...response.headers.entries()] : Object.entries(response.headers)),
            destroyed: false,
            _onError: null,
            once(event, fn) {
              if (event === 'error') this._onError = fn;
              else if (event === 'data' || event === 'end') this.body?.once(event, fn);
              return this;
            },
            on(event, fn) { if (event === 'data' || event === 'end') this.body?.on(event, fn); return this; },
            resume() { this.body?.resume(); return this; },
            pipe(dest) {
              // Stream with backpressure; forward errors so the retry layer sees mid-stream failures.
              this.body.on('error', (e) => { if (this._onError) this._onError(e); dest.destroy(); });
              this.body.pipe(dest);
              return dest;
            },
            destroy() { this.destroyed = true; this.body?.destroy(); },
          };
          // Attach body before on('data') registrations happen in caller.
          shimmed.body = response.body;
          if (outgoing._onResponse) outgoing._onResponse(shimmed);
        }).catch((error) => {
          clearTimeout(timer);
          if (!settled && outgoing._onError) outgoing._onError(error);
          else if (!settled) onRequestReady(error, null, null);
        });
        return outgoing;
      },
    };
    onRequestReady(null, outgoing, null);
  }).catch((error) => onRequestReady(error, null, null));
}

// Emits a protocol-valid SSE error frame when the client head is already out:
// destroying the socket mid-chunk surfaces as "error decoding response body"
// on the client, while a terminated event stream is readable.
function writeSseError(res, message) {
  try {
    res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'upstream_error', message: String(message || 'upstream error') } })}\n\n`);
    res.end();
  } catch {
    try { res.destroy(); } catch { /* ignore */ }
  }
}
// Per-route failover state: count retryable failures; after `failures`
// consecutive failures the primary is bypassed for `cooldownMs`, then probed
// again (half-open). A single success resets the counter.
const circuitState = new Map();
function circuitFor(prefix) {
  let state = circuitState.get(prefix);
  if (!state) { state = { failures: 0, openUntil: 0 }; circuitState.set(prefix, state); }
  return state;
}

// ── Forward with retry (pre-first-byte only) ────────────────────────────────

/**
 * Retrying variant of server.mjs forward(). Contract identical: either the
 * client response head has been written (success — stream piping continues
 * via the returned handler), or a ShimError surfaced via onError.
 *
 * Retryable window: HTTP 429 / 502 / 503 / 504 received BEFORE the first
 * body byte is forwarded. Response headers with 200/4xx are passed through
 * untouched.
 */
export function forwardWithRetry(ctx) {
  const {
    req, res, route, body, changed, bearer, config, base, retry, onError, onMetrics,
    log,
  } = ctx;

  const budget = route?.budget || {};
  const maxAttempts = 1 + Math.max(0, budget.retries != null ? budget.retries : retry.retry429);
  const backoffBase = budget.backoffMs || retry.retryBackoffMs;
  const maxWait = budget.maxWaitMs || retry.retryMaxWaitMs;
  const attemptTimeoutMs = budget.timeoutMs || config.timeoutMs;
  const retryStatuses = new Set(retry.retryStatuses && retry.retryStatuses.length
    ? retry.retryStatuses : [429, 502, 503, 504]);
  const retryStream = Boolean(retry.retryStream);
  const streamHoldMs = Number.isFinite(retry.retryStreamHoldMs) ? retry.retryStreamHoldMs : 6000;
  const streamIdleMs = Number.isFinite(retry.streamIdleTimeoutMs) ? retry.streamIdleTimeoutMs : 600000;

  // Per-attempt target selection may swap to the fallback upstream.
  const globalProxy = retry.proxyUrl ? new URL(retry.proxyUrl) : null;
  const circuit = route ? circuitFor(route.prefix) : null;
  const failoverCfg = route?.failover || null;
  let lastFailoverChoice = null;
  let attemptUsesFallback = false;

  const noteFailure = (reason) => {
    if (!circuit || !failoverCfg) return;
    circuit.failures += 1;
    if (circuit.failures >= failoverCfg.failures && Date.now() >= circuit.openUntil) {
      circuit.openUntil = Date.now() + failoverCfg.cooldownMs;
      log({
        event: 'failover_open', reason, failures: circuit.failures,
        cooldown_ms: failoverCfg.cooldownMs, route: route.prefix,
        primary: route.base.href, fallback: route.fallback ? route.fallback.base.href : null,
      });
    }
  };
  const noteSuccess = () => {
    if (!circuit) return;
    // A success served by the fallback says nothing about the primary's health.
    if (attemptUsesFallback) return;
    if (circuit.failures > 0 || circuit.openUntil > 0) {
      circuit.failures = 0;
      circuit.openUntil = 0;
      log({ event: 'failover_reset', route: route.prefix });
    }
  };

  let attempt = 0;
  let gaveUp = false;

  const scheduleGiveUpCheck = () => {};

  const tryOnce = () => {
    attempt += 1;
    // Recompute target per attempt (route prefix may differ from fixed base).
    // While the circuit is open, requests bypass the primary and use the fallback.
    // Cooldown expired: probe the primary again (half-open) instead of
    // staying on the fallback forever.
    if (circuit && failoverCfg && circuit.openUntil > 0 && Date.now() >= circuit.openUntil) {
      circuit.openUntil = 0;
      circuit.failures = Math.max(0, failoverCfg.failures - 1);
      log({ event: 'failover_half_open', route: route.prefix, attempt });
    }
    const useFallback = Boolean(route?.fallback)
      && (Date.now() < circuit.openUntil || circuit.failures >= failoverCfg.failures);
    attemptUsesFallback = useFallback;
    if (route && lastFailoverChoice !== useFallback) {
      lastFailoverChoice = useFallback;
      log({
        event: useFallback ? 'failover_use_fallback' : 'failover_use_primary',
        route: route.prefix, attempt,
        target: (useFallback ? route.fallback.base.href : route.base.href),
        failures: circuit ? circuit.failures : 0,
      });
    }
    const targetBase = useFallback ? route.fallback.base : (route ? route.base : base);
    const proxy = useFallback ? (route.fallback.proxy || globalProxy) : (route?.proxy || globalProxy);
    const effectiveRoute = route ? { path: route.path, search: route.search } : ctx.routeFixed;

    const target = new URL(targetBase.href);
    target.pathname = `${targetBase.pathname.replace(/\/+$/, '')}${effectiveRoute.path}`;
    target.search = effectiveRoute.search || '';

    // Headers are cloned per attempt because node mutates nothing here, but
    // host/content-length depend on the (unchanged) body — identical across
    // attempts. Build once outside? Node requires fresh headers per request;
    // copyHeaders output is reused safely as a plain object.
    const headers = buildHeaders(req, body, changed, bearer, config, target);

    const cleanupFns = [];
    let settled = false;

    const fail = (error, code) => {
      if (settled) return;
      // Transport-level transient failures (DNS blips, socket resets, timeouts)
      // are retried the same way as retryable statuses while no client byte
      // has been written yet. A client-fingerprint rejection (401/403) never
      // reaches this branch with a retryable code and stays terminal.
      const msg = String(error?.message || '');
      const transportCode = error?.code
        || (msg.includes('upstream timeout') ? 'ETIMEDOUT' : undefined)
        || (/EPROTO|handshake/i.test(msg) ? 'EPROTO' : undefined);
      if (attempt < maxAttempts && RETRYABLE_TRANSPORT.has(transportCode) && !res.headersSent) {
        noteFailure('transport_' + (transportCode || 'unknown'));
        settled = true;
        cleanupFns.forEach((fn) => { try { fn(); } catch {} });
        log({
          event: 'retry_connect', code: error.code, attempt,
          max_attempts: maxAttempts, wait_ms: waitTime(attempt),
          error: String(error?.message || error),
        });
        setTimeout(tryOnce, waitTime(attempt));
        return;
      }
      settled = true;
      cleanupFns.forEach((fn) => { try { fn(); } catch {} });
      onError(code || 'upstream_connection_error');
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) {
        if (String(res.getHeader('content-type') || '').includes('text/event-stream')) {
          writeSseError(res, (error && error.message) || code || 'upstream error');
        } else res.destroy();
        return;
      }
      {
        const e = error instanceof Error ? error : new Error(String(error));
        e.status = e.status || 502;
        e.code = e.code || code || 'upstream_connection_error';
        ctx.sendError(res, e);
      }
    };

    createUpstreamRequest(target, { method: req.method, timeoutMs: attemptTimeoutMs, proxy }, headers,
      (setupError, outgoing, rawSocket) => {
        if (setupError) {
          // Proxy CONNECT failure counts as a retryable transport error.
          if (attempt < maxAttempts) {
            logRetry(setupError);
            setTimeout(tryOnce, waitTime(attempt));
            return;
          }
          fail(setupError, 'proxy_connect_failed');
          return;
        }
        if (rawSocket) cleanupFns.push(() => { try { rawSocket.destroy(); } catch {} });

        const timeout = () => { const e = new Error('upstream timeout'); e.code = 'ETIMEDOUT'; outgoing.destroy(e); };
        const headerTimer = setTimeout(timeout, attemptTimeoutMs);
        headerTimer.unref();
        outgoing.setTimeout(attemptTimeoutMs, timeout);
        cleanupFns.push(() => clearTimeout(headerTimer));

        let incoming = null;
        res.once('close', () => {
          clearTimeout(headerTimer);
          if (!res.writableFinished) { outgoing.destroy(); incoming?.destroy(); }
        });
        res.once('error', () => { outgoing.destroy(); incoming?.destroy(); });
        outgoing.once('error', (error) => fail(error, 'upstream_connection_error'));
        outgoing.once('close', () => clearTimeout(headerTimer));

        outgoing.once('response', (response) => {
          incoming = response;
          clearTimeout(headerTimer);
          // Headers arrived: idle gaps inside the stream use the long budget.
          outgoing.setTimeout(streamIdleMs, timeout);

          // Client already gone? Nothing to retry.
          if (res.destroyed) { response.destroy(); return; }

          const status = response.statusCode;

          // ── Retry decision: only BEFORE the first forwarded byte ──
          const retryableStatus = retryStatuses.has(status);
          if (retryableStatus && attempt < maxAttempts) {
            noteFailure('status_' + status);
            const waitMs = waitTimeFor(response, attempt);
            // Drain the (likely tiny) error body so the socket can be reused/destroyed cleanly.
            response.resume();
            log({
              event: 'retry_429', upstream_status: status, attempt,
              max_attempts: maxAttempts, wait_ms: waitMs,
              upstream: `${target.protocol}//${target.host}${target.pathname}`,
            });
            response.once('end', () => setTimeout(tryOnce, waitMs));
            return;
          }

          const isSSE = String(response.headers['content-type'] || '').includes('text/event-stream');

          // Auth-shaped statuses (401/403) are usually terminal, but pooled
          // relays flip them per request for the *same* key ("This account only
          // allows Codex official clients", "unauthorized client detected").
          // Sniff a small prefix and retry only when the body matches a
          // transient pattern; genuine auth failures pass through untouched.
          if ((status === 401 || status === 403) && attempt < maxAttempts) {
            const chunks = [];
            let size = 0;
            let decided = false;
            const finish = (retry) => {
              if (decided) return;
              decided = true;
              response.off('data', onData);
              const text = Buffer.concat(chunks).toString('utf8');
              if (retry && TRANSIENT_PATTERN.test(text)) {
                response.resume();
                const waitMs = waitTimeFor(response, attempt);
                log({
                  event: 'retry_auth', upstream_status: status, attempt,
                  max_attempts: maxAttempts, wait_ms: waitMs,
                  upstream: `${target.protocol}//${target.host}${target.pathname}`,
                });
                const schedule = () => setTimeout(tryOnce, waitMs);
                if (response.readableEnded) schedule();
                else response.once('end', schedule);
                return;
              }
              settled = true;
              cleanupFns.splice(0).forEach((fn) => { try { fn(); } catch {} });
              const responseHeaders = ctx.copyHeaders(response.headers);
              if (isSSE) responseHeaders['x-accel-buffering'] = 'no';
              res.writeHead(status, responseHeaders);
              res.flushHeaders();
              for (const chunk of chunks) res.write(chunk);
              chunks.length = 0;
              if (response.readableEnded) { res.end(); return; }
              response.pipe(res);
            };
            const onData = (chunk) => {
              if (decided) return;
              chunks.push(chunk);
              size += chunk.length;
              if (size >= 8192) finish(true);
            };
            response.on('data', onData);
            response.once('end', () => finish(true));
            const sniffTimer = setTimeout(() => finish(true), 1500);
            sniffTimer.unref();
            return;
          }

          // Stream-error retry: hold the head until the first *content* event.
          // An upstream may answer 200 and only then emit response.failed
          // (e.g. "Concurrency limit exceeded"); buffering costs no perceived
          // latency because the client renders nothing before the first delta.
          const canHoldHead = retryStream && isSSE && attempt < maxAttempts
            && status >= 200 && status < 300;

          const writeHead = () => {
            const responseHeaders = ctx.copyHeaders(response.headers);
            if (isSSE) responseHeaders['x-accel-buffering'] = 'no';
            res.writeHead(status, responseHeaders);
            res.flushHeaders();
          };

          const passThrough = () => {
            noteSuccess();
            settled = true;
            cleanupFns.splice(0).forEach((fn) => { try { fn(); } catch {} });
            writeHead();
            response.once('error', (error) => {
              onError('upstream_stream_error');
              // Terminate the client stream cleanly with an SSE error frame:
              // destroying res mid-chunk yields "error decoding response body"
              // in the client instead of a readable error event.
              if (!res.destroyed && !res.writableEnded) {
                if (isSSE && res.headersSent) writeSseError(res, String(error?.message || 'upstream stream error'));
                else res.destroy();
              }
            });
            if (config.logUsage) {
              const observer = ctx.createUsageObserver(response.headers);
              response.on('data', (chunk) => observer.push(chunk));
              response.once('end', () => onMetrics(observer.finish()));
            }
            response.pipe(res);
          };

          if (!canHoldHead) { passThrough(); return; }

          // Buffer until the first content-bearing event, the cap, or the hold budget.
          const MAX_HOLD = 64 * 1024;
          const held = [];
          let heldBytes = 0;
          let heldText = '';
          let decided = false;
          let holdTimer = null;

          const stopHold = () => {
            if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
          };

          const retryFromStream = (reason) => {
            noteFailure('stream_' + reason);
            decided = true;
            stopHold();
            cleanupFns.splice(0).forEach((fn) => { try { fn(); } catch {} });
            try { bodyStream.removeListener('data', onHeldData); bodyStream.on('error', () => {}); } catch {}
            response.destroy();
            const waitMs = waitTime(attempt);
            log({
              event: 'retry_stream', attempt, max_attempts: maxAttempts,
              wait_ms: waitMs, reason,
              upstream: `${target.protocol}//${target.host}${target.pathname}`,
            });
            setTimeout(tryOnce, waitMs);
          };

          const flushHeld = () => {
            noteSuccess();
            if (process.env.SHIM_DEBUG_HOLD === '1') process.stderr.write(`[hold] flush decided=${decided} bytes=${heldBytes}\n`);
            if (decided) return;
            decided = true;
            stopHold();
            settled = true;
            cleanupFns.splice(0).forEach((fn) => { try { fn(); } catch {} });
            bodyStream.removeListener('data', onHeldData);
            bodyStream.removeListener('end', onHeldEnd);
            bodyStream.removeListener('error', onHeldError);
            writeHead();
            for (const chunk of held) res.write(chunk);
            response.once('error', (error) => {
              onError('upstream_stream_error');
              if (!res.destroyed && !res.writableEnded) {
                if (isSSE && res.headersSent) writeSseError(res, String(error?.message || 'upstream stream error'));
                else res.destroy();
              }
            });
            if (config.logUsage) {
              const observer = ctx.createUsageObserver(response.headers);
              for (const chunk of held) observer.push(chunk);
              response.on('data', (chunk) => observer.push(chunk));
              response.once('end', () => onMetrics(observer.finish()));
            }
            response.pipe(res);
          };

          const onHeldData = (chunk) => {
            if (process.env.SHIM_DEBUG_HOLD === '1') process.stderr.write(`[hold] data ${chunk.length}B\n`);
            held.push(chunk);
            heldBytes += chunk.length;
            heldText += chunk.toString('utf8');
            if (heldText.length > MAX_HOLD * 2) heldText = heldText.slice(-MAX_HOLD * 2);
            const verdict = classifyStreamText(heldText);
            if (verdict === 'transient-error') {
              if (process.env.SHIM_DEBUG_HOLD === '1') process.stderr.write('[hold] matched transient, head=' + JSON.stringify(heldText.slice(0, 260)) + '\n');
              retryFromStream('transient_stream_error'); return;
            }
            if (verdict === 'content' || heldBytes >= MAX_HOLD) flushHeld();
          };

          const onHeldEnd = () => {
            if (decided) return;
            const verdict = classifyStreamText(heldText);
            if (verdict === 'transient-error') { retryFromStream('transient_stream_error'); return; }
            if (!heldBytes) { retryFromStream('empty_stream'); return; }
            flushHeld();
          };

          const onHeldError = () => {
            if (decided) return;
            retryFromStream('upstream_stream_error');
          };

          const bodyStream = response.body || response;
          bodyStream.on('data', onHeldData);
          bodyStream.once('end', onHeldEnd);
          bodyStream.on('error', onHeldError);
          // Never hold longer than the budget: a slow first token must not look
          // like a hung request to the client.
          if (process.env.SHIM_DEBUG_HOLD === '1') process.stderr.write(`[hold] timer ${streamHoldMs}ms\n`);
          holdTimer = setTimeout(() => { holdTimer = null; flushHeld(); }, streamHoldMs);
        });

        outgoing.end(body);
      });
  };

  const fastFailoverWait = (ms) => (route?.fallback && !attemptUsesFallback ? Math.min(2000, ms) : ms);
  const waitTime = (attemptNumber) => {
    if (attemptNumber <= 0) return fastFailoverWait(backoffBase);
    const exponential = backoffBase * (2 ** Math.min(attemptNumber - 1, 6));
    return fastFailoverWait(Math.min(exponential, maxWait));
  };

  const waitTimeFor = (response, attemptNumber) => {
    const retryAfter = String(response.headers['retry-after'] || '').trim();
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 3600) return fastFailoverWait(seconds * 1000);
      const date = Date.parse(retryAfter);
      if (!Number.isNaN(date)) {
        const delta = date - Date.now();
        if (delta > 0 && delta <= 3600000) return fastFailoverWait(delta);
      }
    }
    return waitTime(attemptNumber);
  };

  const logRetry = (error) => {
    log({
      event: 'retry_connect', attempt, max_attempts: maxAttempts,
      wait_ms: waitTime(attempt), error: String(error?.message || error),
    });
  };

  tryOnce();
  scheduleGiveUpCheck();
  void gaveUp;
}

// ── Stream classification (for pre-content retry) ───────────────────────────

// Anchored at an SSE line start so normal payload text (e.g. a user message
// containing the words "event: error") cannot be mistaken for a real event.
const CONTENT_PATTERN = /"type"\s*:\s*"response\.(?:output_text\.delta|output_item\.(?:added|done)|content_part\.added|function_call_arguments\.delta|reasoning_text\.delta|reasoning_summary_text\.delta|completed|incomplete)"/i;

const ERROR_PATTERNS = [
  /(?:^|\n)event:\s*error\b/i,
  /(?:^|\n)data:\s*\{[^\n]*"type"\s*:\s*"response\.failed"/i,
  /(?:^|\n)data:\s*\{[^\n]*"object"\s*:\s*"error"/i,
  /(?:^|\n)data:\s*\{[^\n]*"type"\s*:\s*"error"/i,
];

// Only transient upstream failures are worth another attempt; a permanent
// rejection (bad key, client not allowed, bad request) must reach the client.
const TRANSIENT_PATTERN = new RegExp([
  'concurrency limit', 'rate limit', 'rate_limit', 'too many requests',
  'overloaded', 'over capacity', 'capacity', 'temporarily unavailable',
  'try again later', 'retry later', 'please retry', 'server busy',
  // Gateway-side client heuristics that flip per request on the same key
  // (observed on pooled relays: 403 "official clients" interleaved with 429).
  'official clients', 'unauthorized client', 'client detected',
].join('|'), 'i');

function firstPatternIndex(text, patterns) {
  let best = -1;
  let hit = null;
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && (best === -1 || match.index < best)) { best = match.index; hit = pattern; }
  }
  return { index: best, pattern: hit };
}

/**
 * Look at the buffered prefix of an SSE stream and decide whether the shim
 * should keep waiting for content, give up and retry, or start forwarding.
 * @returns {'content'|'transient-error'|'error'|null}
 */
export function classifyStreamText(text) {
  if (!text) return null;
  const error = firstPatternIndex(text, ERROR_PATTERNS);
  const contentAt = text.search(CONTENT_PATTERN);
  if (process.env.SHIM_DEBUG_HOLD === '1' && error.index !== -1) {
    process.stderr.write('[hold] error_pattern=' + error.pattern + ' at ' + error.index
      + ' ctx=' + JSON.stringify(text.slice(Math.max(0, error.index - 60), error.index + 60)) + '\n');
  }
  if (error.index !== -1 && (contentAt === -1 || error.index < contentAt)) {
    return TRANSIENT_PATTERN.test(text) ? 'transient-error' : 'error';
  }
  if (contentAt !== -1) return 'content';
  return null;
}

function buildHeaders(req, body, changed, bearer, config, target) {
  // Replicates forward()'s header logic from server.mjs (kept in sync manually).
  const headers = { ...req.headers };
  // Drop hop-by-hop & connection-specific headers (same set as shim's HOP_HEADERS).
  const HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
  const excluded = new Set(HOP);
  for (const name of String(headers.connection || '').split(',')) {
    const trimmed = name.trim().toLowerCase();
    if (trimmed) excluded.add(trimmed);
  }
  for (const key of Object.keys(headers)) {
    if (excluded.has(key.toLowerCase())) delete headers[key];
  }
  for (const key of ['host', 'content-length', 'expect']) delete headers[key];
  if (changed) for (const key of ['content-encoding', 'content-md5', 'digest']) delete headers[key];
  headers.authorization = bearer;
  if (config.logUsage) headers['accept-encoding'] = 'identity';
  if (body !== undefined) {
    if (changed) headers['content-type'] = 'application/json';
    headers['content-length'] = String(body.length);
  }
  return headers;
}


