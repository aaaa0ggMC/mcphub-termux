// Per-server adapter runtime for MCP Hub.
//
// When a server entry in servers.json sets "adapter", the hub does not start the backend
// command directly; it starts `node mcps/<id>/index.ts` (or a path you configure) instead.
// The adapter starts the real backend, proxies stdio in both directions and lets small
// per-server modules rewrite messages - for example turning an HTTP header the client sent
// to the hub into the credential argument the backend expects.
//
// The hub hands the adapter everything it knows:
//   MCP_ADAPTER_COMMAND / MCP_ADAPTER_ARGS / MCP_ADAPTER_CWD / MCP_ADAPTER_ENV
//   MCP_HUB_SERVER_ID / MCP_HUB_SESSION_ID
//   MCP_HUB_HEADERS  - JSON snapshot of the headers of the request that opened the session
// In addition the hub copies the headers of every forwarded request into
// params._meta["mcp-hub/headers"], which is merged over the snapshot for that request.
import { spawn } from 'node:child_process';

const COMMAND = process.env.MCP_ADAPTER_COMMAND || '';
const ARGS = JSON.parse(process.env.MCP_ADAPTER_ARGS || '[]');
const CWD = process.env.MCP_ADAPTER_CWD || process.env.HOME || process.cwd();
const BACKEND_ENV = JSON.parse(process.env.MCP_ADAPTER_ENV || '{}');
const REQUEST_HEADERS_KEY = 'mcp-hub/headers';

function parseJson(raw, fallback) {
  try {
    const value = JSON.parse(raw || '');
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeLine(stream, value) {
  stream.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

// Answer the client yourself instead of forwarding the message - used by adapters that
// enforce their own gate (the memory adapter's X-API-KEY, for example). Return null from
// transformMessage so the request never reaches the backend.
export function respondError(request, code, message) {
  if (!request || request.id === undefined) return null;
  writeLine(process.stdout, { jsonrpc: '2.0', id: request.id, error: { code, message } });
  return null;
}

function each(reply, callback) {
  if (reply === undefined || reply === null) return;
  for (const entry of Array.isArray(reply) ? reply : [reply]) callback(entry);
}

export function toolAccepts(ctx, toolName, argument) {
  const schema = ctx.toolSchemas.get(toolName);
  if (!schema || !schema.properties) return null; // unknown tool: let the caller decide
  return Object.prototype.hasOwnProperty.call(schema.properties, argument);
}

export function runAdapter(hooks = {}) {
  if (!COMMAND) {
    console.error('[adapter] MCP_ADAPTER_COMMAND is missing, nothing to start');
    process.exit(1);
  }

  const sessionHeaders = parseJson(process.env.MCP_HUB_HEADERS, {});
  const ctx = {
    serverId: process.env.MCP_HUB_SERVER_ID || '',
    sessionId: process.env.MCP_HUB_SESSION_ID || '',
    headers: sessionHeaders,
    sessionHeaders,
    toolSchemas: new Map(),
    log: (message) => console.error(`[adapter:${process.env.MCP_HUB_SERVER_ID || '?'}] ${message}`)
  };

  // spawnEnv lets an adapter change the backend environment at startup, based on the headers
  // of the request that opened the session (the memory adapter picks a memory file this way).
  let spawnEnv = {};
  if (hooks.spawnEnv) {
    try {
      spawnEnv = hooks.spawnEnv(ctx) || {};
    } catch (error) {
      ctx.log(`spawnEnv failed: ${error.message}`);
    }
  }

  const backend = spawn(COMMAND, ARGS, {
    cwd: CWD,
    env: { ...process.env, ...BACKEND_ENV, ...spawnEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true
  });

  backend.on('error', (error) => {
    ctx.log(`failed to start backend: ${error.message}`);
    process.exit(1);
  });
  backend.on('exit', (code, signal) => {
    if (code) ctx.log(`backend exited with code ${code}${signal ? ` (${signal})` : ''}`);
    process.exit(code ?? 0);
  });
  backend.stderr.on('data', (chunk) => process.stderr.write(chunk));

  let backendBuffer = '';
  backend.stdout.on('data', (chunk) => {
    backendBuffer += chunk.toString();
    const lines = backendBuffer.split('\n');
    backendBuffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        writeLine(process.stdout, line);
        continue;
      }
      // Remember the tool schemas: the answer to tools/list (no method field) and the
      // tools/list_changed notification both carry them. Adapters use the schemas to decide
      // whether a tool even accepts the argument they would add.
      for (const tools of [message && message.result && message.result.tools, message && message.params && message.params.tools]) {
        if (!Array.isArray(tools)) continue;
        for (const tool of tools) {
          if (tool && tool.name) ctx.toolSchemas.set(tool.name, tool.inputSchema || {});
        }
      }
      try {
        each(hooks.transformReply ? hooks.transformReply(message, ctx) : message, (entry) => writeLine(process.stdout, entry));
      } catch (error) {
        ctx.log(`transformReply failed: ${error.message}`);
        writeLine(process.stdout, message);
      }
    }
  });

  let clientBuffer = '';
  process.stdin.on('data', (chunk) => {
    clientBuffer += chunk.toString();
    const lines = clientBuffer.split('\n');
    clientBuffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        writeLine(backend.stdin, line);
        continue;
      }
      // Fresh headers of this very request win over the session snapshot.
      const meta = message && message.params && message.params._meta;
      ctx.requestHeaders = meta && typeof meta[REQUEST_HEADERS_KEY] === 'object' ? meta[REQUEST_HEADERS_KEY] : null;
      ctx.headers = ctx.requestHeaders ? { ...sessionHeaders, ...ctx.requestHeaders } : sessionHeaders;
      try {
        each(hooks.transformMessage ? hooks.transformMessage(message, ctx) : message, (entry) => writeLine(backend.stdin, entry));
      } catch (error) {
        ctx.log(`transformMessage failed: ${error.message}`);
        writeLine(backend.stdin, message);
      }
    }
  });

  process.stdin.on('end', () => {
    try {
      backend.stdin.end();
    } catch {}
  });
  process.on('SIGTERM', () => {
    try {
      backend.kill('SIGTERM');
    } catch {}
    process.exit(0);
  });
  process.on('SIGINT', () => {
    try {
      backend.kill('SIGINT');
    } catch {}
    process.exit(0);
  });
}

export function firstHeader(ctx, names) {
  for (const name of names) {
    const value = ctx.headers[name];
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  }
  return '';
}
