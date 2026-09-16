import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, '..', 'fixtures', 'fake-mcp.js');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-resume-'));
const configPath = path.join(workDir, 'servers.json');

fs.writeFileSync(configPath, JSON.stringify([{
  id: 'fake',
  name: 'Fake MCP',
  icon: '🧪',
  description: 'stdio fixture used by the session resume tests',
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
delete process.env.MCP_HUB_TOKEN;
delete process.env.MCP_HUB_REQUIRE_SESSION;
delete process.env.MCP_HUB_RESUME_SESSION;

const { startHub, manager } = await import('../index.js');
const hub = await startHub({ port: 0, host: '127.0.0.1', banner: false, signals: false });
const endpoint = `${hub.url}/mcps/fake/mcp`;

test.after(async () => {
  await hub.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

function post(body, options = {}) {
  const { session, accept = 'application/json, text/event-stream', headers = {}, url = endpoint } = options;
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: accept,
      ...(session ? { 'Mcp-Session-Id': session } : {}),
      ...headers
    },
    body: JSON.stringify(body)
  });
}

async function initialize(options = {}) {
  const response = await post({
    jsonrpc: '2.0',
    id: 'init',
    method: 'initialize',
    params: {
      protocolVersion: options.protocolVersion || '2025-11-25',
      capabilities: { roots: { listChanged: true } },
      clientInfo: { name: options.clientName || 'resume-test', version: '1.0.0' }
    }
  }, options);
  const session = response.headers.get('Mcp-Session-Id');
  await response.json();
  return { session, response };
}

function callTool(session, name = 'echo') {
  return post({ jsonrpc: '2.0', id: `call-${name}`, method: 'tools/call', params: { name, arguments: {} } }, { session })
    .then((response) => response.json());
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for condition');
}

test('an expired session id is resumed with the client handshake replayed', async () => {
  const { session } = await initialize();
  const before = await callTool(session);

  // Drop the session behind the client's back, the way the idle reaper or a hub restart does.
  manager.closeHttpSession(session, 'expired in test');

  const response = await post({ jsonrpc: '2.0', id: 'after-expiry', method: 'tools/call', params: { name: 'echo', arguments: {} } }, { session });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Mcp-Session-Id'), session, 'the client keeps its own id');

  const payload = await response.json();
  assert.notEqual(payload.result.structuredContent.pid, before.result.structuredContent.pid, 'expected a fresh backend process');
  assert.equal(payload.result.structuredContent.initialized, true, 'the backend should be initialized again');
  assert.equal(payload.result.structuredContent.handshake.clientInfo.name, 'resume-test');
  assert.equal(payload.result.structuredContent.handshake.protocolVersion, '2025-11-25');

  // The resumed session stays usable and keeps the same process instead of respawning.
  const again = await callTool(session);
  assert.equal(again.result.structuredContent.pid, payload.result.structuredContent.pid);
  await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': session } });
});

test('an id the hub never saw is served with the hub handshake', async () => {
  const response = await post({ jsonrpc: '2.0', id: 'unknown', method: 'tools/call', params: { name: 'echo', arguments: {} } }, {
    session: 'client-generated-id-0123456789'
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Mcp-Session-Id'), 'client-generated-id-0123456789');

  const payload = await response.json();
  assert.equal(payload.result.structuredContent.initialized, true);
  assert.equal(payload.result.structuredContent.handshake.clientInfo.name, 'mcp-hub');
  await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': 'client-generated-id-0123456789' } });
});

test('a re-initialize that carries a stale id reuses that id', async () => {
  const clientId = 'stale-id-that-the-client-still-uses';
  const response = await post({
    jsonrpc: '2.0',
    id: 'reinit',
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'reconnect', version: '2.0.0' } }
  }, { session: clientId });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Mcp-Session-Id'), clientId);
  await response.json();

  const notified = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { session: clientId });
  assert.equal(notified.status, 202);

  const payload = await callTool(clientId);
  assert.equal(payload.result.structuredContent.initialized, true);
  assert.equal(payload.result.structuredContent.handshake.clientInfo.name, 'reconnect');
  await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': clientId } });
});

test('GET reopens the notification stream of a stale session', async () => {
  const staleId = 'stale-id-for-get';
  const streamResponse = await fetch(endpoint, { headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': staleId } });
  assert.equal(streamResponse.status, 200);
  assert.match(streamResponse.headers.get('content-type'), /text\/event-stream/);
  assert.equal(streamResponse.headers.get('Mcp-Session-Id'), staleId);

  const reader = streamResponse.body.getReader();
  const payload = await callTool(staleId);
  assert.equal(payload.result.structuredContent.initialized, true);
  await reader.cancel();
  await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': staleId } });
});

test('a session whose backend process died is resumed instead of failing', async () => {
  const { session } = await initialize();
  const before = await callTool(session);

  manager.getHttpSession(session).proc.process.kill('SIGKILL');
  await waitFor(() => !manager.getHttpSession(session).proc.process);

  const payload = await callTool(session);
  assert.equal(payload.result.structuredContent.initialized, true);
  assert.notEqual(payload.result.structuredContent.pid, before.result.structuredContent.pid);
  await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': session } });
});

test('the remembered handshake never keeps the adapter header snapshot', () => {
  // The hub attaches the request headers as params._meta for adapter servers. A replayed
  // handshake must not reuse those (stale) credentials, so they are stripped when remembering.
  manager.rememberHandshake('handshake-with-meta', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'meta-test', version: '1.0.0' },
    _meta: { 'mcp-hub/headers': { authorization: 'Bearer secret' } }
  }, '2025-11-25');

  const remembered = manager.getHandshake('handshake-with-meta');
  assert.equal(remembered.params.protocolVersion, '2025-11-25');
  assert.equal(remembered.params._meta, undefined);
  assert.equal(remembered.params.clientInfo.name, 'meta-test');
});

test('MCP_HUB_RESUME_SESSION=0 keeps the strict spec behaviour', async () => {
  const { session } = await initialize();
  manager.closeHttpSession(session, 'expired in test');
  manager.resumeSessions = false;
  try {
    const response = await post({ jsonrpc: '2.0', id: 'strict', method: 'tools/list', params: {} }, { session });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, -32001);

    const stream = await fetch(endpoint, { headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': session } });
    assert.equal(stream.status, 404);
    await stream.body.cancel();

    const deleted = await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': session } });
    assert.equal(deleted.status, 404);
  } finally {
    manager.resumeSessions = true;
  }

  const resumed = await post({ jsonrpc: '2.0', id: 'lenient-again', method: 'tools/call', params: { name: 'echo', arguments: {} } }, { session });
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).result.structuredContent.initialized, true);
  await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': session } });
});
