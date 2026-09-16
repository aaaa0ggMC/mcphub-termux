// Adapter tests: servers.json entries with "adapter" run mcps/<id>/index.ts, which starts the
// real backend and may rewrite messages (header -> tool argument) or the backend environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, '..', 'fixtures', 'fake-control-mcp.js');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-adapters-'));
const configPath = path.join(workDir, 'servers.json');
const baseMemoryFile = path.join(workDir, 'memory.jsonl');

fs.writeFileSync(configPath, JSON.stringify([
  {
    id: 'bilibili',
    name: 'Bilibili (adapter)',
    command: process.execPath,
    args: [fixture],
    cwd: here,
    env: {},
    adapter: 'mcps/bilibili/index.ts',
    transport: 'stdio',
    enabled: true
  },
  {
    id: 'plain',
    name: 'No adapter',
    command: process.execPath,
    args: [fixture],
    cwd: here,
    env: {},
    transport: 'stdio',
    enabled: true
  },
  {
    id: 'kebiao',
    name: 'Kebiao (adapter)',
    command: process.execPath,
    args: [fixture],
    cwd: here,
    env: { KEBIAO_TOKEN: 'test-kebiao-token' },
    adapter: 'mcps/kebiao/index.ts',
    transport: 'stdio',
    enabled: true
  },
  {
    id: 'ledger',
    name: 'Ledger (adapter)',
    command: process.execPath,
    args: [fixture],
    cwd: here,
    env: {},
    adapter: 'mcps/ledger/index.ts',
    transport: 'stdio',
    enabled: true
  },
  {
    id: 'memory',
    name: 'Memory (adapter)',
    command: process.execPath,
    args: [fixture],
    cwd: here,
    env: {
      MEMORY_FILE_PATH: baseMemoryFile,
      MCP_HUB_MEMORY_DIR: workDir,
      MCP_HUB_MEMORY_API_KEY: 'test-key'
    },
    adapter: 'mcps/memory/index.ts',
    transport: 'stdio',
    enabled: true
  }
], null, 2));

process.env.MCP_HUB_CONFIG = configPath;
process.env.MCP_HUB_PORT = '0';
process.env.MCP_HUB_HOST = '127.0.0.1';
delete process.env.MCP_HUB_TOKEN;
delete process.env.MCP_HUB_REQUIRE_SESSION;

const { startHub } = await import('../index.js');
const hub = await startHub({ port: 0, host: '127.0.0.1', banner: false, signals: false });
const base = hub.url;

const INIT = {
  jsonrpc: '2.0',
  id: 'init',
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adapter-test', version: '1.0.0' } }
};

