// Runs in its own process so the import time environment can differ from streamable.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, '..', 'fixtures', 'fake-mcp.js');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-auth-'));
const configPath = path.join(workDir, 'servers.json');

fs.writeFileSync(configPath, JSON.stringify([{
  id: 'fake',
  name: 'Fake MCP',
  command: process.execPath,
  args: [fixture],
  cwd: here,
  env: {},
  transport: 'stdio',
  enabled: true
}], null, 2));

process.env.MCP_HUB_CONFIG = configPath;
process.env.MCP_HUB_PORT = '0';
process.env.MCP_HUB_HOST = '127.0.0.1';
process.env.MCP_HUB_TOKEN = 'test-token';
process.env.MCP_HUB_REQUIRE_SESSION = '1';
process.env.MCP_HUB_ALLOWED_ORIGINS = 'https://allowed.example';

const { startHub } = await import('../index.js');
const hub = await startHub({ port: 0, host: '127.0.0.1', banner: false, signals: false });
const endpoint = `${hub.url}/mcps/fake/mcp`;
const auth = { Authorization: 'Bearer test-token' };

test.after(async () => {
  await hub.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

test('optional bearer token protects every /mcps/* endpoint', async () => {
  const post = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  });
  assert.equal(post.status, 401);
  assert.equal(post.headers.get('www-authenticate'), 'Bearer');

  assert.equal((await fetch(`${hub.url}/mcps/fake/sse`)).status, 401);
  assert.equal((await fetch(`${hub.url}/mcps/fake/health`)).status, 401);

  // The dashboard API stays open so the local UI keeps working.
  assert.equal((await fetch(`${hub.url}/api/servers`)).status, 200);
});

test('MCP_HUB_REQUIRE_SESSION rejects requests without a session id', async () => {
  const rejected = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...auth },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error.message, /Mcp-Session-Id/);

  const init = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...auth },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'auth-test', version: '1.0.0' } } })
  });
  assert.equal(init.status, 200);
  const session = init.headers.get('Mcp-Session-Id');
  assert.ok(session);

  const withSession = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Mcp-Session-Id': session, ...auth },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' })
  });
  assert.equal(withSession.status, 200);
  assert.equal((await withSession.json()).result.tools.length, 2);

  await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': session, ...auth } });
});

test('Origin validation allows configured origins and blocks the rest', async () => {
  const allowed = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: 'https://allowed.example', ...auth },
    body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'origin-test', version: '1.0.0' } } })
  });
  assert.equal(allowed.status, 200);
  const session = allowed.headers.get('Mcp-Session-Id');

  const blocked = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: 'https://evil.example', ...auth },
    body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list' })
  });
  assert.equal(blocked.status, 403);

  await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': session, ...auth } });
});
