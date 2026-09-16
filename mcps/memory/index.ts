// Memory MCP adapter.
//
// Two things people expect from the memory server are not part of it:
//   1. an X-API-KEY gate - that check lives in mcp-proxy (the `mcp-proxy --apiKey ...`
//      wrapper), so a hub started memory server has no way to authenticate clients;
//   2. per client memory - @modelcontextprotocol/server-memory only reads MEMORY_FILE_PATH
//      and shares that one file between everyone who connects.
//
// This adapter adds both. Set MCP_HUB_MEMORY_API_KEY (servers.json "env") to require a
// matching X-API-KEY / "Authorization: Bearer" header, and send X-Memory-File (or
// X-Memory-User / X-Memory-Session) to give a session its own graph file. Without those
// headers everyone keeps using the shared file from MEMORY_FILE_PATH, exactly as before.
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { firstHeader, respondError, runAdapter } from '../_adapter.js';
import type { AdapterContext } from '../_adapter.js';

const DEFAULT_FILE = path.resolve(
  process.env.MCP_HUB_MEMORY_FILE || process.env.MEMORY_FILE_PATH || path.join(process.cwd(), 'memory.jsonl')
);
const BASE_DIR = path.resolve(process.env.MCP_HUB_MEMORY_DIR || path.dirname(DEFAULT_FILE));
const API_KEY = process.env.MCP_HUB_MEMORY_API_KEY || '';

let warnedAboutKey = false;

// Only files inside BASE_DIR are allowed, so a client cannot point the graph at any path on
// the machine (the memory server writes the file itself).
function resolveInsideBase(candidate: string): string | null {
  const resolved = path.resolve(BASE_DIR, candidate);
  if (resolved === BASE_DIR || !resolved.startsWith(BASE_DIR + path.sep)) return null;
  return resolved;
}

function safeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 64) || 'anonymous';
}

function memoryTargetFromHeaders(ctx: AdapterContext): { file: string; source: string } {
  const explicit = firstHeader(ctx, ['x-memory-file', 'x-memory-path']);
  if (explicit) {
    const file = resolveInsideBase(explicit);
    if (!file) throw new Error(`x-memory-file must stay inside ${BASE_DIR}`);
    return { file, source: 'x-memory-file' };
  }

  const owner = firstHeader(ctx, ['x-memory-user', 'x-memory-session', 'x-session-id']);
  if (owner) return { file: path.join(BASE_DIR, `memory-${safeName(owner)}.jsonl`), source: 'session header' };

  return { file: DEFAULT_FILE, source: 'default' };
}

function matchesApiKey(ctx: AdapterContext): boolean {
  if (!API_KEY) return true;
  let given = firstHeader(ctx, ['x-api-key', 'x-memory-api-key']);
  if (!given) {
    const authorization = firstHeader(ctx, ['authorization']);
    if (/^bearer\s+/i.test(authorization)) given = authorization.replace(/^bearer\s+/i, '').trim();
  }
  const a = Buffer.from(given);
  const b = Buffer.from(API_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

runAdapter({
  spawnEnv(ctx) {
    let target;
    try {
      target = memoryTargetFromHeaders(ctx);
    } catch (error) {
      ctx.log(`${error.message}; using ${DEFAULT_FILE} instead`);
      target = { file: DEFAULT_FILE, source: 'default' };
    }
    ctx.log(`memory file: ${target.file} (${target.source})`);
    return { MEMORY_FILE_PATH: target.file };
  },

  transformMessage(message, ctx) {
    if (!message || typeof message !== 'object' || message.method === undefined) return message;
    if (matchesApiKey(ctx)) return message;

    if (!warnedAboutKey) {
      warnedAboutKey = true;
      ctx.log('rejected a request without a valid X-API-KEY; unset MCP_HUB_MEMORY_API_KEY to disable the check');
    }
    return respondError(message, -32001, 'Unauthorized: X-API-KEY is missing or does not match');
  }
});