test.after(async () => {
  await hub.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

function post(serverId, body, { session, headers = {} } = {}) {
  return fetch(`${base}/mcps/${serverId}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(session ? { 'Mcp-Session-Id': session } : {}),
      ...headers
    },
    body: JSON.stringify(body)
  });
}

async function openSession(serverId, headers = {}) {
  const init = await post(serverId, INIT, { headers });
  assert.equal(init.status, 200, `initialize failed: ${await init.text()}`);
  const session = init.headers.get('Mcp-Session-Id');
  assert.ok(session, 'hub should hand out a session id');

  // Real clients list tools before calling them; the adapter learns the tool schemas here.
  const list = await post(serverId, { jsonrpc: '2.0', id: 'list', method: 'tools/list' }, { session, headers });
  assert.equal(list.status, 200);
  return session;
}

async function callTool(serverId, session, name, args = {}, headers = {}) {
  const response = await post(serverId, {
    jsonrpc: '2.0',
    id: 'call',
    method: 'tools/call',
    params: { name, arguments: args }
  }, { session, headers });
  assert.equal(response.status, 200);
  return response.json();
}

test('bilibili adapter turns X-Bilibili-Cookie into the cookie argument', async () => {
  const session = await openSession('bilibili', { 'X-Bilibili-Cookie': 'SESSDATA=from-session' });
  const body = await callTool('bilibili', session, 'echo_arguments');
  assert.equal(body.result.structuredContent.arguments.cookie, 'SESSDATA=from-session');
});

test('per request headers win over the headers of the session', async () => {
  const session = await openSession('bilibili', { 'X-Bilibili-Cookie': 'SESSDATA=from-session' });
  const body = await callTool('bilibili', session, 'echo_arguments', {}, { 'X-Bilibili-Cookie': 'SESSDATA=fresh' });
  assert.equal(body.result.structuredContent.arguments.cookie, 'SESSDATA=fresh');
});

test('a credential sent by the client is never overwritten', async () => {
  const session = await openSession('bilibili', { 'X-Bilibili-Cookie': 'SESSDATA=from-session' });
  const body = await callTool('bilibili', session, 'echo_arguments', { cookie: 'SESSDATA=client' });
  assert.equal(body.result.structuredContent.arguments.cookie, 'SESSDATA=client');
});

test('tools without a credential argument are left untouched', async () => {
  const session = await openSession('bilibili', { 'X-Bilibili-Cookie': 'SESSDATA=from-session' });
  const body = await callTool('bilibili', session, 'login', {}, { 'X-Bilibili-Cookie': 'SESSDATA=fresh' });
  assert.deepEqual(body.result.structuredContent.arguments, {});
});

test('bilibili adapter hands the session credential to the backend environment', async () => {
  const session = await openSession('bilibili', { 'X-Bilibili-Cookie': 'SESSDATA=from-session' });
  const body = await callTool('bilibili', session, 'report_env', { name: 'BILIBILI_COOKIE' });
  assert.equal(body.result.structuredContent.env.BILIBILI_COOKIE, 'SESSDATA=from-session');
});

test('piecemeal credential headers become the matching backend environment', async () => {
  const session = await openSession('bilibili', {
    'X-Bilibili-Sessdata': 'sess-from-header',
    'X-Bili-Jct': 'jct-from-header'
  });
  const sessdata = await callTool('bilibili', session, 'report_env', { name: 'BILIBILI_SESSDATA' });
  assert.equal(sessdata.result.structuredContent.env.BILIBILI_SESSDATA, 'sess-from-header');
  const jct = await callTool('bilibili', session, 'report_env', { name: 'BILIBILI_BILI_JCT' });
  assert.equal(jct.result.structuredContent.env.BILIBILI_BILI_JCT, 'jct-from-header');
});

test('a credential path header becomes BILIBILI_CREDENTIAL_PATH', async () => {
  const session = await openSession('bilibili', { 'X-Bilibili-Credential-Path': '~/Apps/bili_info.json' });
  const body = await callTool('bilibili', session, 'report_env', { name: 'BILIBILI_CREDENTIAL_PATH' });
  assert.equal(body.result.structuredContent.env.BILIBILI_CREDENTIAL_PATH, '~/Apps/bili_info.json');
});

test('servers without an adapter are not rewritten', async () => {
  const session = await openSession('plain', { 'X-Bilibili-Cookie': 'SESSDATA=from-session' });
  const body = await callTool('plain', session, 'echo_arguments', {}, { 'X-Bilibili-Cookie': 'SESSDATA=fresh' });
  assert.deepEqual(body.result.structuredContent.arguments, {});
});

test('memory adapter enforces X-API-KEY when MCP_HUB_MEMORY_API_KEY is set', async () => {
  const rejected = await post('memory', INIT);
  assert.equal(rejected.status, 200);
  const error = await rejected.json();
  assert.equal(error.error.code, -32001);
  assert.match(error.error.message, /X-API-KEY/);

  // The session the hub opened for that request stays unusable: it carries no key either.
  const stillRejected = await post('memory', { jsonrpc: '2.0', id: 'list', method: 'tools/list' }, {
    session: rejected.headers.get('Mcp-Session-Id')
  });
  assert.equal((await stillRejected.json()).error.code, -32001);

  const wrongKey = await post('memory', INIT, { headers: { 'X-API-KEY': 'nope' } });
  assert.equal((await wrongKey.json()).error.code, -32001);

  const accepted = await openSession('memory', { 'X-API-KEY': 'test-key' });
  assert.ok(accepted);
});

test('kebiao adapter refuses anonymous sessions and accepts the token header', async () => {
  // 没有令牌：连 initialize 都不给过
  const rejected = await post('kebiao', INIT);
  assert.equal(rejected.status, 200);
  const error = await rejected.json();
  assert.equal(error.error.code, -32001);
  assert.match(error.error.message, /X-Kebiao-Token/);

  // 那次请求建立的会话同样不可用：令牌是会话建立时定下来的
  const stillRejected = await post('kebiao', { jsonrpc: '2.0', id: 'list', method: 'tools/list' }, {
    session: rejected.headers.get('Mcp-Session-Id')
  });
  assert.equal((await stillRejected.json()).error.code, -32001);

  const wrong = await post('kebiao', INIT, { headers: { 'X-Kebiao-Token': 'nope' } });
  assert.equal((await wrong.json()).error.code, -32001);

  // 令牌正确才拿得到工具
  const session = await openSession('kebiao', { 'X-Kebiao-Token': 'test-kebiao-token' });
  const body = await callTool('kebiao', session, 'echo_arguments', { cookie: 'SESSDATA=x' });
  assert.ok(body.result, '带着正确令牌应该能正常调用工具');

  // Authorization: Bearer 是 kebiao 自己 HTTP 路径的用法，这里也认
  const bearer = await openSession('kebiao', { Authorization: 'Bearer test-kebiao-token' });
  assert.ok(bearer);
});

test('ledger adapter refuses anonymous sessions and accepts the key header', async () => {
  const rejected = await post('ledger', INIT);
  const error = await rejected.json();
  assert.equal(error.error.code, -32001);
  assert.match(error.error.message, /X-Ledger-Key/);

  // 匿名不只是看不到账目，写工具也在同一层，所以整条会话都得关门
  const denied = await post('ledger', { jsonrpc: '2.0', id: 'add', method: 'tools/call', params: { name: 'echo_arguments', arguments: {} } }, {
    session: rejected.headers.get('Mcp-Session-Id')
  });
  assert.equal((await denied.json()).error.code, -32001);

  const session = await openSession('ledger', { 'X-Ledger-Key': 'a'.repeat(64) });
  const body = await callTool('ledger', session, 'echo_arguments', {});
  assert.ok(body.result);

  // 会话中途换一把密钥不会生效，会明确报错而不是按旧权限继续
  const swapped = await post('ledger', { jsonrpc: '2.0', id: 'list', method: 'tools/list' }, {
    session,
    headers: { 'X-Ledger-Key': 'b'.repeat(64) }
  });
  assert.equal((await swapped.json()).error.code, -32001);
});

test('memory adapter gives a session its own memory file', async () => {
  const alice = await openSession('memory', { 'X-API-KEY': 'test-key', 'X-Memory-User': 'Alice Smith' });
  const aliceEnv = await callTool('memory', alice, 'report_env', { name: 'MEMORY_FILE_PATH' });
  assert.equal(aliceEnv.result.structuredContent.env.MEMORY_FILE_PATH, path.join(workDir, 'memory-alice_smith.jsonl'));

  const shared = await openSession('memory', { 'X-API-KEY': 'test-key' });
  const sharedEnv = await callTool('memory', shared, 'report_env', { name: 'MEMORY_FILE_PATH' });
  assert.equal(sharedEnv.result.structuredContent.env.MEMORY_FILE_PATH, baseMemoryFile);
});

test('memory adapter keeps x-memory-file inside its base directory', async () => {
  const session = await openSession('memory', { 'X-API-KEY': 'test-key', 'X-Memory-File': '../../etc/passwd' });
  const body = await callTool('memory', session, 'report_env', { name: 'MEMORY_FILE_PATH' });
  assert.equal(body.result.structuredContent.env.MEMORY_FILE_PATH, baseMemoryFile);
});
