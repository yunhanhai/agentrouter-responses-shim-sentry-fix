import http from 'node:http';
import https from 'node:https';
import * as zlib from 'node:zlib';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { ShimError, sanitizeResponsesRequest } from './sanitize.mjs';
import { createUsageObserver } from './usage.mjs';

export const VERSION = '2.0.1';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const defaultLog = (event) => process.stderr.write(`${JSON.stringify(event)}\n`);

function integer(value, fallback, name, maximum = 2 ** 31 - 1) {
  const parsed = value == null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return parsed;
}

function upstreamURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('SHIM_UPSTREAM_BASE_URL must be an absolute URL.'); }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('SHIM_UPSTREAM_BASE_URL must not contain credentials, query parameters, or fragments.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new Error('Use HTTPS for the upstream, or HTTP to a loopback test server.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

function boolean(value, name) {
  if (value == null || value === '' || value === false || value === 'false' || value === '0') return false;
  if (value === true || value === 'true' || value === '1') return true;
  throw new Error(`${name} must be true or false.`);
}

export function configFromEnv(env = process.env, overrides = {}) {
  const config = {
    host: env.SHIM_HOST || '127.0.0.1',
    port: env.SHIM_PORT,
    upstreamBaseUrl: env.SHIM_UPSTREAM_BASE_URL || 'https://agentrouter.org/v1',
    maxBodyBytes: env.SHIM_MAX_BODY_BYTES,
    timeoutMs: env.SHIM_UPSTREAM_TIMEOUT_MS,
    upstreamApiKey: env.SHIM_UPSTREAM_API_KEY || '',
    localApiKey: env.SHIM_LOCAL_API_KEY || '',
    mode: env.SHIM_MODE || 'strip',
    strict: env.SHIM_STRICT,
    logUsage: env.SHIM_LOG_USAGE,
    ...overrides,
  };
  config.port = integer(config.port, 18080, 'SHIM_PORT', 65535);
  config.maxBodyBytes = integer(config.maxBodyBytes, 32 * 1024 * 1024, 'SHIM_MAX_BODY_BYTES', 128 * 1024 * 1024);
  config.timeoutMs = integer(config.timeoutMs, 300000, 'SHIM_UPSTREAM_TIMEOUT_MS');
  config.strict = boolean(config.strict, 'SHIM_STRICT');
  config.logUsage = boolean(config.logUsage, 'SHIM_LOG_USAGE');
  if (!['strip', 'passthrough'].includes(config.mode)) throw new Error('SHIM_MODE must be strip or passthrough.');
  upstreamURL(config.upstreamBaseUrl);
  if (!LOOPBACK.has(config.host) && !config.localApiKey) {
    throw new Error('Binding beyond loopback requires SHIM_LOCAL_API_KEY and SHIM_UPSTREAM_API_KEY.');
  }
  if (config.localApiKey && !config.upstreamApiKey) {
    throw new Error('SHIM_LOCAL_API_KEY requires SHIM_UPSTREAM_API_KEY; a local token must not be forwarded upstream.');
  }
  return config;
}

function sameSecret(actual, expected) {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorization(headers, config) {
  const value = headers.authorization || '';
  if (config.localApiKey && !sameSecret(value, `Bearer ${config.localApiKey}`)) {
    throw new ShimError(401, 'invalid_local_api_key', 'A valid local shim bearer token is required.');
  }
  if (config.upstreamApiKey) return `Bearer ${config.upstreamApiKey}`;
  if (!/^Bearer\s+\S+$/i.test(value)) {
    throw new ShimError(401, 'missing_api_key', 'Pass your AgentRouter API key in the Authorization: Bearer header.');
  }
  return value;
}

function copyHeaders(headers) {
  const excluded = new Set(HOP_HEADERS);
  for (const name of String(headers.connection || '').split(',')) excluded.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => value != null && !excluded.has(name.toLowerCase())));
}

function sendJSON(res, status, value, close = false) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  const bytes = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.length),
    'cache-control': 'no-store',
    ...(close ? { connection: 'close' } : {}),
  });
  res.end(bytes);
}

function sendError(res, error) {
  sendJSON(res, error.status || 502, { error: {
    message: error.message,
    type: error.status === 401 ? 'authentication_error' : error.status < 500 ? 'invalid_request_error' : 'api_error',
    code: error.code,
    param: error.param ?? null,
  } }, true);
}

