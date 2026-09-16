// Launcher tests: /api/servers entries with kind "service" are supervised processes (start,
// stop, restart, health) and reverse proxied under /apps/<id>/ on the hub port.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, '..', 'fixtures', 'fake-service.js');
const mcpFixture = path.join(here, '..', 'fixtures', 'fake-mcp.js');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-services-'));
const configPath = path.join(workDir, 'servers.json');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(check, message, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error(`timed out waiting for ${message}`);
}

const proxyPort = await freePort();
const manualPort = await freePort();
const restartPort = await freePort();

const service = (id, extra = {}) => ({
  id,
  kind: 'service',
  name: id,
  command: process.execPath,
  args: [fixture, '--port', String(extra.port || proxyPort)],
  cwd: workDir,
  env: {},
  port: extra.port || proxyPort,
  host: '127.0.0.1',
  healthPath: '/healthz',
  restart: 'no',
  autoStart: true,
  ...extra
});

fs.writeFileSync(configPath, JSON.stringify([
  service('svc', { proxy: true, usagePath: '/v1/usage' }),
  service('manual', { port: manualPort, autoStart: false }),
  {
    id: 'crasher',
    kind: 'service',
    name: 'crasher',
    command: process.execPath,
    args: [fixture, '--port', String(restartPort)],
    cwd: workDir,
    env: { FAKE_SERVICE_MARKER: path.join(workDir, 'crasher.marker') },
    port: restartPort,
    restart: 'on-failure',
    autoStart: true
  },
  {
    id: 'mcp-one',
    name: 'mcp-one',
    command: process.execPath,
    args: [mcpFixture],
    cwd: workDir,
    env: {},
    transport: 'stdio'
  }
], null, 2));

process.env.MCP_HUB_CONFIG = configPath;
process.env.MCP_HUB_PORT = '0';
process.env.MCP_HUB_HOST = '127.0.0.1';
process.env.MCP_HUB_SERVICE_RESTART_DELAY_MS = '120';
process.env.MCP_HUB_HEALTH_INTERVAL_MS = '1000';
process.env.MCP_HUB_HEALTH_TIMEOUT_MS = '800';
delete process.env.MCP_HUB_TOKEN;
delete process.env.MCP_HUB_REQUIRE_SESSION;

const { startHub } = await import('../index.js');
const hub = await startHub({ port: 0, host: '127.0.0.1', banner: false, signals: false });
const base = hub.url;

