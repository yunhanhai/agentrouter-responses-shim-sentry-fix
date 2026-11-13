#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createShimServer, configFromEnv, VERSION } from '../src/server.mjs';
// cursor-retry extension (local patch): opt-in flags, no effect unless passed.
import { RETRY_OPTIONS, EXTRA_HELP, applyRetryOptions } from '../src/retry-cli.mjs';

const help = `agentrouter-shim ${VERSION}
Standalone HTTP/SSE reverse proxy. No client configuration or startup hooks.

Usage: agentrouter-shim [options]

  --upstream URL    Upstream API base (default https://agentrouter.org/v1)
  --host HOST       Listen address (default 127.0.0.1)
  --port PORT       Listen port (default 18080)
  --mode MODE       strip (default), or passthrough for manual comparison
  --strict          Reject resource references and encrypted compaction
  --log-usage       Log returned token/cache counters without response text
  --max-body BYTES  Encoded/decoded request limit (default 33554432)
  --timeout MS      Upstream headers/idle timeout (default 300000)
${EXTRA_HELP}
  --help, -h        Show help
  --version, -v     Show version

Environment: SHIM_UPSTREAM_BASE_URL, SHIM_HOST, SHIM_PORT, SHIM_MODE,
SHIM_STRICT, SHIM_LOG_USAGE, SHIM_MAX_BODY_BYTES, SHIM_UPSTREAM_TIMEOUT_MS.
By default the client's Bearer key is forwarded. Optional server credentials:
SHIM_UPSTREAM_API_KEY and SHIM_LOCAL_API_KEY. Keys are never CLI arguments.

Example: agentrouter-shim --port 18080 --log-usage
Client API base: http://127.0.0.1:18080/v1
`;
const log = (event) => process.stderr.write(`${JSON.stringify(event)}\n`);
try {
  const { values } = parseArgs({ options: {
    upstream: { type: 'string' }, host: { type: 'string' }, port: { type: 'string' },
    mode: { type: 'string' }, strict: { type: 'boolean' }, 'log-usage': { type: 'boolean' },
    'max-body': { type: 'string' }, timeout: { type: 'string' },
    ...RETRY_OPTIONS,
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  }, strict: true, allowPositionals: false });
  if (values.help) process.stdout.write(help);
  else if (values.version) process.stdout.write(`${VERSION}\n`);
  else {
    const names = { upstream: 'upstreamBaseUrl', host: 'host', port: 'port', mode: 'mode', strict: 'strict',
      'log-usage': 'logUsage', 'max-body': 'maxBodyBytes', timeout: 'timeoutMs' };
    const overrides = Object.fromEntries(Object.entries(values).filter(([name]) => names[name]).map(([name, value]) => [names[name], value]));
    const config = configFromEnv(process.env, overrides);
    // cursor-retry extension: merge opt-in retry/routing/proxy into the config.
    const { retry, routes } = applyRetryOptions(process.env, values, config);
    if (retry) {
      config.retry = retry;
      config.routes = routes;
      config.maxImages = retry.maxImages;
    }
    const server = createShimServer(config);
    server.once('error', (error) => { log({ event: 'startup_error', code: error.code || 'listen_failed' }); process.exitCode = 1; });
    server.listen(config.port, config.host, () => log({ event: 'listening', host: config.host, port: config.port,
      upstream: config.upstreamBaseUrl, mode: config.mode, strict: config.strict, log_usage: config.logUsage, version: VERSION,
      ...(retry ? { retry429: retry.retry429, max_images: retry.maxImages, routes: routes ? routes.size : 0, proxy: retry.proxyUrl || null } : {}) }));
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      server.close();
      setTimeout(() => server.closeAllConnections(), 5000).unref();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }
} catch (error) {
  log({ event: 'configuration_error', message: error.message });
  process.exitCode = 1;
}
