// Tests for the server management REST API behind the dashboard: /api/servers, the single
// server routes, the bulk start-all / stop-all routes and the enabled / autoStart switches.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, '..', 'fixtures', 'fake-mcp.js');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-servers-api-'));
const configPath = path.join(workDir, 'servers.json');

const entry = (id, extra = {}) => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  command: process.execPath,
  args: [fixture],
  cwd: workDir,
  env: {},
  transport: 'stdio',
  ...extra
});

fs.writeFileSync(configPath, JSON.stringify([
  entry('alpha'),
  entry('beta', { autoStart: false }),
  entry('gamma', { enabled: false })
], null, 2));

process.env.MCP_HUB_CONFIG = configPath;
process.env.MCP_HUB_PORT = '0';
process.env.MCP_HUB_HOST = '127.0.0.1';
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
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const post = (route) => request(route, { method: 'POST' });

async function servers() {
  const { status, body } = await request('/api/servers');
  assert.equal(status, 200);
  return body.servers;
}

const byId = (list, id) => list.find((entry) => entry.id === id);
const summary = (results) => results.map(({ id, started, stopped, skipped, error }) => ({ id, started, stopped, skipped, error }));

test('boot starts only the servers that are enabled and set to autostart', async () => {
  const list = await servers();
  assert.deepEqual(list.map((entry) => entry.id), ['alpha', 'beta', 'gamma']);
  assert.equal(byId(list, 'alpha').status, 'running');
  assert.equal(byId(list, 'beta').status, 'stopped', 'autoStart: false must stay down');
  assert.equal(byId(list, 'gamma').status, 'disabled');
  assert.equal(byId(list, 'gamma').pid, null);
  assert.equal(byId(list, 'gamma').autoStart, true, 'absent switches default to on');
});

test('start-all starts the manual servers and skips the disabled one', async () => {
  const { status, body } = await post('/api/servers/start-all');
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(summary(body.results), [
    { id: 'alpha', started: false, stopped: undefined, skipped: undefined, error: undefined },
    { id: 'beta', started: true, stopped: undefined, skipped: undefined, error: undefined },
    { id: 'gamma', started: undefined, stopped: undefined, skipped: 'disabled', error: undefined }
  ]);

  const list = await servers();
  assert.equal(byId(list, 'beta').status, 'running');
  assert.equal(byId(list, 'gamma').status, 'disabled');
});

test('a disabled server refuses to be started', async () => {
  const { status, body } = await post('/api/servers/gamma/start');
  assert.equal(status, 409);
  assert.match(body.error, /disabled/);
  assert.equal(byId(await servers(), 'gamma').status, 'disabled');
});

test('stop-all stops the running servers and skips the disabled one', async () => {
  const { body } = await post('/api/servers/stop-all');
  assert.deepEqual(summary(body.results), [
    { id: 'alpha', started: undefined, stopped: true, skipped: undefined, error: undefined },
    { id: 'beta', started: undefined, stopped: true, skipped: undefined, error: undefined },
    { id: 'gamma', started: undefined, stopped: undefined, skipped: 'disabled', error: undefined }
  ]);

  const list = await servers();
  assert.equal(byId(list, 'alpha').status, 'stopped');
  assert.equal(byId(list, 'beta').status, 'stopped');
  assert.equal(byId(list, 'alpha').pid, null);
});

test('PUT updates a server and keeps a switch that was not sent', async () => {
  const { status, body } = await request('/api/servers/gamma', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Gamma renamed', command: process.execPath, args: [fixture], cwd: workDir })
  });
  assert.equal(status, 200);
  assert.equal(body.server.name, 'Gamma renamed');
  assert.equal(body.server.enabled, false, 'enabled was not sent, so it must stay off');

  const gamma = byId(await servers(), 'gamma');
  assert.equal(gamma.name, 'Gamma renamed');
  assert.equal(gamma.status, 'disabled');
});

test('PUT validates the payload and unknown servers', async () => {
  const bad = await request('/api/servers/alpha', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Alpha' })
  });
  assert.equal(bad.status, 400);

  const missing = await request('/api/servers/nope', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Nope', command: process.execPath })
  });
  assert.equal(missing.status, 404);
});

test('enabling a server through PUT makes it startable again', async () => {
  const { status } = await request('/api/servers/gamma', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Gamma', command: process.execPath, args: [fixture], cwd: workDir, enabled: true })
  });
  assert.equal(status, 200);
  assert.equal(byId(await servers(), 'gamma').status, 'stopped', 'enabling does not start it by itself');

  assert.equal((await post('/api/servers/gamma/start')).status, 200);
  assert.equal(byId(await servers(), 'gamma').status, 'running');
});

test('disabling a running server stops it', async () => {
  const { status } = await request('/api/servers/alpha', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Alpha', command: process.execPath, args: [fixture], cwd: workDir, enabled: false })
  });
  assert.equal(status, 200);

  const alpha = byId(await servers(), 'alpha');
  assert.equal(alpha.status, 'disabled');
  assert.equal(alpha.pid, null);
});

test('a server added through the API starts out enabled and self starting', async () => {
  const created = await request('/api/servers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'delta', name: 'Delta', command: process.execPath, args: [fixture], cwd: workDir })
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.server.enabled, true);
  assert.equal(created.body.server.autoStart, true);

  assert.equal((await post('/api/servers/delta/start')).status, 200);
  assert.equal(byId(await servers(), 'delta').status, 'running');
  assert.equal((await request('/api/servers/delta', { method: 'DELETE' })).status, 200);
  assert.equal(byId(await servers(), 'delta'), undefined);
});

test('the single server routes still start and stop one server', async () => {
  assert.equal((await post('/api/servers/beta/stop')).status, 200);
  assert.equal(byId(await servers(), 'beta').status, 'stopped');
  assert.equal(byId(await servers(), 'gamma').status, 'running');

  assert.equal((await post('/api/servers/beta/start')).status, 200);
  assert.equal(byId(await servers(), 'beta').status, 'running');
});
