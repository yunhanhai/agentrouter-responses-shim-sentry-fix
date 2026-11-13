import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { appendFileSync } from 'node:fs';

const SHIM_BIN = 'C:\\Users\\zhenmao\\AppData\\Roaming\\npm\\node_modules\\agentrouter-responses-shim\\bin\\agentrouter-shim.mjs';
const LOG = 'C:\\Users\\zhenmao\\.agentrouter-shim\\shim.log';
const PORT = 18080;
const ARGS = [
  '--routes', 'C:\\Users\\zhenmao\\.agentrouter-shim\\routes.json',
  '--retry-429', '4',
  '--retry-backoff-ms', '8000',
  '--retry-max-wait-ms', '30000',
  '--max-images', '45',
  '--port', String(PORT),
  '--log-usage',
];

const log = (event) => {
  try { appendFileSync(LOG, JSON.stringify({ ...event, supervisor: true, at: new Date().toISOString() }) + '\n'); } catch { /* ignore */ }
};

const portBusy = () => new Promise((resolve) => {
  const socket = createConnection({ host: '127.0.0.1', port: PORT });
  socket.setTimeout(1000);
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
  socket.once('timeout', () => { socket.destroy(); resolve(false); });
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (await portBusy()) {
    log({ event: 'supervisor_exit', reason: 'port_already_in_use' });
    return;
  }
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopping) {
    const child = spawn(process.execPath, [SHIM_BIN, ...ARGS], { stdio: ['ignore', 'pipe', 'pipe'] });
    const relay = (chunk) => { try { appendFileSync(LOG, chunk); } catch { /* ignore */ } };
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);
    log({ event: 'supervisor_spawn', pid: child.pid });

    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    const { code, signal } = await exited;
    if (stopping) break;
    log({ event: 'supervisor_restart', code, signal, wait_ms: 3000 });
    await wait(3000);
  }
  log({ event: 'supervisor_stopped' });
}

main();