function routeRequest(req, config) {
  if (!req.url?.startsWith('/') || req.url.startsWith('//')) {
    throw new ShimError(400, 'invalid_request_target', 'Use a relative API path on the local shim.');
  }
  const url = new URL(req.url, 'http://shim.invalid');
  if (url.pathname === '/healthz' && req.method === 'GET') return { health: true, path: '/healthz' };
  const path = url.pathname.replace(/^\/v1(?=\/)/, '').replace(/\/+$/, '');
  if (path === '/responses/compact' && req.method === 'POST' && config.mode === 'strip' && config.strict) {
    throw new ShimError(400, 'remote_compaction_unsupported',
      'Strict mode rejects remote compaction because encrypted compacted history is resource-bound. Replay explicit history or use resource-affine routing.');
  }
  if (req.method === 'GET' && path === '/responses') {
    throw new ShimError(426, 'websocket_unsupported', 'This proxy supports HTTP/SSE. Select that transport in your client.');
  }
  if (req.method === 'POST' && ['/responses', '/responses/input_tokens', '/responses/compact'].includes(path)) {
    return { path, search: url.search, operation: true };
  }
  // Non-Responses HTTP endpoints are transported without JSON rewriting.
  return { path: path || '/', search: url.search };
}

function readLimited(req, maximum) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted);
    };
    const error = (cause) => { cleanup(); reject(cause); };
    const aborted = () => error(new ShimError(400, 'request_aborted', 'The client disconnected during upload.'));
    const data = (chunk) => {
      size += chunk.length;
      if (size > maximum) {
        req.pause();
        error(new ShimError(413, 'request_too_large', 'The encoded request exceeds SHIM_MAX_BODY_BYTES.'));
      } else chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks, size)); };
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', aborted);
  });
}

async function readJSON(req, maximum) {
  const mediaType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/json' && !/^application\/[a-z0-9.+-]+\+json$/.test(mediaType)) {
    throw new ShimError(415, 'unsupported_media_type', 'Responses requests must use Content-Type: application/json.');
  }
  const encoding = String(req.headers['content-encoding'] || 'identity').trim().toLowerCase();
  const decompressors = { gzip: zlib.gunzip, deflate: zlib.inflate, br: zlib.brotliDecompress, zstd: zlib.zstdDecompress };
  if (encoding !== 'identity' && (!Object.hasOwn(decompressors, encoding) || !decompressors[encoding])) {
    throw new ShimError(415, 'unsupported_content_encoding',
      'Supported request encodings: identity, gzip, deflate, br, zstd. For zstd, use Node >=22.15 or send an uncompressed request.');
  }
  if (Number(req.headers['content-length']) > maximum) {
    throw new ShimError(413, 'request_too_large', 'The encoded request exceeds SHIM_MAX_BODY_BYTES.');
  }
  const raw = await readLimited(req, maximum);
  let bytes = raw;
  if (encoding !== 'identity') {
    try {
      bytes = await new Promise((resolve, reject) => {
        decompressors[encoding](bytes, { maxOutputLength: maximum }, (error, result) => error ? reject(error) : resolve(result));
      });
    } catch (error) {
      if (error.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new ShimError(413, 'request_too_large', 'The decoded request exceeds SHIM_MAX_BODY_BYTES.');
      }
      throw new ShimError(400, 'invalid_compressed_body', 'The compressed request body is invalid or incomplete.');
    }
  }
  try {
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), raw };
  } catch {
    throw new ShimError(400, 'invalid_json', 'The request must contain valid UTF-8 JSON.');
  }
}