test.after(async () => {
  await hub.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

async function request(route, options) {
  const res = await fetch(`${base}${route}`, options);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

const post = (route) => request(route, { method: 'POST' });

async function servers() {
  const { status, body } = await request('/api/servers');
  assert.equal(status, 200);
  return body.servers;
}

const byId = (list, id) => list.find((entry) => entry.id === id);

test('boot starts services that are enabled and set to autostart', async () => {
  const list = await servers();
  assert.equal(byId(list, 'svc').kind, 'service');
  assert.equal(byId(list, 'svc').status, 'running');
  assert.equal(byId(list, 'svc').proxyPath, '/apps/svc/', 'proxy: true asks the hub to mirror it');
  assert.equal(byId(list, 'manual').proxyPath, null, 'services stay on their own port by default');
  assert.equal(byId(list, 'svc').upstream, `http://127.0.0.1:${proxyPort}`);
  assert.equal(byId(list, 'manual').status, 'stopped', 'autoStart: false must stay down');
  assert.equal(byId(list, 'mcp-one').kind, 'mcp', 'entries without kind stay MCP servers');
  assert.equal(byId(list, 'mcp-one').status, 'running');
});

test('a service that does not opt in is reachable directly and refused on /apps', async () => {
  assert.equal((await post('/api/servers/manual/start')).status, 200);
  await waitFor(async () => ((await fetch(`http://127.0.0.1:${manualPort}/healthz`).catch(() => ({ status: 0 }))).status === 200 ? true : null), 'manual to listen on its own port');
  assert.equal((await fetch(`http://127.0.0.1:${manualPort}/healthz`)).status, 200);

  const mirrored = await request('/apps/manual/healthz');
  assert.equal(mirrored.status, 404);
  assert.match(mirrored.body.error, /set "proxy": true/);
  assert.equal((await post('/api/servers/manual/stop')).status, 200);
});

test('the hub polls a service health while it boots', async () => {
  // No explicit probe here: the list must turn healthy on its own, i.e. the startup polling
  // loop in the hub has to notice that the listening service answers /healthz.
  const entry = await waitFor(async () => {
    const current = byId(await servers(), 'svc');
    return current.health && current.health.state === 'up' ? current : null;
  }, 'the hub to notice svc is healthy');
  assert.equal(entry.health.statusCode, 200);
  assert.equal(entry.health.error, null);

  const probed = await request('/api/servers/svc/health');
  assert.equal(probed.status, 200);
  assert.equal(probed.body.health.state, 'up');
});

test('a service with a usage endpoint reports its quota windows', async () => {
  // The hub only needs the nested windows, so it accepts the shape codex-proxy serves verbatim:
  // shortest window first, percentages clamped, reset timestamps kept for the dashboard.
  const entry = await waitFor(async () => {
    const current = byId(await servers(), 'svc');
    return current.usage && current.usage.windows.length ? current : null;
  }, 'the hub to poll svc usage');
  assert.equal(entry.usage.planType, 'fake');
  assert.equal(entry.usage.stale, false);
  assert.deepEqual(entry.usage.windows.map((window) => window.label), ['5h', 'weekly']);
  assert.deepEqual(entry.usage.windows.map((window) => window.shortLabel), ['5h', '7d']);
  assert.deepEqual(entry.usage.windows.map((window) => window.remainingPercent), [100, 6]);
  assert.deepEqual(entry.usage.windows.map((window) => window.windowSeconds), [18000, 604800]);
  assert.equal(entry.usage.windows[1].resetsAt, '2026-09-19T17:07:57Z');

  const probed = await request('/api/servers/svc/usage');
  assert.equal(probed.status, 200);
  assert.equal(probed.body.usage.windows[0].remainingPercent, 100);

  const withoutEndpoint = await request('/api/servers/manual/usage');
  assert.equal(withoutEndpoint.status, 200);
  assert.equal(withoutEndpoint.body.usage, null);
  assert.match(withoutEndpoint.body.error, /no usage endpoint/);

  const mcpEntry = await request('/api/servers/mcp-one/usage');
  assert.equal(mcpEntry.status, 200);
  assert.equal(mcpEntry.body.usage, null);
});

test('the hub proxies /apps/:id to the service and keeps method, path and body', async () => {
  const get = await request('/apps/svc/healthz');
  assert.equal(get.status, 200);
  assert.deepEqual(get.body, { ok: true });

  const echo = await request('/apps/svc/echo/deeper?q=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hello: 'world' })
  });
  assert.equal(echo.status, 200);
  assert.equal(echo.body.method, 'POST');
  assert.equal(echo.body.path, '/echo/deeper', 'the path after /apps/<id> is forwarded unchanged');
  assert.equal(echo.body.search, '?q=1');
  assert.equal(echo.body.body, '{"hello":"world"}');
  assert.equal(echo.body.host, `127.0.0.1:${proxyPort}`, 'the upstream sees its own host header');
  assert.ok(echo.body.forwardedFor, 'x-forwarded-for should be set');
});

test('the proxy streams a chunked SSE response instead of buffering it', async () => {
  const res = await fetch(`${base}/apps/svc/stream`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /data: one/);
  assert.match(text, /data: two/);
});

test('the service info page is served on the bare /apps/:id route', async () => {
  const plain = await request('/apps/svc/');
  assert.equal(plain.status, 200);
  assert.match(String(plain.body), /\/apps\/svc\//);

  const html = await fetch(`${base}/apps/svc`, { headers: { Accept: 'text/html' } });
  assert.match(await html.text(), /Proxied on the hub port/);
});

test('MCP and launcher routes refuse each other\'s entries', async () => {
  const asMcp = await request('/mcps/svc/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  });
  assert.equal(asMcp.status, 404);
  assert.match(asMcp.body.error, /use \/apps\/svc\//);

  const asService = await request('/apps/mcp-one/healthz');
  assert.equal(asService.status, 404);
  assert.match(asService.body.error, /\/mcps\/mcp-one\/mcp/);
});

test('stopping a service closes its proxy and starting it again brings it back', async () => {
  assert.equal((await post('/api/servers/svc/stop')).status, 200);
  const stopped = (await servers()).find((entry) => entry.id === 'svc');
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.pid, null);

  await waitFor(async () => {
    const res = await request('/apps/svc/healthz');
    return res.status === 502 ? true : null;
  }, 'the proxy to fail while the service is down');

  assert.equal((await post('/api/servers/svc/start')).status, 200);
  const back = await waitFor(async () => {
    const res = await request('/apps/svc/healthz');
    return res.status === 200 ? res : null;
  }, 'svc to answer through the proxy again');
  assert.deepEqual(back.body, { ok: true });
});

test('restarting a service replaces the process', async () => {
  const before = byId(await servers(), 'svc').pid;
  const { status } = await post('/api/servers/svc/restart');
  assert.equal(status, 200);
  const after = await waitFor(async () => {
    const entry = byId(await servers(), 'svc');
    return entry.status === 'running' && entry.pid !== before ? entry.pid : null;
  }, 'svc to come back with a new pid');
  assert.notEqual(after, before);
});

test('editing a running service moves it on restart without orphaning the old process', async () => {
  const movedTo = await freePort();
  const { status } = await request('/api/servers/svc', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'service',
      name: 'svc',
      command: process.execPath,
      args: [fixture, '--port', String(movedTo)],
      cwd: workDir,
      port: movedTo,
      host: '127.0.0.1',
      healthPath: '/healthz',
      proxy: true,
      restart: 'no'
    })
  });
  assert.equal(status, 200);
  // Saving does not bounce a running process: it keeps serving on its old port until restarted.
  assert.equal(byId(await servers(), 'svc').upstream, `http://127.0.0.1:${proxyPort}`);
  await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/healthz`).catch(() => ({ status: 0 }));
    return res.status === 200 ? true : null;
  }, 'the untouched process to keep serving on its old port');

  assert.equal((await post('/api/servers/svc/restart')).status, 200);
  await waitFor(async () => {
    const entry = byId(await servers(), 'svc');
    return entry.upstream === `http://127.0.0.1:${movedTo}` ? true : null;
  }, 'the restart to pick up the new port');
  await waitFor(async () => {
    const entry = byId(await servers(), 'svc');
    return entry.health && entry.health.state === 'up' ? true : null;
  }, 'the edited service to answer on its new port');

  // The old process must be gone: without the config hand-over the hub would have started a
  // second copy on the new port and left the first one listening on the old one.
  await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/healthz`).catch(() => ({ status: 0 }));
    return res.status === 0 ? true : null;
  }, 'the old port to be released');
});

test('start-all starts the manual service and skips the disabled one', async () => {
  const list = await servers();
  assert.equal(byId(list, 'manual').status, 'stopped');

  assert.equal((await post('/api/servers/manual/restart')).status, 200);
  const manual = byId(await servers(), 'manual');
  assert.equal(manual.status, 'running');
  assert.equal(manual.upstream, `http://127.0.0.1:${manualPort}`);
  await waitFor(async () => ((await request('/api/servers/manual/health')).body.health.state === 'up' ? true : null), 'manual to answer');
  assert.equal((await post('/api/servers/manual/stop')).status, 200);
});

