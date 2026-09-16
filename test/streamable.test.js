import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, '..', 'fixtures', 'fake-mcp.js');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-transport-'));
const configPath = path.join(workDir, 'servers.json');

fs.writeFileSync(configPath, JSON.stringify([{
  id: 'fake',
  name: 'Fake MCP',
  icon: '🧪',
  description: 'stdio fixture used by the transport tests',
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

const { startHub } = await import('../index.js');
const hub = await startHub({ port: 0, host: '127.0.0.1', banner: false, signals: false });
const base = hub.url;
const endpoint = `${base}/mcps/fake/mcp`;

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
    id: 'init-1',
    method: 'initialize',
    params: { protocolVersion: options.protocolVersion || '2025-06-18', capabilities: {}, clientInfo: { name: 'hub-test', version: '1.0.0' } }
  }, options);
  const session = response.headers.get('Mcp-Session-Id');
  const payload = await response.json();
  return { response, session, payload };
}

function sseStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    get text() {
      return buffer;
    },
    async read() {
      const chunk = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 8000))
      ]);
      if (chunk.timeout) throw new Error(`SSE read timed out. Received: ${buffer.slice(-400)}`);
      if (chunk.done) throw new Error(`SSE stream ended. Received: ${buffer.slice(-400)}`);
      buffer += decoder.decode(chunk.value, { stream: true });
    },
    async waitForText(pattern, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const match = buffer.match(pattern);
        if (match) return match;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${pattern}. Received: ${buffer.slice(-400)}`);
        await this.read();
      }
    },
    async waitForEvent(predicate, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        for (const line of buffer.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            const message = JSON.parse(line.slice(6));
            if (predicate(message)) return message;
          } catch {}
        }
        if (Date.now() > deadline) throw new Error(`Timed out waiting for event. Received: ${buffer.slice(-400)}`);
        await this.read();
      }
    },
    async close() {
      try {
        await reader.cancel();
      } catch {}
    }
  };
}

test('initialize returns a session id and JSON response', async () => {
  const { response, session, payload } = await initialize();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.ok(session, 'expected an Mcp-Session-Id header');
  assert.equal(payload.id, 'init-1');
  assert.equal(payload.result.protocolVersion, '2025-06-18');
  assert.equal(payload.result.serverInfo.name, 'fake-mcp');

  await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': session } });
});

test('notifications are accepted with 202 and no body', async () => {
  const { session } = await initialize();
  const response = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { session });
  assert.equal(response.status, 202);
  assert.equal(await response.text(), '');

  const legacy = await post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'nope', reason: 'test' } });
  assert.equal(legacy.status, 202);
  assert.equal(legacy.headers.get('Mcp-Session-Id'), null);
});

test('tools/list works with a session and without one', async () => {
  const { session } = await initialize();
  const withSession = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { session });
  assert.equal(withSession.status, 200);
  assert.equal(withSession.headers.get('Mcp-Session-Id'), session);
  const tools = await withSession.json();
  assert.deepEqual(tools.result.tools.map((tool) => tool.name), ['echo', 'notify']);

  // Requests without a session id keep working on the shared warm process.
  const stateless = await post({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
  assert.equal(stateless.status, 200);
  assert.equal(stateless.headers.get('Mcp-Session-Id'), null);
  assert.equal((await stateless.json()).result.tools.length, 2);
});

test('each session owns its own backend process', async () => {
  const first = await initialize();
  const second = await initialize();
  assert.notEqual(first.session, second.session);

  const call = (session) => post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } }, { session }).then((res) => res.json());
  const firstCall = await call(first.session);
  const secondCall = await call(second.session);
  assert.notEqual(firstCall.result.structuredContent.pid, secondCall.result.structuredContent.pid);

  await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': first.session } });
  await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': second.session } });
});

test('JSON-RPC errors from the backend are relayed', async () => {
  const { session } = await initialize();
  const response = await post({ jsonrpc: '2.0', id: 5, method: 'does/not/exist' }, { session });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.id, 5);
  assert.equal(payload.error.code, -32601);
  await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': session } });
});

test('batch requests are answered as a batch', async () => {
  const { session } = await initialize();
  const response = await post([
    { jsonrpc: '2.0', id: 'b1', method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 'b2', method: 'ping' }
  ], { session });
  const payload = await response.json();
  assert.ok(Array.isArray(payload));
  assert.deepEqual(payload.map((entry) => entry.id), ['b1', 'b2']);
  await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': session } });
});

test('clients that cannot accept JSON get the response as an SSE stream', async () => {
  const response = await post({
    jsonrpc: '2.0',
    id: 'sse-init',
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'sse-only', version: '1.0.0' } }
  }, { accept: 'text/event-stream' });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const session = response.headers.get('Mcp-Session-Id');
  assert.ok(session, 'expected the session id on the streamed response');

  const stream = sseStream(response);
  const message = await stream.waitForEvent((entry) => entry.id === 'sse-init');
  assert.equal(message.result.protocolVersion, '2025-11-25');
  await stream.close();
  await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': session } });
});

test('GET stream delivers server initiated notifications', async () => {
  const { session } = await initialize();
  const streamResponse = await fetch(endpoint, { headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': session } });
  assert.equal(streamResponse.status, 200);
  assert.match(streamResponse.headers.get('content-type'), /text\/event-stream/);
  assert.equal(streamResponse.headers.get('Mcp-Session-Id'), session);

  const stream = sseStream(streamResponse);
  await post({ jsonrpc: '2.0', id: 'notify-1', method: 'tools/call', params: { name: 'notify', arguments: {} } }, { session });

  const notification = await stream.waitForEvent((entry) => entry.method === 'notifications/message');
  assert.match(notification.params.data, /^tick \d+$/);
  await stream.close();
  await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': session } });
});

test('GET stream can replay events after Last-Event-ID', async () => {
  const { session } = await initialize();

  const firstResponse = await fetch(endpoint, { headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': session } });
  const first = sseStream(firstResponse);
  await post({ jsonrpc: '2.0', id: 'notify-2', method: 'tools/call', params: { name: 'notify', arguments: {} } }, { session });
  await first.waitForEvent((entry) => entry.method === 'notifications/message');
  const eventId = Number(first.text.match(/id: (\d+)/)[1]);
  await first.close();

  const secondResponse = await fetch(endpoint, { headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': session, 'Last-Event-ID': String(eventId - 1) } });
  const second = sseStream(secondResponse);
  const replayed = await second.waitForEvent((entry) => entry.method === 'notifications/message');
  assert.match(replayed.params.data, /^tick \d+$/);
  await second.close();
  await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': session } });
});

test('DELETE closes the session and a later request resumes it under the same id', async () => {
  const { session } = await initialize();
  const before = await post({ jsonrpc: '2.0', id: 'pid-before', method: 'tools/call', params: { name: 'echo', arguments: {} } }, { session });
  const beforePid = (await before.json()).result.structuredContent.pid;

  const deleted = await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': session } });
  assert.equal(deleted.status, 204);

  // Idempotent cleanup: deleting an id the hub already dropped is not an error.
  const again = await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': session } });
  assert.equal(again.status, 204);

  const after = await post({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'echo', arguments: {} } }, { session });
  assert.equal(after.status, 200);
  assert.equal(after.headers.get('Mcp-Session-Id'), session);
  const payload = await after.json();
  assert.notEqual(payload.result.structuredContent.pid, beforePid, 'expected a fresh backend process');
  // The client never re-initialized, so the hub replayed the handshake for the new process.
  assert.equal(payload.result.structuredContent.initialized, true);
  assert.equal(payload.result.structuredContent.handshake.clientInfo.name, 'hub-test');
  await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': session } });
});

test('the transport enforces the spec level HTTP checks', async () => {
  const { session } = await initialize();

  const badAccept = await post({ jsonrpc: '2.0', id: 7, method: 'tools/list' }, { session, accept: 'text/plain' });
  assert.equal(badAccept.status, 406);

  const badVersion = await post({ jsonrpc: '2.0', id: 8, method: 'tools/list' }, { session, headers: { 'MCP-Protocol-Version': '1999-01-01' } });
  assert.equal(badVersion.status, 400);
  const versionError = await badVersion.json();
  assert.deepEqual(versionError.error.data.supported, ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']);

  const badJson = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{not json' });
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).error.code, -32700);

  const getWithoutSession = await fetch(endpoint, { headers: { Accept: 'text/event-stream' } });
  assert.equal(getWithoutSession.status, 400);

  const put = await fetch(endpoint, { method: 'PUT', headers: { Accept: 'application/json' } });
  assert.equal(put.status, 405);

  await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': session } });
});

test('legacy HTTP+SSE transport still works', async () => {
  const response = await fetch(`${base}/mcps/fake/sse`, { headers: { Accept: 'text/event-stream' } });
  assert.equal(response.status, 200);
  const stream = sseStream(response);
  const endpointMatch = await stream.waitForText(/data: (\/mcps\/fake\/messages\?sessionId=[^\n]+)/);

  await post({ jsonrpc: '2.0', id: 'legacy-1', method: 'tools/list', params: {} }, { url: `${base}${endpointMatch[1]}` });
  const message = await stream.waitForEvent((entry) => entry.id === 'legacy-1');
  assert.equal(message.result.tools.length, 2);
  await stream.close();
});

test('bare /mcps/:id stays usable and shows an info page in a browser', async () => {
  const response = await post({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }, { url: `${base}/mcps/fake` });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, 9);

  const page = await fetch(`${base}/mcps/fake`, { headers: { Accept: 'text/html' } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Streamable HTTP/);
  assert.match(html, /\/mcps\/fake\/mcp/);
});

test('cross origin browser requests are rejected and health stays open', async () => {
  const rejected = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list' })
  });
  assert.equal(rejected.status, 403);

  const health = await fetch(`${base}/mcps/fake/health`);
  assert.equal(health.status, 200);
  const payload = await health.json();
  assert.equal(payload.endpoints.streamableHttp, `${base}/mcps/fake/mcp`);
  assert.deepEqual(payload.protocolVersions, ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']);
  assert.equal(payload.authRequired, false);
});