function forward(req, res, route, body, changed, bearer, config, base, onError, onMetrics) {
  const target = new URL(base);
  target.pathname = `${base.pathname.replace(/\/+$/, '')}${route.path}`;
  target.search = route.search || '';
  const headers = copyHeaders(req.headers);
  for (const key of ['host', 'content-length', 'expect']) delete headers[key];
  if (changed) for (const key of ['content-encoding', 'content-md5', 'digest']) delete headers[key];
  headers.authorization = bearer;
  if (config.logUsage) headers['accept-encoding'] = 'identity';
  if (body !== undefined) {
    if (changed) headers['content-type'] = 'application/json';
    headers['content-length'] = String(body.length);
  }
  const transport = target.protocol === 'https:' ? https : http;
  const outgoing = transport.request(target, { method: req.method, headers });
  let incoming;
  const timeout = () => outgoing.destroy(new ShimError(504, 'upstream_timeout', 'The upstream request timed out.'));
  const headerTimer = setTimeout(timeout, config.timeoutMs);
  headerTimer.unref();
  outgoing.setTimeout(config.timeoutMs, timeout);
  const fail = (error) => {
    onError(error instanceof ShimError ? error.code : 'upstream_connection_error');
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) res.destroy();
    else sendError(res, error instanceof ShimError ? error : new ShimError(502, 'upstream_connection_error', 'The upstream connection failed.'));
  };
  res.once('close', () => {
    clearTimeout(headerTimer);
    if (!res.writableFinished) { outgoing.destroy(); incoming?.destroy(); }
  });
  res.once('error', () => { outgoing.destroy(); incoming?.destroy(); });
  outgoing.once('error', fail);
  outgoing.once('close', () => clearTimeout(headerTimer));
  outgoing.once('response', (response) => {
    incoming = response;
    clearTimeout(headerTimer);
    if (res.destroyed) { response.destroy(); return; }
    const responseHeaders = copyHeaders(response.headers);
    if (String(responseHeaders['content-type']).includes('text/event-stream')) responseHeaders['x-accel-buffering'] = 'no';
    res.writeHead(response.statusCode, responseHeaders);
    res.flushHeaders();
    response.once('error', fail);
    if (config.logUsage) {
      const observer = createUsageObserver(response.headers);
      response.on('data', (chunk) => observer.push(chunk));
      response.once('end', () => onMetrics(observer.finish()));
    }
    // Native HTTP preserves response bytes, Content-Encoding, and Content-Length.
    // pipe supplies backpressure. Optional usage observation never rewrites data.
    response.pipe(res);
  });
  outgoing.end(body);
}

export function createShimServer(options = {}) {
  const config = configFromEnv({}, options);
  const base = upstreamURL(config.upstreamBaseUrl);
  if (config.localApiKey && !config.upstreamApiKey) throw new Error('A local API key requires an upstream API key.');
  const log = config.logger ?? defaultLog;
  const server = http.createServer(async (req, res) => {
    const id = randomUUID();
    const started = Date.now();
    const event = { event: 'request', request_id: id, path: 'unsupported', method: req.method, mode: config.mode };
    res.setHeader('x-shim-request-id', id);
    req.on('error', () => {});
    res.once('close', () => log({ ...event, status: res.statusCode, completed: res.writableFinished, elapsed_ms: Date.now() - started }));
    try {
      const route = routeRequest(req, config);
      event.path = route.path;
      if (route.health) {
        sendJSON(res, 200, { status: 'ok', version: VERSION, mode: config.mode, strict: config.strict });
        return;
      }
      const bearer = authorization(req.headers, config);
      let bytes;
      let changed = false;
      if (route.operation && config.mode === 'strip') {
        const decoded = await readJSON(req, config.maxBodyBytes);
        const sanitized = sanitizeResponsesRequest(decoded.value, { strict: config.strict });
        event.sanitized = sanitized.stats;
        changed = sanitized.stats.reasoning_items_removed > 0 || sanitized.stats.item_ids_removed > 0
          || (sanitized.stats.nested_encrypted_blocks_removed || 0) > 0;
        bytes = changed ? Buffer.from(JSON.stringify(sanitized.body)) : decoded.raw;
        if (bytes.length > config.maxBodyBytes) {
          throw new ShimError(413, 'request_too_large', 'The sanitized request exceeds SHIM_MAX_BODY_BYTES.');
        }
      } else if (['POST', 'PUT', 'PATCH'].includes(req.method) || req.headers['content-length'] || req.headers['transfer-encoding']) {
        if (Number(req.headers['content-length']) > config.maxBodyBytes) throw new ShimError(413, 'request_too_large', 'The encoded request exceeds SHIM_MAX_BODY_BYTES.');
        bytes = await readLimited(req, config.maxBodyBytes);
      }
      forward(req, res, route, bytes, changed, bearer, config, base,
        (code) => { event.error_code = code; }, (metrics) => { Object.assign(event, metrics); });
    } catch (error) {
      const known = error instanceof ShimError ? error : new ShimError(502, 'shim_request_error', 'The shim could not process this request.');
      event.error_code = known.code;
      sendError(res, known);
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 60000;
  server.on('upgrade', (_req, socket) => {
    const body = JSON.stringify({ error: { code: 'websocket_unsupported', message: 'This proxy supports HTTP/SSE. Select that transport in your client.' } });
    socket.on('error', () => {});
    socket.end(`HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });
  return server;
}