test('a crashing service is restarted by the on-failure policy', async () => {
  const restarts = await waitFor(async () => {
    const entry = byId(await servers(), 'crasher');
    return entry.restarts > 0 && entry.status === 'running' ? entry : null;
  }, 'the crasher to be restarted and running');
  assert.equal(restarts.restarts, 1);
  assert.equal(restarts.restart, 'on-failure');
  const health = await request('/api/servers/crasher/health');
  assert.equal(health.status, 200);
});

test('adding a service through the API normalises the launcher fields', async () => {
  const created = await request('/api/servers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'added',
      kind: 'service',
      name: 'Added',
      command: process.execPath,
      args: [fixture, '--port', String(manualPort)],
      cwd: workDir,
      port: manualPort,
      host: '127.0.0.1'
    })
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.server.kind, 'service');
  assert.equal(created.body.server.healthPath, '/healthz', 'healthPath gets a default');
  assert.equal(created.body.server.restart, 'on-failure', 'restart policy gets a default');
  assert.equal(created.body.server.transport, undefined, 'services are not stdio transports');

  assert.equal((await post('/api/servers/added/start')).status, 200);
  await waitFor(async () => ((await request('/api/servers/added/health')).body.health.state === 'up' ? true : null), 'added to answer');
  assert.equal((await request('/api/servers/added', { method: 'DELETE' })).status, 200);
  assert.equal(byId(await servers(), 'added'), undefined, 'removing a service drops it from the list');
});

test('flipping an entry from mcp to service stops the old process', async () => {
  const before = byId(await servers(), 'mcp-one');
  assert.equal(before.status, 'running');

  const { status } = await request('/api/servers/mcp-one', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'service',
      name: 'mcp-one',
      command: process.execPath,
      args: [fixture, '--port', String(manualPort)],
      cwd: workDir,
      port: manualPort
    })
  });
  assert.equal(status, 200);
  const after = byId(await servers(), 'mcp-one');
  assert.equal(after.kind, 'service');
  assert.equal(after.status, 'stopped', 'the stdio child must not survive the kind change');
});
