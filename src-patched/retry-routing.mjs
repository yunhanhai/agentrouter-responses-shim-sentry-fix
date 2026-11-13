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
  'max-images': { type: 'string' },
  routes: { type: 'string' },
  proxy: { type: 'string' },
};

export const RETRY_ENV = {
  retry429: { env: 'SHIM_RETRY_429', fallback: 0 },
  retryBackoffMs: { env: 'SHIM_RETRY_BACKOFF_MS', fallback: 30000 },
  retryMaxWaitMs: { env: 'SHIM_RETRY_MAX_WAIT_MS', fallback: 180000 },
  maxImages: { env: 'SHIM_MAX_IMAGES', fallback: 0 },
  routesFile: { env: 'SHIM_ROUTES_FILE', fallback: '' },
  proxyUrl: { env: 'SHIM_PROXY', fallback: '' },
};

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
  // image-limit extension: keep only the newest N images in replayed history.
  // Gateways commonly cap images per request (e.g. 50); 0 disables the trim.
  const maxImages = integer2(pick('max-images', RETRY_ENV.maxImages), 0, 'max-images', 1000);
  const routesFile = String(pick('routes', RETRY_ENV.routesFile) || '');
  const proxyUrl = String(pick('proxy', RETRY_ENV.proxyUrl) || '');
  const routes = routesFile ? loadRoutes(routesFile) : null;
  if (proxyUrl) proxyURL(proxyUrl); // validate early
  return { retry429, retryBackoffMs, retryMaxWaitMs, maxImages, routes, routesFile, proxyUrl };
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
    routes.set(`/${prefix}`, {
      prefix: `/${prefix}`,
      base: upstream, // URL, pathname already as given (trailing slash stripped below)
      proxy,
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

  const maxAttempts = 1 + Math.max(0, retry.retry429);
  const backoffBase = retry.retryBackoffMs;
  const maxWait = retry.retryMaxWaitMs;

  // Merge per-route proxy over global proxy.
  const proxyUrl = route?.proxy?.href || retry.proxyUrl || '';
  const proxy = proxyUrl ? new URL(proxyUrl) : null;

  let attempt = 0;
  let gaveUp = false;

  const scheduleGiveUpCheck = () => {};

  const tryOnce = () => {
    attempt += 1;
    // Recompute target per attempt (route prefix may differ from fixed base)
    const targetBase = route ? route.base : base;
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
      settled = true;
      cleanupFns.forEach((fn) => { try { fn(); } catch {} });
      onError(code || 'upstream_connection_error');
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) res.destroy();
      else {
        const e = error instanceof Error ? error : new Error(String(error));
        e.status = e.status || 502;
        e.code = e.code || code || 'upstream_connection_error';
        ctx.sendError(res, e);
      }
    };

    createUpstreamRequest(target, { method: req.method, timeoutMs: config.timeoutMs, proxy }, headers,
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

        const timeout = () => outgoing.destroy(new Error('upstream timeout'));
        const headerTimer = setTimeout(timeout, config.timeoutMs);
        headerTimer.unref();
        outgoing.setTimeout(config.timeoutMs, timeout);
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

          // Client already gone? Nothing to retry.
          if (res.destroyed) { response.destroy(); return; }

          const status = response.statusCode;

          // ── Retry decision: only BEFORE the first forwarded byte ──
          const retryableStatus = status === 429 || status === 502 || status === 503 || status === 504;
          if (retryableStatus && attempt < maxAttempts) {
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

          // ── Success or non-retryable: forward verbatim (original behavior) ──
          settled = true;
          cleanupFns.splice(0).forEach((fn) => { try { fn(); } catch {} });
          // Re-register the original close/error handlers for stream lifetime.
          const responseHeaders = ctx.copyHeaders(response.headers);
          if (String(responseHeaders['content-type']).includes('text/event-stream')) responseHeaders['x-accel-buffering'] = 'no';
          res.writeHead(status, responseHeaders);
          res.flushHeaders();
          response.once('error', (error) => {
            onError('upstream_stream_error');
            if (!res.destroyed && !res.writableEnded) res.destroy();
            else if (res.destroyed) { /* client gone */ }
          });
          if (config.logUsage) {
            const observer = ctx.createUsageObserver(response.headers);
            response.on('data', (chunk) => observer.push(chunk));
            response.once('end', () => onMetrics(observer.finish()));
          }
          response.pipe(res);
        });

        outgoing.end(body);
      });
  };

  const waitTime = (attemptNumber) => {
    if (attemptNumber <= 0) return backoffBase;
    const exponential = backoffBase * (2 ** Math.min(attemptNumber - 1, 6));
    return Math.min(exponential, maxWait);
  };

  const waitTimeFor = (response, attemptNumber) => {
    const retryAfter = String(response.headers['retry-after'] || '').trim();
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 3600) return seconds * 1000;
      const date = Date.parse(retryAfter);
      if (!Number.isNaN(date)) {
        const delta = date - Date.now();
        if (delta > 0 && delta <= 3600000) return delta;
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
