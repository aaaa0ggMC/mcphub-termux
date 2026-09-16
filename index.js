import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.MCP_HUB_PORT || '8888', 10);
const HOST = process.env.MCP_HUB_HOST || '0.0.0.0';
const CONFIG_FILE = process.env.MCP_HUB_CONFIG
  ? path.resolve(process.env.MCP_HUB_CONFIG)
  : path.join(__dirname, 'servers.json');
const HUB_VERSION = '1.0.0';

// --- Streamable HTTP settings ---
const AUTH_TOKEN = process.env.MCP_HUB_TOKEN || '';
const ALLOWED_ORIGINS = (process.env.MCP_HUB_ALLOWED_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const REQUEST_TIMEOUT_MS = parseInt(process.env.MCP_HUB_REQUEST_TIMEOUT_MS || '60000', 10);
const MAX_HTTP_SESSIONS = parseInt(process.env.MCP_HUB_MAX_SESSIONS || '32', 10);
const SESSION_IDLE_MS = parseInt(process.env.MCP_HUB_SESSION_IDLE_MS || String(30 * 60 * 1000), 10);
// Requests without an Mcp-Session-Id are still served by the shared warm process (old Hub
// behaviour). Set MCP_HUB_REQUIRE_SESSION=1 for strict spec behaviour (HTTP 400 instead).
const STATELESS_FALLBACK = process.env.MCP_HUB_REQUIRE_SESSION !== '1';
// A client that keeps sending an Mcp-Session-Id the hub no longer knows (idle expiry, hub
// restart, crashed backend process) gets that id back instead of a 404: credentials travel with
// every request, so a freshly spawned backend process can answer right away. The session is
// resumed under the id the client already cached, and the handshake it did earlier is replayed
// for the new process. Set MCP_HUB_RESUME_SESSION=0 for strict spec behaviour (404 instead).
const RESUME_SESSION = process.env.MCP_HUB_RESUME_SESSION !== '0';
// How many recent initialize handshakes are kept around to replay after a resume.
const HANDSHAKE_CACHE_SIZE = parseInt(process.env.MCP_HUB_HANDSHAKE_CACHE || '256', 10);

// Revisions the hub relays. The bundled stdio servers use the session based Streamable HTTP
// world (2025-11-25 and older); the stateless 2026-07-28 revision is not supported yet.
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const SESSION_ID_HEADER = 'mcp-session-id';
const PROTOCOL_VERSION_HEADER = 'mcp-protocol-version';
const EVENT_BUFFER_SIZE = 512;
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, MCP-Protocol-Version'
};

// Per-server adapters (mcps/<id>/index.ts) get the headers of the HTTP request through this
// key. The hub copies it onto every request it forwards, so an adapter can turn a header the
// backend never sees (X-Bilibili-Cookie, X-API-KEY, ...) into something it does understand.
// It is stripped again before anything is logged or sent back to the client.
const REQUEST_HEADERS_META = 'mcp-hub/headers';

// --- Managed service (launcher) settings ---
// A "service" entry is a plain long running process the hub owns, like an MCP entry, but
// instead of speaking JSON-RPC over stdio it usually listens on a local port. The hub
// supervises it (start/stop/restart/logs), probes its health and can reverse proxy it under
// /apps/<id>/... on the hub port, so one port is still enough.
const SERVICE_HEALTH_INTERVAL_MS = parseInt(process.env.MCP_HUB_HEALTH_INTERVAL_MS || '15000', 10);
// A service usually needs a moment before it listens, so the first probes come fast and the
// steady interval only takes over once it is up (or after SERVICE_STARTUP_PROBES tries).
const SERVICE_HEALTH_STARTUP_INTERVAL_MS = parseInt(process.env.MCP_HUB_HEALTH_STARTUP_INTERVAL_MS || '700', 10);
const SERVICE_STARTUP_PROBES = 10;
const SERVICE_HEALTH_TIMEOUT_MS = parseInt(process.env.MCP_HUB_HEALTH_TIMEOUT_MS || '3000', 10);
const SERVICE_STOP_GRACE_MS = parseInt(process.env.MCP_HUB_SERVICE_STOP_GRACE_MS || '4000', 10);
const SERVICE_RESTART_DELAY_MS = parseInt(process.env.MCP_HUB_SERVICE_RESTART_DELAY_MS || '1200', 10);
const SERVICE_RESTART_WINDOW_MS = 5 * 60 * 1000;
const SERVICE_MAX_RESTARTS = parseInt(process.env.MCP_HUB_SERVICE_MAX_RESTARTS || '5', 10);
const SERVICE_RESTART_POLICIES = ['no', 'on-failure', 'always'];
// Usage/quota is much slower moving than health, so it is polled on its own cadence.
const SERVICE_USAGE_INTERVAL_MS = parseInt(process.env.MCP_HUB_USAGE_INTERVAL_MS || '60000', 10);
const SERVICE_USAGE_TIMEOUT_MS = parseInt(process.env.MCP_HUB_USAGE_TIMEOUT_MS || '5000', 10);
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

// Entries are "mcp" (stdio JSON-RPC, the original hub) or "service" (a supervised process,
// usually an HTTP server the hub can proxy). An entry without "kind" stays an MCP server.
function isServiceConfig(config) {
  return Boolean(config) && config.kind === 'service';
}

// `servers.json` is hand-written and may be moved between machines (a phone and a laptop, say),
// so the paths handed to child processes accept `~` and `$HOME` instead of forcing one
// machine's absolute layout into a shared file.
function expandHome(value) {
  if (typeof value !== 'string' || value === '') return value;
  const home = os.homedir();
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  if (value === '$HOME' || value === '${HOME}') return home;
  return value.replace(/^\$(?:\{HOME\}|HOME)(?=\/)/, home);
}

function expandConfigPaths(config) {
  for (const key of ['command', 'cwd']) {
    if (typeof config[key] === 'string') config[key] = expandHome(config[key]);
  }
  if (Array.isArray(config.args)) config.args = config.args.map(expandHome);
  if (config.env && typeof config.env === 'object') {
    // Only string values are expanded; numbers/booleans are left for spawn to stringify.
    config.env = Object.fromEntries(
      Object.entries(config.env).map(([key, value]) => [key, expandHome(value)])
    );
  }
  return config;
}

// `existing` lets an update keep the tri-state switches (absent means "leave it as it was").
function normalizeServerConfig(config, existing = null) {
  const normalized = expandConfigPaths({ ...config });
  normalized.kind = normalized.kind === 'service' ? 'service' : 'mcp';
  normalized.enabled = normalized.enabled === undefined
    ? (existing ? existing.enabled !== false : true)
    : normalized.enabled !== false;
  normalized.autoStart = normalized.autoStart === undefined
    ? (existing ? existing.autoStart !== false : true)
    : normalized.autoStart !== false;

  if (normalized.kind === 'service') {
    normalized.port = Number.parseInt(normalized.port, 10) || 0;
    normalized.host = normalized.host || '127.0.0.1';
    normalized.healthPath = normalized.healthPath || '/healthz';
    normalized.restart = SERVICE_RESTART_POLICIES.includes(normalized.restart)
      ? normalized.restart
      : 'on-failure';
    // Services speak their own port by default; the hub only mirrors one under /apps/<id>/ when
    // the entry opts in with "proxy": true.
    normalized.proxy = normalized.proxy === true;
    // Optional endpoint that reports quota/usage (codex-proxy serves /v1/usage). Purely
    // informational: the hub only reads it and shows it in the dashboard.
    normalized.usagePath = typeof normalized.usagePath === 'string' && normalized.usagePath.trim()
      ? normalized.usagePath.trim()
      : '';
    delete normalized.adapter; // adapters only make sense for stdio MCP servers
  } else {
    normalized.transport = 'stdio';
  }
  return normalized;
}

// --- Session & Process Bridge ---
class StdioSession extends EventEmitter {
  constructor(serverId, config, options = {}) {
    super();
    this.id = randomUUID();
    this.serverId = serverId;
    this.config = config;
    // Headers of the request that opened this session. Adapters see them first and get the
    // headers of every later request on top, see attachRequestHeaders().
    this.headers = options.headers || {};
    this.process = null;
    this.buffer = '';
    this.createdAt = Date.now();
    this.lastActive = Date.now();
    this.pendingRequests = new Map(); // id -> resolve
    this.initResult = null;
    this.readyPromise = null;
    this.startProcess();
  }

  // A server entry with "adapter" is not started directly: the hub runs the adapter
  // (node mcps/<id>/index.ts) and hands the real backend over through MCP_ADAPTER_*.
  // See mcps/_adapter.js for the contract and README.md for how to write one.
  startProcess() {
    const config = this.config;
    const env = { ...process.env, ...(config.env || {}) };
    let command = config.command;
    let args = config.args || [];
    let cwd = config.cwd || process.env.HOME;

    if (config.adapter) {
      const adapterPath = path.isAbsolute(config.adapter) ? config.adapter : path.join(__dirname, config.adapter);
      env.MCP_ADAPTER_COMMAND = config.command || '';
      env.MCP_ADAPTER_ARGS = JSON.stringify(config.args || []);
      env.MCP_ADAPTER_CWD = config.cwd || process.env.HOME || __dirname;
      env.MCP_ADAPTER_ENV = JSON.stringify(config.env || {});
      env.MCP_HUB_SERVER_ID = this.serverId;
      env.MCP_HUB_SESSION_ID = this.id;
      env.MCP_HUB_HEADERS = JSON.stringify(this.headers || {});
      command = process.execPath;
      args = [adapterPath];
      cwd = path.dirname(adapterPath);
    }

    this.process = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true
    });

    this.process.stdout.on('data', (data) => {
      this.lastActive = Date.now();
      this.buffer += data.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop(); // keep remainder

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          this.emit('message', parsed, trimmed);

          // Handle pending request/response matching
          if (parsed.id !== undefined && this.pendingRequests.has(parsed.id)) {
            const cb = this.pendingRequests.get(parsed.id);
            this.pendingRequests.delete(parsed.id);
            cb(parsed);
          }
        } catch {
          // not JSON, emit raw line
          this.emit('rawStdout', trimmed);
        }
      }
    });

    this.process.stderr.on('data', (data) => {
      this.lastActive = Date.now();
      const str = data.toString();
      const lines = str.split('\n');
      for (const line of lines) {
        if (line.trim()) this.emit('stderr', line.trim());
      }
    });

    this.process.on('exit', (code, signal) => {
      this.emit('exit', code, signal);
      this.destroy();
    });

    this.process.on('error', (err) => {
      this.emit('error', err);
      this.destroy();
    });
  }

  send(msg) {
    if (!this.process || !this.process.stdin.writable) return false;
    this.lastActive = Date.now();
    const str = typeof msg === 'string' ? msg : JSON.stringify(msg);
    this.process.stdin.write(str + '\n');
    return true;
  }

  sendRequest(msg, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      if (!this.send(msg)) return reject(new Error('Process stdin not writable'));
      const id = msg.id;
      if (id === undefined) return resolve({ success: true });

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP request timeout (${id})`));
      }, timeoutMs);

      this.pendingRequests.set(id, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
    });
  }

  // Hub driven handshake, used when the hub itself talks to a stdio server (stateless
  // fallback path and resumed sessions). Client sessions perform the handshake with the
  // client's own initialize request instead. `params` replays a handshake the client sent
  // earlier, so a resumed process sees the same protocol version and client capabilities.
  ensureInitialized(protocolVersion = LATEST_PROTOCOL_VERSION, params = null) {
    if (this.initResult) return Promise.resolve(this.initResult);
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        const defaults = {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: 'mcp-hub', version: HUB_VERSION }
        };
        const response = await this.sendRequest({
          jsonrpc: '2.0',
          id: `hub-init-${randomUUID()}`,
          method: 'initialize',
          params: params && typeof params === 'object' ? { ...defaults, ...params } : defaults
        }, REQUEST_TIMEOUT_MS);
        if (response && response.error) throw new Error(response.error.message || 'initialize failed');
        this.initResult = (response && response.result) || {};
        this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        return this.initResult;
      })().catch((error) => {
        this.readyPromise = null;
        throw error;
      });
    }
    return this.readyPromise;
  }

  destroy() {
    for (const [id, cb] of this.pendingRequests.entries()) {
      cb({ error: { code: -32000, message: 'Session closed' } });
    }
    this.pendingRequests.clear();
    if (this.process) {
      try {
        this.process.kill('SIGTERM');
      } catch {}
      this.process = null;
    }
  }
}

// --- Managed service process (launcher) ---
// Kills the whole process group, so `shell: true` wrappers and the real server die together.
function signalProcess(proc, signal) {
  if (!proc || proc.pid === undefined) return;
  try {
    process.kill(-proc.pid, signal);
    return;
  } catch {
    // no process group (or it is already gone); fall back to the process itself
  }
  try {
    proc.kill(signal);
  } catch {}
}

function httpProbe(url, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ at: Date.now(), latencyMs: Date.now() - started, ...result });
    };
    const req = http.request(url, { method: 'GET', timeout: timeoutMs, headers: { accept: '*/*' } }, (res) => {
      res.resume();
      const ok = res.statusCode < 500;
      finish({
        state: ok ? 'up' : 'down',
        statusCode: res.statusCode,
        error: ok ? null : `upstream replied HTTP ${res.statusCode}`
      });
    });
    req.on('timeout', () => req.destroy(new Error(`health probe timed out after ${timeoutMs}ms`)));
    req.on('error', (error) => finish({ state: 'down', statusCode: null, error: error.message }));
    req.end();
  });
}

// A service that exposes a usage endpoint (codex-proxy's /v1/usage) reports quota windows.
// Anything else in the payload is ignored, the hub only needs a label and how much is left.
function normalizeServiceUsage(payload, at = Date.now()) {
  const windows = [];
  const raw = payload && typeof payload === 'object' ? payload.windows : null;
  const entries = Array.isArray(raw)
    ? raw.map((window) => [null, window])
    : raw && typeof raw === 'object'
      ? Object.entries(raw)
      : [];
  for (const [key, window] of entries) {
    if (!window || typeof window !== 'object') continue;
    const remaining = Number(window.remaining_percent);
    if (!Number.isFinite(remaining)) continue;
    const used = Number(window.used_percent);
    windows.push({
      key: key || String(window.label || window.slot || ''),
      label: String(window.label || window.slot || key || 'quota'),
      // codex-proxy serves both a long label and a compact one ("weekly" / "7d"); the compact
      // form is what fits in a card fact, so keep it when the service offers it.
      shortLabel: typeof window.short_label === 'string' && window.short_label ? window.short_label : null,
      usedPercent: Number.isFinite(used) ? used : Math.max(0, 100 - remaining),
      remainingPercent: Math.max(0, Math.min(100, remaining)),
      windowSeconds: Number.isFinite(Number(window.window_seconds)) ? Number(window.window_seconds) : null,
      resetsAt: typeof window.resets_at === 'string' ? window.resets_at : null
    });
  }
  if (!windows.length) return null;
  windows.sort((a, b) => (a.windowSeconds || 0) - (b.windowSeconds || 0));
  return {
    at,
    planType: payload.plan_type ? String(payload.plan_type) : null,
    limitReached: payload.limit_reached === true,
    stale: payload.stale === true,
    windows
  };
}

function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', timeout: timeoutMs, headers: { accept: 'application/json' } }, (res) => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(body) });
        } catch (error) {
          reject(new Error(`response is not JSON: ${error.message}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

class ServiceProcess extends EventEmitter {
  constructor(serviceId, config) {
    super();
    this.id = randomUUID();
    this.serviceId = serviceId;
    this.config = config;
    this.process = null;
    this.startedAt = null;
    this.stopping = false;
    this.restarts = 0;
    this.restartTimes = [];
    this.buffers = { rawStdout: '', stderr: '' };
    this.health = { state: 'unknown', at: null, statusCode: null, error: null, latencyMs: null };
    this.healthTimer = null;
    this.healthActive = false;
    this.usageTimer = null;
    this.usageActive = false;
    this.usage = null;
    this.restartTimer = null;
  }

  get running() {
    return Boolean(this.process && this.process.exitCode === null);
  }

  get upstream() {
    const port = this.config.port;
    if (!port) return null;
    return `http://${this.config.host || '127.0.0.1'}:${port}`;
  }

  start() {
    if (this.running) return false;
    this.clearRestartTimer();
    const config = this.config;
    const env = { ...process.env, ...(config.env || {}) };
    const cwd = config.cwd || process.env.HOME || __dirname;
    this.stopping = false;
    this.health = { state: 'unknown', at: null, statusCode: null, error: null, latencyMs: null };

    // detached so the hub owns a process group and can kill the server and whatever it spawned.
    this.process = spawn(config.command, config.args || [], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      detached: true
    });
    this.startedAt = Date.now();

    const proc = this.process;
    proc.stdout.on('data', (data) => this.emitLines(data, 'rawStdout'));
    proc.stderr.on('data', (data) => this.emitLines(data, 'stderr'));
    // A killed child can make its pipes emit errors; they are noise, not a hub failure.
    proc.stdout.on('error', () => {});
    proc.stderr.on('error', () => {});
    proc.on('error', (error) => this.emit('error', error));
    proc.on('exit', (code, signal) => this.onExit(proc, code, signal));

    this.emit('started', { pid: proc.pid });
    this.scheduleHealthChecks();
    this.scheduleUsageChecks();
    return true;
  }

  emitLines(data, event) {
    const buffered = (this.buffers[event] || '') + data.toString();
    const lines = buffered.split('\n');
    this.buffers[event] = lines.pop();
    for (const line of lines) {
      if (line.trim()) this.emit(event, line.trim());
    }
  }

  onExit(proc, code, signal) {
    if (this.process === proc) this.process = null;
    this.stopHealthChecks();
    if (this.stopping) {
      this.stopping = false;
      this.emit('exit', code, signal, { willRestart: false, stoppedByHub: true });
      return;
    }
    const willRestart = this.shouldRestart(code);
    if (!willRestart && this.restartTimes.length >= SERVICE_MAX_RESTARTS) {
      this.emit('error', new Error(`restart limit reached (${SERVICE_MAX_RESTARTS} in 5 minutes)`));
    }
    if (willRestart) {
      this.restarts += 1;
      this.restartTimes.push(Date.now());
      this.emit('restarting', { attempt: this.restarts });
      this.restartTimer = setTimeout(() => this.start(), SERVICE_RESTART_DELAY_MS);
      if (this.restartTimer.unref) this.restartTimer.unref();
    }
    this.emit('exit', code, signal, { willRestart, stoppedByHub: false });
  }

  shouldRestart(code) {
    const policy = this.config.restart || 'on-failure';
    if (SERVICE_RESTART_POLICIES.indexOf(policy) === -1) return false;
    if (policy === 'no') return false;
    if (policy === 'on-failure' && code === 0) return false;
    const cutoff = Date.now() - SERVICE_RESTART_WINDOW_MS;
    this.restartTimes = this.restartTimes.filter((at) => at > cutoff);
    return this.restartTimes.length < SERVICE_MAX_RESTARTS;
  }

  async stop() {
    this.stopping = true;
    this.clearRestartTimer();
    this.stopHealthChecks();
    const proc = this.process;
    if (!proc || proc.exitCode !== null) {
      this.process = null;
      this.health = { state: 'unknown', at: Date.now(), statusCode: null, error: null, latencyMs: null };
      return false;
    }
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve();
      };
      const killTimer = setTimeout(() => {
        signalProcess(proc, 'SIGKILL');
        setTimeout(done, 150);
      }, SERVICE_STOP_GRACE_MS);
      proc.once('exit', done);
      signalProcess(proc, 'SIGTERM');
    });
    this.process = null;
    this.health = { state: 'unknown', at: Date.now(), statusCode: null, error: null, latencyMs: null };
    return true;
  }

  status() {
    if (this.running) return 'running';
    return 'stopped';
  }

  scheduleHealthChecks() {
    this.stopHealthChecks();
    // A service without a port has no HTTP surface; process liveness is the health signal.
    if (!this.upstream) {
      this.health = { state: 'up', at: Date.now(), statusCode: null, error: null, latencyMs: null };
      return;
    }
    this.healthActive = true;
    let attempts = 0;
    const tick = () => {
      if (!this.healthActive) return; // stopped while a probe was in flight
      this.probeHealth().catch(() => {});
      const settled = this.health.state === 'up' || attempts >= SERVICE_STARTUP_PROBES;
      attempts += 1;
      this.healthTimer = setTimeout(tick, settled ? SERVICE_HEALTH_INTERVAL_MS : SERVICE_HEALTH_STARTUP_INTERVAL_MS);
      if (this.healthTimer.unref) this.healthTimer.unref();
    };
    tick();
  }

  stopHealthChecks() {
    this.healthActive = false;
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.healthTimer = null;
  }

  // Usage is only worth polling for a service that asked for it and is actually up.
  scheduleUsageChecks() {
    this.stopUsageChecks();
    if (!this.config.usagePath || !this.upstream) return;
    this.usageActive = true;
    const tick = () => {
      if (!this.usageActive) return;
      this.probeUsage().catch(() => {});
      this.usageTimer = setTimeout(tick, SERVICE_USAGE_INTERVAL_MS);
      if (this.usageTimer.unref) this.usageTimer.unref();
    };
    tick();
  }

  stopUsageChecks() {
    this.usageActive = false;
    if (this.usageTimer) clearTimeout(this.usageTimer);
    this.usageTimer = null;
  }

  async probeUsage() {
    if (!this.running || !this.config.usagePath || !this.upstream) return this.usage;
    const previous = this.usage;
    try {
      const response = await fetchJson(`${this.upstream}${this.config.usagePath}`, SERVICE_USAGE_TIMEOUT_MS);
      const usage = normalizeServiceUsage(response.body, Date.now());
      this.usage = usage;
      if (usage && JSON.stringify(usage.windows) !== JSON.stringify(previous && previous.windows)) {
        this.emit('usageChange', usage);
      }
    } catch (error) {
      // A missing or broken usage endpoint must never look like a broken service.
      if (!this.usage) this.usage = null;
      this.emit('usageError', error);
    }
    return this.usage;
  }

  clearRestartTimer() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  async probeHealth() {
    if (!this.running) {
      this.health = { state: 'down', at: Date.now(), statusCode: null, error: 'process is not running', latencyMs: null };
      return this.health;
    }
    if (!this.upstream) {
      this.health = { state: 'up', at: Date.now(), statusCode: null, error: null, latencyMs: null };
      return this.health;
    }
    const path = this.config.healthPath || '/healthz';
    const previous = this.health.state;
    const result = await httpProbe(`${this.upstream}${path}`, SERVICE_HEALTH_TIMEOUT_MS);
    this.health = result;
    this.emit('health', result);
    if (previous !== result.state) this.emit('healthChange', result);
    // The first usage poll may land before the service listens; keep trying until it answers.
    if (result.state === 'up' && this.config.usagePath && !this.usage) this.probeUsage().catch(() => {});
    return result;
  }

  destroy() {
    this.clearRestartTimer();
    this.stopHealthChecks();
    this.stopUsageChecks();
    signalProcess(this.process, 'SIGTERM');
    this.process = null;
  }
}

// --- Streamable HTTP session (own backend process per MCP session) ---
class HttpSession {
  constructor(serverId, config, headers = {}, options = {}) {
    // A resumed session keeps the id the client already cached (`options.sessionId`) instead of
    // handing out a new one it would ignore.
    this.id = options.sessionId || randomUUID();
    this.serverId = serverId;
    this.transport = 'streamable-http';
    this.createdAt = Date.now();
    this.lastActive = Date.now();
    this.initialized = false;
    // True when the hub spawned this process itself (client state was already lost), so the
    // handshake still has to be replayed before the next request is forwarded.
    this.resumed = Boolean(options.resumed);
    this.protocolVersion = null;
    this.clientInfo = null;
    this.proc = new StdioSession(serverId, config, { headers });
    this.getStreams = new Set(); // open GET SSE streams (server -> client)
    this.postStreams = new Map(); // streamId -> { res, remaining }
    this.requestStreams = new Map(); // JSON-RPC request id -> streamId
    this.eventSeq = 0;
    this.events = []; // ring buffer of GET stream events, used for Last-Event-ID replay
  }

  touch() {
    this.lastActive = Date.now();
  }

  nextEvent(payload) {
    this.eventSeq += 1;
    return { id: this.eventSeq, chunk: `id: ${this.eventSeq}\nevent: message\ndata: ${payload}\n\n` };
  }

  write(res, payload, buffer = false) {
    const { id, chunk } = this.nextEvent(payload);
    if (buffer) {
      this.events.push({ id, data: payload });
      if (this.events.length > EVENT_BUFFER_SIZE) this.events.shift();
    }
    try {
      return res.write(chunk);
    } catch {
      return false;
    }
  }

  // Server initiated requests/notifications go to every open server -> client stream.
  broadcast(payload) {
    for (const res of this.getStreams) this.write(res, payload, true);
    for (const stream of this.postStreams.values()) this.write(stream.res, payload);
  }

  openGetStream(res, lastEventId = null) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      ...CORS_HEADERS,
      [SESSION_ID_HEADER]: this.id
    });
    res.write(': connected\n\n');

    if (Number.isFinite(lastEventId)) {
      for (const event of this.events) {
        if (event.id > lastEventId) res.write(`id: ${event.id}\nevent: message\ndata: ${event.data}\n\n`);
      }
    }

    this.getStreams.add(res);
    this.touch();

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    if (heartbeat.unref) heartbeat.unref();
    const cleanup = () => {
      clearInterval(heartbeat);
      this.getStreams.delete(res);
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  registerPostStream(res, rpcIds) {
    res.on('error', () => {});
    const streamId = randomUUID();
    this.postStreams.set(streamId, { res, remaining: rpcIds.length });
    for (const id of rpcIds) this.requestStreams.set(String(id), streamId);
    return streamId;
  }

  // Route one JSON-RPC response to the POST stream that carried the request.
  deliver(rpcId, payload) {
    const key = String(rpcId);
    const streamId = this.requestStreams.get(key);
    if (streamId === undefined) return false;
    this.requestStreams.delete(key);

    const stream = this.postStreams.get(streamId);
    if (!stream) return false;
    this.write(stream.res, payload);
    stream.remaining -= 1;
    if (stream.remaining <= 0) {
      this.postStreams.delete(streamId);
      try {
        stream.res.end();
      } catch {}
    }
    return true;
  }

  destroy() {
    for (const res of this.getStreams) {
      try {
        res.end();
      } catch {}
    }
    this.getStreams.clear();
    for (const stream of this.postStreams.values()) {
      try {
        stream.res.end();
      } catch {}
    }
    this.postStreams.clear();
    this.requestStreams.clear();
    this.proc.destroy();
  }
}

// --- Hub Manager ---
class HubManager extends EventEmitter {
  constructor() {
    super();
    this.servers = new Map(); // id -> config
    this.sessions = new Map(); // sessionId -> StdioSession
    this.persistentSessions = new Map(); // serverId -> StdioSession (shared pool)
    this.services = new Map(); // serverId -> ServiceProcess (supervised launcher entries)
    this.httpSessions = new Map(); // sessionId -> HttpSession (Streamable HTTP)
    this.handshakes = new Map(); // sessionId -> { params, protocolVersion }, replayed on resume
    // Runtime copy of the env switch, so a running hub can be told to keep strict spec
    // behaviour (unknown session -> 404) without a restart.
    this.resumeSessions = RESUME_SESSION;
    this.logs = new Map(); // id -> string[]
    this.states = new Map(); // id -> { status, pid, startedAt, error }
    this.maxLogs = 500;
    this.loadConfig();

    // Clean up idle sessions every 2 minutes
    setInterval(() => {
      const now = Date.now();
      for (const [sid, sess] of this.sessions.entries()) {
        if (now - sess.lastActive > 15 * 60 * 1000) {
          sess.destroy();
          this.sessions.delete(sid);
        }
      }
      for (const [sid, sess] of this.httpSessions.entries()) {
        if (sess.getStreams.size === 0 && now - sess.lastActive > SESSION_IDLE_MS) {
          this.closeHttpSession(sid, 'expired after inactivity');
        }
      }
    }, 120000).unref();
  }

  loadConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
        const list = JSON.parse(raw);
        for (const raw of list) {
          // Normalise once here so the rest of the hub only deals with booleans/clear kinds,
          // and an entry written before these fields existed keeps working unchanged.
          const item = normalizeServerConfig(raw);
          this.servers.set(item.id, item);
          if (!this.logs.has(item.id)) this.logs.set(item.id, []);
          if (!this.states.has(item.id)) {
            this.states.set(item.id, {
              status: item.enabled ? 'stopped' : 'disabled',
              startedAt: null,
              error: null
            });
          }
        }
      }
    } catch (e) {
      console.error('[Hub] Failed to load servers.json:', e);
    }
  }

  saveConfig() {
    try {
      const list = Array.from(this.servers.values());
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(list, null, 2), 'utf-8');
    } catch (e) {
      console.error('[Hub] Failed to save servers.json:', e);
    }
  }

  addLog(id, text, stream = 'stdout') {
    const logs = this.logs.get(id) || [];
    const timestamp = new Date().toISOString().substring(11, 19);
    const entry = { time: timestamp, stream, text };
    logs.push(entry);
    if (logs.length > this.maxLogs) logs.shift();
    this.logs.set(id, logs);
    this.emit(`log:${id}`, entry);
  }

  getPersistentSession(serverId, headers = {}) {
    const srv = this.servers.get(serverId);
    if (!srv) throw new Error(`Server ${serverId} not found`);

    let sess = this.persistentSessions.get(serverId);
    if (!sess || !sess.process || sess.process.exitCode !== null) {
      sess = new StdioSession(serverId, srv, { headers });
      this.attachSessionLogging(serverId, sess);
      this.persistentSessions.set(serverId, sess);
      this.states.set(serverId, {
        status: 'running',
        pid: sess.process?.pid,
        startedAt: Date.now(),
        error: null
      });
      this.emit('change', { id: serverId, state: this.states.get(serverId) });
    }
    return sess;
  }

  createClientSession(serverId, headers = {}) {
    const srv = this.servers.get(serverId);
    if (!srv) throw new Error(`Server ${serverId} not found`);

    const sess = new StdioSession(serverId, srv, { headers });
    this.sessions.set(sess.id, sess);
    this.attachSessionLogging(serverId, sess);
    return sess;
  }

  attachSessionLogging(serverId, sess) {
    sess.on('rawStdout', (text) => this.addLog(serverId, text, 'stdout'));
    sess.on('stderr', (text) => this.addLog(serverId, text, 'stderr'));
    sess.on('message', (msg, raw) => {
      // Log tool calls and interesting methods
      if (msg.method) {
        this.addLog(serverId, `[RPC] ${msg.method} (${redactForLog(msg.params || {}).slice(0, 80)})`, 'system');
      }
    });
    sess.on('exit', (code) => {
      this.addLog(serverId, `[Hub] Session process exited with code ${code}`, 'system');
      // Only the shared persistent process owns the server state shown in the dashboard.
      if (this.persistentSessions.get(serverId) !== sess) return;
      const cur = this.states.get(serverId);
      if (cur && cur.status === 'running') {
        this.states.set(serverId, { ...cur, status: code === 0 ? 'stopped' : 'error', error: code ? `Exited with code ${code}` : null });
        this.emit('change', { id: serverId, state: this.states.get(serverId) });
      }
    });
  }

  createHttpSession(serverId, headers = {}, options = {}) {
    const srv = this.servers.get(serverId);
    if (!srv) throw new Error(`Server ${serverId} not found`);
    if (this.httpSessions.size >= MAX_HTTP_SESSIONS) {
      const error = new Error(`Too many active MCP sessions (max ${MAX_HTTP_SESSIONS})`);
      error.statusCode = 503;
      throw error;
    }

    // Reusing an id (resume path) must not leave the previous process running unnoticed.
    if (options.sessionId && this.httpSessions.has(options.sessionId)) {
      this.closeHttpSession(options.sessionId, 'replaced while resuming');
    }

    const session = new HttpSession(serverId, srv, headers, options);
    this.httpSessions.set(session.id, session);
    this.attachSessionLogging(serverId, session.proc);

    // Forward everything the server initiates (requests like sampling/elicitation and
    // notifications such as progress) onto the session's SSE streams.
    session.proc.on('message', (msg, raw) => {
      if (msg && msg.method !== undefined) session.broadcast(raw === undefined ? JSON.stringify(msg) : raw);
    });

    this.addLog(serverId, `[Hub] Streamable HTTP session ${session.id.slice(0, 8)} opened`, 'system');
    return session;
  }

  getHttpSession(sessionId) {
    return this.httpSessions.get(sessionId) || null;
  }

  closeHttpSession(sessionId, reason = 'closed') {
    const session = this.httpSessions.get(sessionId);
    if (!session) return false;
    this.httpSessions.delete(sessionId);
    session.destroy();
    this.addLog(session.serverId, `[Hub] Streamable HTTP session ${sessionId.slice(0, 8)} ${reason}`, 'system');
    this.emit('change', { id: session.serverId, state: this.states.get(session.serverId) });
    return true;
  }

  closeServerSessions(serverId) {
    for (const [sessionId, session] of this.httpSessions.entries()) {
      if (session.serverId === serverId) this.closeHttpSession(sessionId, 'closed with the server');
    }
  }

  // --- Session resume ---
  // Remembered initialize handshakes: a resumed session replays the handshake the client did
  // earlier, so a backend that pins a protocol version (or the client capabilities) keeps
  // behaving the same even though the process that answered it is gone.
  rememberHandshake(sessionId, params, protocolVersion = null) {
    if (!sessionId) return;
    // Dropping the adapter header snapshot attachRequestHeaders() adds is deliberate: it holds
    // the credentials of the request that ran the handshake, while a resume has to authenticate
    // with the headers of the request that triggers it.
    const clean = params && typeof params === 'object' ? { ...params } : null;
    if (clean) delete clean._meta;
    this.handshakes.delete(sessionId);
    this.handshakes.set(sessionId, { params: clean, protocolVersion: protocolVersion || null });
    while (this.handshakes.size > HANDSHAKE_CACHE_SIZE) {
      this.handshakes.delete(this.handshakes.keys().next().value);
    }
  }

  getHandshake(sessionId) {
    return this.handshakes.get(sessionId) || null;
  }

  // Bring an Mcp-Session-Id the client still uses back to life under that very id. Credentials
  // arrive with every request (headers), so a new backend process is enough; sessions whose
  // process died are replaced instead of left dangling.
  resumeHttpSession(serverId, sessionId, headers = {}) {
    let session = this.httpSessions.get(sessionId) || null;
    if (session && (session.serverId !== serverId || !session.proc.process)) {
      this.closeHttpSession(
        sessionId,
        session.serverId === serverId ? 'backend process gone, starting a new one' : 'moved to another server'
      );
      session = null;
    }
    if (!session) {
      session = this.createHttpSession(serverId, headers, { sessionId, resumed: true });
      this.addLog(serverId, `[Hub] Streamable HTTP session ${sessionId.slice(0, 8)} was gone, resumed under the same id`, 'system');
    }
    return session;
  }

  // --- Launcher (service) side ---
  isService(serverId) {
    return isServiceConfig(this.servers.get(serverId));
  }

  ensureService(serverId) {
    const srv = this.assertStartable(serverId);
    let service = this.services.get(serverId);
    if (!service) {
      service = new ServiceProcess(serverId, srv);
      this.attachServiceLogging(serverId, service);
      this.services.set(serverId, service);
      return service;
    }
    // A config edit must not orphan the running process: the same supervisor takes the new
    // config, so the next (re)start uses it instead of a second process appearing next to it.
    service.config = srv;
    if (!srv.usagePath || !srv.port) service.stopUsageChecks();
    else if (service.running && !service.usageActive) service.scheduleUsageChecks();
    return service;
  }

  attachServiceLogging(serverId, service) {
    service.on('rawStdout', (text) => this.addLog(serverId, text, 'stdout'));
    service.on('stderr', (text) => this.addLog(serverId, text, 'stderr'));
    service.on('started', ({ pid }) => {
      this.states.set(serverId, { status: 'running', pid, startedAt: Date.now(), error: null });
      this.addLog(serverId, `[Hub] Service started (PID ${pid})`, 'system');
      this.emit('change', { id: serverId, state: this.states.get(serverId) });
    });
    service.on('restarting', ({ attempt }) => {
      this.addLog(serverId, `[Hub] Service exited, restarting (${attempt}/${SERVICE_MAX_RESTARTS})`, 'system');
    });
    service.on('usageChange', (usage) => {
      if (!usage) return;
      const summary = usage.windows.map((window) => `${window.label} ${Math.round(window.remainingPercent)}% left`).join(', ');
      this.addLog(serverId, `[Hub] Usage: ${summary}`, 'system');
      this.emit('change', { id: serverId, state: this.states.get(serverId) });
    });
    service.on('usageError', (error) => {
      this.addLog(serverId, `[Hub] Usage endpoint unavailable: ${error.message}`, 'system');
    });
    service.on('healthChange', (health) => {
      this.addLog(serverId, `[Hub] Health ${health.state}${health.statusCode ? ` (HTTP ${health.statusCode})` : ''}${health.error ? `: ${health.error}` : ''}`, 'system');
      this.emit('change', { id: serverId, state: this.states.get(serverId) });
    });
    service.on('exit', (code, signal, info = {}) => {
      this.addLog(serverId, `[Hub] Service exited with code ${code}${signal ? ` (${signal})` : ''}`, 'system');
      if (this.services.get(serverId) !== service) return;
      if (info.willRestart) {
        this.states.set(serverId, {
          status: 'starting',
          pid: null,
          startedAt: null,
          error: `Exited with code ${code}, restarting`
        });
      } else {
        const clean = info.stoppedByHub || code === 0;
        this.states.set(serverId, {
          status: clean ? 'stopped' : 'error',
          pid: null,
          startedAt: null,
          error: clean ? null : `Exited with code ${code}`
        });
      }
      this.emit('change', { id: serverId, state: this.states.get(serverId) });
    });
    service.on('error', (error) => {
      this.addLog(serverId, `[Hub] ${error.message}`, 'system');
    });
  }

  async startService(serverId) {
    this.assertStartable(serverId);
    const service = this.ensureService(serverId);
    if (service.running) return { id: serverId, started: false, pid: service.process?.pid ?? null };
    this.addLog(serverId, `[Hub] Starting service ${serverId}...`, 'system');
    service.start();
    return { id: serverId, started: true, pid: service.process?.pid ?? null };
  }

  // Fire and forget: the dashboard should flip to "stopped" right away, the signal is on its
  // way. Callers that must wait (restart) use the service object directly.
  stopService(serverId) {
    const service = this.services.get(serverId);
    if (service) service.stop().catch(() => {});
    this.states.set(serverId, { status: 'stopped', pid: null, startedAt: null, error: null });
    this.addLog(serverId, '[Hub] Service stopped', 'system');
    this.emit('change', { id: serverId, state: this.states.get(serverId) });
    return { success: true };
  }

  async restartService(serverId) {
    this.assertStartable(serverId);
    const service = this.ensureService(serverId);
    this.addLog(serverId, `[Hub] Restarting service ${serverId}...`, 'system');
    await service.stop();
    service.restarts = 0;
    service.restartTimes = [];
    service.start();
    return { id: serverId, started: true, pid: service.process?.pid ?? null };
  }

  async probeServerUsage(serverId) {
    const srv = this.servers.get(serverId);
    if (!srv) throw Object.assign(new Error(`Server ${serverId} not found`), { statusCode: 404 });
    if (!isServiceConfig(srv) || !srv.usagePath) {
      return { usage: null, error: 'no usage endpoint configured for this entry' };
    }
    const service = this.services.get(serverId);
    if (!service) return { usage: null, error: 'service has not been started by the hub' };
    const usage = await service.probeUsage();
    return { usage, error: usage ? null : 'usage endpoint did not report any windows' };
  }

  async probeServerHealth(serverId) {
    const srv = this.servers.get(serverId);
    if (!srv) throw Object.assign(new Error(`Server ${serverId} not found`), { statusCode: 404 });
    if (!isServiceConfig(srv)) return { state: 'unknown', at: Date.now(), error: 'not a service entry' };
    const service = this.services.get(serverId);
    if (!service) {
      return { state: 'down', at: Date.now(), statusCode: null, latencyMs: null, error: 'service has not been started by the hub' };
    }
    return service.probeHealth();
  }

  async restartServer(serverId) {
    if (this.isService(serverId)) return this.restartService(serverId);
    this.assertStartable(serverId);
    this.closeServerSessions(serverId);
    const sess = this.persistentSessions.get(serverId);
    if (sess) {
      sess.destroy();
      this.persistentSessions.delete(serverId);
    }
    this.addLog(serverId, `[Hub] Restarting ${serverId}...`, 'system');
    await new Promise((r) => setTimeout(r, 400));
    return this.getPersistentSession(serverId);
  }

  // A disabled server is deliberately parked, so both the dashboard and the REST API must
  // refuse to start it until someone enables it again.
  assertStartable(serverId) {
    const srv = this.servers.get(serverId);
    if (!srv) throw Object.assign(new Error(`Server ${serverId} not found`), { statusCode: 404 });
    if (!srv.enabled) {
      throw Object.assign(new Error(`Server ${serverId} is disabled, enable it before starting`), {
        statusCode: 409
      });
    }
    return srv;
  }

  // Starts a server that is not running and leaves a running one alone. The dashboard's
  // "start all" uses this, so it does not bounce servers that are already up.
  async startServer(serverId) {
    if (this.isService(serverId)) return this.startService(serverId);
    this.assertStartable(serverId);
    const sess = this.persistentSessions.get(serverId);
    if (sess && sess.process && sess.process.exitCode === null) {
      return { id: serverId, started: false, pid: sess.process.pid ?? null };
    }
    this.addLog(serverId, `[Hub] Starting ${serverId}...`, 'system');
    const started = this.getPersistentSession(serverId);
    return { id: serverId, started: true, pid: started?.process?.pid ?? null };
  }

  stopServer(serverId) {
    if (this.isService(serverId)) return this.stopService(serverId);
    this.closeServerSessions(serverId);
    const sess = this.persistentSessions.get(serverId);
    if (sess) {
      sess.destroy();
      this.persistentSessions.delete(serverId);
    }
    this.states.set(serverId, { status: 'stopped', pid: null, startedAt: null, error: null });
    this.addLog(serverId, `[Hub] Server stopped`, 'system');
    this.emit('change', { id: serverId, state: this.states.get(serverId) });
    return { success: true };
  }

  getAllStatus() {
    const list = [];
    for (const [id, config] of this.servers.entries()) {
      const state = this.states.get(id) || { status: 'stopped' };
      const service = this.services.get(id) || null;
      const kind = isServiceConfig(config) ? 'service' : 'mcp';
      const httpSessions = Array.from(this.httpSessions.values()).filter((s) => s.serverId === id);
      const sseSessions = Array.from(this.sessions.values()).filter((s) => s.serverId === id);
      const liveSession = kind === 'service'
        ? service
        : (this.persistentSessions.get(id)?.process || httpSessions[0]?.proc || sseSessions[0]);
      // A service that was just asked to stop counts as stopped right away, even while SIGTERM
      // is still travelling, so the dashboard flips instantly instead of after the grace period.
      const serviceAlive = Boolean(service && service.running && !service.stopping);
      const livePid = kind === 'service'
        ? (serviceAlive ? service.process?.pid ?? null : null)
        : (this.persistentSessions.get(id)?.process?.pid || liveSession?.process?.pid || null);
      // A disabled server is parked on purpose: warm up skips it and it refuses to start, so
      // it must not be shown as running even while an old process is still winding down.
      const alive = kind === 'service' ? serviceAlive : Boolean(liveSession && liveSession.process);
      // A service only runs while the hub supervises it, so without a service object the entry
      // is stopped no matter what the last state was (for example before a kind change).
      const idle = kind === 'service' && !service ? 'stopped' : state.status;
      const status = !config.enabled ? 'disabled' : alive ? 'running' : idle;
      // /api/servers is unauthenticated, so credential looking env values are masked. The
      // hub itself keeps using the real ones; only the API response is redacted.
      list.push({
        ...config,
        kind,
        env: redactEnv(config.env),
        status,
        pid: config.enabled ? livePid : null,
        startedAt: state.startedAt,
        uptime: state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : 0,
        activeClientSessions: sseSessions.length,
        activeHttpSessions: httpSessions.length,
        transports: kind === 'service'
          ? (config.proxy ? ['process', 'http-proxy'] : ['process'])
          : ['stdio', 'streamable-http', 'sse'],
        // Launcher metadata: where it really listens, the optional hub mirror, how it feels.
        // The address is known from the config even while the process is down.
        upstream: kind === 'service' && config.port
          ? (service?.upstream || `http://${config.host || '127.0.0.1'}:${config.port}`)
          : null,
        proxyPath: kind === 'service' && config.proxy ? `/apps/${id}/` : null,
        health: kind === 'service' ? (service?.health || { state: 'unknown', at: null, error: null }) : null,
        usage: kind === 'service' ? (service?.usage || null) : null,
        restarts: kind === 'service' ? (service?.restarts || 0) : null
      });
    }
    return list;
  }

  addOrUpdateServer(config) {
    const id = config.id || config.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const existing = this.servers.get(id);
    // The kind and both switches are tri-state on the wire: absent means "keep what it was"
    // for an existing entry and "mcp"/"on" for a new one, so a client that does not send them
    // cannot accidentally flip a server's kind, disable it or turn its autostart off.
    const normalized = normalizeServerConfig({ ...config, id }, existing);
    // Changing the kind redefines the entry, so whatever runs for it must go first.
    if (existing && (existing.kind === 'service') !== (normalized.kind === 'service')) {
      this.closeServerSessions(id);
      const oldSession = this.persistentSessions.get(id);
      if (oldSession) {
        oldSession.destroy();
        this.persistentSessions.delete(id);
      }
      const oldService = this.services.get(id);
      if (oldService) {
        oldService.stop().catch(() => {});
        this.services.delete(id);
      }
      this.states.set(id, { status: 'stopped', pid: null, startedAt: null, error: null });
    }
    this.servers.set(id, normalized);
    config = normalized;
    if (!this.logs.has(config.id)) this.logs.set(config.id, []);
    // Disabling a server means stopping it, not just hiding its start button.
    if (!config.enabled) this.stopServer(config.id);
    this.saveConfig();
    this.emit('configChange');
    return config;
  }

  removeServer(id) {
    this.stopServer(id);
    const service = this.services.get(id);
    if (service) {
      service.destroy();
      this.services.delete(id);
    }
    this.servers.delete(id);
    this.logs.delete(id);
    this.states.delete(id);
    this.saveConfig();
    this.emit('configChange');
    return { success: true };
  }
}

const manager = new HubManager();

// --- HTTP Helpers ---
function sendJson(res, statusCode, data, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...CORS_HEADERS,
    ...extraHeaders
  });
  res.end(JSON.stringify(data));
}

function sendEmpty(res, statusCode, extraHeaders = {}) {
  res.writeHead(statusCode, { ...CORS_HEADERS, ...extraHeaders });
  res.end();
}

function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error };
}

function parseAccept(header) {
  const raw = String(header || '').toLowerCase();
  const missing = raw.trim() === '';
  return {
    raw,
    json: missing || raw.includes('application/json') || raw.includes('*/*'),
    sse: raw.includes('text/event-stream'),
    html: raw.includes('text/html')
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) {
        const error = new Error('Payload too large');
        error.statusCode = 413;
        reject(error);
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve(null);
      try {
        resolve(JSON.parse(body));
      } catch {
        const error = new Error('Request body is not valid JSON');
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

// MCP security guidance: validate Origin to block DNS rebinding attacks and optionally
// require a bearer token (MCP_HUB_TOKEN). Only /mcps/* is protected, the dashboard is not.
function authorizeMcpRequest(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    let originHost = null;
    try {
      originHost = new URL(origin).hostname;
    } catch {
      sendJson(res, 403, { error: 'Invalid Origin header' });
      return false;
    }
    const requestHost = String(req.headers.host || '').split(':')[0];
    const allowed = originHost === requestHost || ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes(originHost);
    if (!allowed) {
      sendJson(res, 403, { error: `Origin '${origin}' is not allowed` });
      return false;
    }
  }

  if (AUTH_TOKEN) {
    const given = Buffer.from(String(req.headers.authorization || ''));
    const expected = Buffer.from(`Bearer ${AUTH_TOKEN}`);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      sendJson(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      return false;
    }
  }

  return true;
}

function serverUrls(req, serverId) {
  const base = `http://${req.headers.host || `127.0.0.1:${PORT}`}`;
  return {
    streamableHttp: `${base}/mcps/${serverId}/mcp`,
    sse: `${base}/mcps/${serverId}/sse`,
    messages: `${base}/mcps/${serverId}/messages`,
    health: `${base}/mcps/${serverId}/health`
  };
}

function sendInfoPage(res, req, srv, serverId) {
  const urls = serverUrls(req, serverId);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS });
  res.end(`
    <html><head><meta charset="utf-8"><title>${srv.name} - MCP Endpoint</title>
    <body style="font-family: sans-serif; padding: 30px; background: #0b1120; color: #f1f5f9;">
      <h2>${srv.icon || '⚡'} ${srv.name}</h2>
      <p>${srv.description || ''}</p>
      <hr style="border-color: #334155; margin: 20px 0;">
      <p>Aggregated MCP endpoint hosted on the hub port ${PORT}:</p>
      <ul>
        <li><b>Streamable HTTP (recommended):</b> <code>${urls.streamableHttp}</code></li>
        <li><b>Legacy HTTP+SSE:</b> <code>${urls.sse}</code></li>
        <li><b>Health check:</b> <code>${urls.health}</code></li>
      </ul>
      <p>Supported protocol versions: <code>${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}</code></p>
      <p><a href="/" style="color: #38bdf8;">← Back to MCP Hub Dashboard</a></p>
    </body></html>
  `);
}

// --- Launcher: reverse proxy for service entries ---

// Streaming friendly: the response body is piped, never buffered, so SSE and chunked
// endpoints (for example a streaming chat completion) keep flowing through the hub port.
function proxyToService(req, res, srv, restPath, search) {
  const host = srv.host || '127.0.0.1';
  const port = Number.parseInt(srv.port, 10) || 0;
  if (!port) {
    return sendJson(res, 502, { error: `Service '${srv.id}' has no port configured, nothing to proxy to` });
  }

  const basePath = restPath && restPath.length ? restPath : '/';
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'host') continue;
    headers[key] = value;
  }
  const forwardedFor = headers['x-forwarded-for'];
  headers['x-forwarded-for'] = forwardedFor ? `${forwardedFor}, ${req.socket.remoteAddress || 'unknown'}` : (req.socket.remoteAddress || 'unknown');
  headers['x-forwarded-host'] = req.headers.host || '';
  headers['x-forwarded-proto'] = 'http';
  headers.host = `${host}:${port}`;

  const proxyReq = http.request(
    { host, port, method: req.method, path: `${basePath}${search || ''}`, headers },
    (proxyRes) => {
      const outHeaders = {};
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) outHeaders[key] = value;
      }
      res.writeHead(proxyRes.statusCode || 502, outHeaders);
      proxyRes.pipe(res);
      proxyRes.on('error', () => res.destroy());
    }
  );

  proxyReq.on('error', (error) => {
    const message = `Service '${srv.id}' is not reachable at ${srv.host || '127.0.0.1'}:${port}: ${error.message}`;
    if (res.headersSent) res.destroy();
    else sendJson(res, 502, { error: message });
  });

  req.on('aborted', () => proxyReq.destroy());
  req.pipe(proxyReq);
}

function sendServicePage(res, req, srv, service) {
  const origin = `http://${req.headers.host || `127.0.0.1:${PORT}`}`;
  const upstream = service?.upstream || (srv.port ? `http://${srv.host || '127.0.0.1'}:${srv.port}` : '—');
  const health = service?.health || { state: 'unknown' };
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS });
  res.end(`
    <html><head><meta charset="utf-8"><title>${srv.name} - Service</title>
    <body style="font-family: sans-serif; padding: 30px; background: #0b1120; color: #f1f5f9;">
      <h2>${srv.name}</h2>
      <p>${srv.description || ''}</p>
      <hr style="border-color: #334155; margin: 20px 0;">
      <p>Proxied on the hub port ${PORT}:</p>
      <ul>
        <li><b>Base URL:</b> <code>${origin}/apps/${srv.id}/</code></li>
        <li><b>Upstream:</b> <code>${upstream}</code></li>
        <li><b>Health:</b> <code>${health.state}</code>${health.error ? ` — ${health.error}` : ''}</li>
      </ul>
      <p>Everything after <code>/apps/${srv.id}</code> is forwarded to the upstream unchanged.</p>
      <p><a href="/" style="color: #38bdf8;">← Back to the hub dashboard</a></p>
    </body></html>
  `);
}

// --- Legacy HTTP+SSE transport (protocol 2024-11-05) ---
function handleLegacySse(req, res, serverId) {
  const clientSession = manager.createClientSession(serverId, req.headers);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    ...CORS_HEADERS
  });

  // Send initial endpoint message per MCP SSE specification
  const endpointUrl = `/mcps/${serverId}/messages?sessionId=${clientSession.id}`;
  res.write(`event: endpoint\ndata: ${endpointUrl}\n\n`);

  const onMessage = (msg, raw) => {
    res.write(`event: message\ndata: ${raw}\n\n`);
  };
  clientSession.on('message', onMessage);

  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 20000);
  if (heartbeat.unref) heartbeat.unref();

  req.on('close', () => {
    clearInterval(heartbeat);
    clientSession.removeListener('message', onMessage);
    clientSession.destroy();
    manager.sessions.delete(clientSession.id);
  });
}

async function handleLegacyMessages(req, res, serverId, parsedUrl) {
  const sessionId = parsedUrl.searchParams.get('sessionId');
  const session = sessionId ? manager.sessions.get(sessionId) : null;
  if (!session) return sendJson(res, 404, { error: 'Unknown or expired SSE session' });

  const body = await parseBody(req);
  const forwarded = attachRequestHeaders(Array.isArray(body) ? body : [body], req.headers, manager.servers.get(serverId));
  for (const message of forwarded) session.send(message);
  res.writeHead(202, CORS_HEADERS);
  res.end();
}

// --- Streamable HTTP transport (MCP 2025-03-26 ... 2025-11-25) ---

function sseStreamHeaders(session) {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    ...CORS_HEADERS,
    ...(session ? { [SESSION_ID_HEADER]: session.id } : {})
  };
}

// Per spec an unsupported MCP-Protocol-Version MUST be answered with 400 Bad Request.
// A missing header falls back to 2025-03-26 semantics, which is fully backwards compatible.
function checkProtocolVersionHeader(req, res) {
  const header = req.headers[PROTOCOL_VERSION_HEADER];
  if (header === undefined) return true;
  const requested = String(header).trim();
  if (SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) return true;
  sendJson(res, 400, jsonRpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${requested}`, {
    supported: SUPPORTED_PROTOCOL_VERSIONS
  }), { 'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION });
  return false;
}

// A resumed session owns a brand new backend process, so the handshake the client did earlier
// has to be replayed for it. The stored initialize is used when the hub has seen it (same
// protocol version and client capabilities as before), the request's own MCP-Protocol-Version
// header otherwise, and the hub defaults as the last resort.
async function replayResumedHandshake(session, headers) {
  const remembered = manager.getHandshake(session.id);
  const headerVersion = String(headers[PROTOCOL_VERSION_HEADER] ?? '').trim();
  const protocolVersion = (remembered && remembered.protocolVersion)
    || (SUPPORTED_PROTOCOL_VERSIONS.includes(headerVersion) ? headerVersion : LATEST_PROTOCOL_VERSION);

  const result = await session.proc.ensureInitialized(protocolVersion, remembered ? remembered.params : null);
  session.initialized = true;
  session.protocolVersion = (result && result.protocolVersion) || protocolVersion;
  session.clientInfo = (remembered && remembered.params && remembered.params.clientInfo) || null;
  manager.rememberHandshake(session.id, remembered ? remembered.params : null, session.protocolVersion);
  manager.addLog(
    session.serverId,
    `[Hub] Session ${session.id.slice(0, 8)} resumed with a new backend process (protocol ${session.protocolVersion})`,
    'system'
  );
  return session;
}

const SECRET_ENV_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|CREDENTIAL)/i;

function redactEnv(env) {
  if (!env || typeof env !== 'object') return env;
  const masked = {};
  for (const [key, value] of Object.entries(env)) {
    masked[key] = SECRET_ENV_PATTERN.test(key) ? '***' : value;
  }
  return masked;
}

// Adapter helpers -----------------------------------------------------------

function serverUsesAdapter(srv) {
  return Boolean(srv && srv.adapter);
}

// Attach the client's headers to every request the hub forwards, so an adapter always sees
// the newest credential of the request it is answering, not just the one of the session's
// initialize call. Non adapter servers get the messages untouched.
function attachRequestHeaders(messages, headers, srv) {
  if (!serverUsesAdapter(srv)) return messages;
  const snapshot = headers && typeof headers === 'object' ? { ...headers } : {};
  return messages.map((message) => {
    if (!message || typeof message !== 'object' || message.method === undefined) return message;
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    const meta = params._meta && typeof params._meta === 'object' ? params._meta : {};
    return { ...message, params: { ...params, _meta: { ...meta, [REQUEST_HEADERS_META]: snapshot } } };
  });
}

// Drop the header snapshot from a reply, so it can never travel back to the client.
function stripRequestHeaders(message) {
  if (!message || typeof message !== 'object') return message;
  const cleaned = { ...message };
  for (const key of ['params', 'result']) {
    const holder = cleaned[key];
    if (!holder || typeof holder !== 'object' || !holder._meta || typeof holder._meta !== 'object') continue;
    if (!(REQUEST_HEADERS_META in holder._meta)) continue;
    const meta = { ...holder._meta };
    delete meta[REQUEST_HEADERS_META];
    cleaned[key] = { ...holder, _meta: meta };
  }
  return cleaned;
}

// Headers may carry credentials, so they never make it into the dashboard log.
function redactForLog(value) {
  return JSON.stringify(value, (key, item) => (key === REQUEST_HEADERS_META ? undefined : item));
}

async function handleStreamablePost(req, res, serverId) {
  if (!checkProtocolVersionHeader(req, res)) return;

  const accept = parseAccept(req.headers.accept);
  if (!accept.json && !accept.sse) {
    return sendJson(res, 406, jsonRpcError(null, -32000, 'Accept header must include application/json and/or text/event-stream'));
  }
  // The spec lets the server choose JSON or SSE; JSON is used unless the client cannot take it.
  const useSse = !accept.json;

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, error.statusCode || 400, jsonRpcError(null, error.statusCode === 413 ? -32000 : -32700, error.message));
  }
  if (payload === null) return sendJson(res, 400, jsonRpcError(null, -32600, 'Request body is required'));

  const messages = Array.isArray(payload) ? payload : [payload];
  if (!messages.length || messages.some((message) => !message || typeof message !== 'object' || Array.isArray(message))) {
    return sendJson(res, 400, jsonRpcError(null, -32600, 'Body must be a JSON-RPC message or a batch of messages'));
  }

  let session = null;
  let proc = null;
  const sessionIdHeader = req.headers[SESSION_ID_HEADER];
  const hasInitialize = messages.some((message) => message.method === 'initialize');

  if (sessionIdHeader !== undefined) {
    const requestedId = String(sessionIdHeader);
    session = manager.getHttpSession(requestedId);
    // A session whose backend process died is as gone as an expired one, so both take the
    // resume path instead of failing every later request.
    if (session && (session.serverId !== serverId || !session.proc.process)) session = null;
    if (!session) {
      if (!manager.resumeSessions) {
        return sendJson(res, 404, jsonRpcError(null, -32001, 'Session not found; send a new initialize request'));
      }
      try {
        session = manager.resumeHttpSession(serverId, requestedId, req.headers);
      } catch (error) {
        return sendJson(res, error.statusCode || 500, jsonRpcError(null, -32603, error.message));
      }
    }
    proc = session.proc;
  } else if (hasInitialize) {
    try {
      session = manager.createHttpSession(serverId, req.headers);
    } catch (error) {
      return sendJson(res, error.statusCode || 500, jsonRpcError(null, -32603, error.message));
    }
    proc = session.proc;
  } else if (STATELESS_FALLBACK) {
    // Backwards compatible behaviour of this hub: serve requests that carry no session id
    // on the shared warm process (this is also what stateless clients rely on).
    proc = manager.getPersistentSession(serverId, req.headers);
    try {
      await proc.ensureInitialized();
    } catch (error) {
      manager.addLog(serverId, `[Hub] initialize handshake failed: ${error.message}`, 'system');
    }
  } else {
    return sendJson(res, 400, jsonRpcError(null, -32600, 'Mcp-Session-Id header is required; send an initialize request first'));
  }

  if (session) session.touch();
  // The client's own initialize (if this POST is one) also serves as the handshake of a
  // resumed session; anything else needs the handshake replayed before it is forwarded.
  if (session && session.resumed && !session.initialized && !hasInitialize) {
    try {
      await replayResumedHandshake(session, req.headers);
    } catch (error) {
      manager.closeHttpSession(session.id, 'could not be resumed');
      return sendJson(res, 500, jsonRpcError(null, -32603, `Session ${session.id} expired and could not be resumed: ${error.message}`));
    }
  }
  const sessionHeaders = session ? { [SESSION_ID_HEADER]: session.id } : {};
  const forwarded = attachRequestHeaders(messages, req.headers, manager.servers.get(serverId));
  const requests = forwarded.filter((message) => message.method !== undefined && message.id !== undefined);
  const others = forwarded.filter((message) => message.method === undefined || message.id === undefined);

  // Notifications and client responses to server requests: fire and forget, 202 Accepted.
  for (const message of others) proc.send(message);
  if (requests.length === 0) return sendEmpty(res, 202, sessionHeaders);

  if (useSse) {
    res.writeHead(200, sseStreamHeaders(session));
    res.write(': connected\n\n');
  }
  if (useSse && session) session.registerPostStream(res, requests.map((message) => message.id));

  const results = await Promise.all(requests.map(async (message) => {
    try {
      const response = await proc.sendRequest(message, REQUEST_TIMEOUT_MS);
      return stripRequestHeaders(response) || jsonRpcError(message.id, -32603, 'Empty response from MCP server');
    } catch (error) {
      return jsonRpcError(message.id, -32000, error.message);
    }
  }));

  results.forEach((result, index) => {
    const request = requests[index];
    if (session && request.method === 'initialize' && result && result.result) {
      session.initialized = true;
      session.protocolVersion = result.result.protocolVersion || null;
      session.clientInfo = (request.params && request.params.clientInfo) || null;
      session.resumed = false;
      manager.rememberHandshake(session.id, request.params || null, session.protocolVersion);
      manager.addLog(serverId, `[Hub] Session ${session.id.slice(0, 8)} initialized (protocol ${session.protocolVersion})`, 'system');
    }
  });

  if (useSse) {
    results.forEach((result, index) => {
      const serialized = JSON.stringify(result);
      if (session) session.deliver(requests[index].id, serialized);
      else res.write(`event: message\ndata: ${serialized}\n\n`);
    });
    if (!session) res.end();
    return;
  }

  return sendJson(res, 200, Array.isArray(payload) ? results : results[0], sessionHeaders);
}

function handleStreamableGet(req, res, serverId, srv) {
  const accept = parseAccept(req.headers.accept);
  if (!accept.sse) {
    if (accept.html) return sendInfoPage(res, req, srv, serverId);
    return sendJson(res, 406, jsonRpcError(null, -32000, 'GET requires an Accept header including text/event-stream'));
  }

  const sessionIdHeader = req.headers[SESSION_ID_HEADER];
  if (sessionIdHeader === undefined) {
    return sendJson(res, 400, jsonRpcError(null, -32000, 'Mcp-Session-Id header is required for GET'));
  }

  const requestedId = String(sessionIdHeader);
  let session = manager.getHttpSession(requestedId);
  if (session && (session.serverId !== serverId || !session.proc.process)) session = null;
  if (!session) {
    if (!manager.resumeSessions) {
      return sendJson(res, 404, jsonRpcError(null, -32001, 'Session not found; send a new initialize request'));
    }
    try {
      // The stream is what notifications travel on, so it is reopened on a fresh backend
      // process; the handshake is replayed with the next request that needs one.
      session = manager.resumeHttpSession(serverId, requestedId, req.headers);
    } catch (error) {
      return sendJson(res, error.statusCode || 500, jsonRpcError(null, -32603, error.message));
    }
  }

  const lastEventId = Number.parseInt(String(req.headers['last-event-id'] ?? ''), 10);
  session.openGetStream(res, Number.isFinite(lastEventId) ? lastEventId : null);
}

function handleStreamableDelete(req, res, serverId) {
  const sessionIdHeader = req.headers[SESSION_ID_HEADER];
  if (sessionIdHeader === undefined) {
    return sendJson(res, 400, jsonRpcError(null, -32000, 'Mcp-Session-Id header is required for DELETE'));
  }

  const session = manager.getHttpSession(String(sessionIdHeader));
  if (!session || session.serverId !== serverId) {
    // Clients that resume keep their old id and may still close it afterwards; an id the hub
    // already dropped counts as closed, so the cleanup does not turn into an error.
    if (manager.resumeSessions) return sendEmpty(res, 204);
    return sendJson(res, 404, jsonRpcError(null, -32001, 'Session not found'));
  }

  manager.closeHttpSession(session.id, 'terminated by client');
  return sendEmpty(res, 204);
}

function handleStreamableHttp(req, res, serverId, srv, subRoute) {
  const accept = parseAccept(req.headers.accept);
  const hasSession = req.headers[SESSION_ID_HEADER] !== undefined;

  if (req.method === 'POST') return handleStreamablePost(req, res, serverId);

  if (req.method === 'GET') {
    if (subRoute === '' && !hasSession) {
      // Kept for backwards compatibility with the URLs this hub exposed before the
      // Streamable HTTP endpoint existed.
      if (accept.sse && !accept.html) return handleLegacySse(req, res, serverId);
      if (!accept.sse) return sendInfoPage(res, req, srv, serverId);
    }
    return handleStreamableGet(req, res, serverId, srv);
  }

  if (req.method === 'DELETE') return handleStreamableDelete(req, res, serverId);

  return sendEmpty(res, 405, { Allow: 'GET, POST, DELETE' });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) reject(new Error('Payload too large'));
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        resolve({ raw: body });
      }
    });
    req.on('error', reject);
  });
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

// --- HTTP Server ---
const server = http.createServer(async (req, res) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = parsedUrl.pathname;

  // =========================================================================
  // 1. UNIFIED MCP ROUTE: /mcps/:name, /mcps/:name/mcp, /mcps/:name/sse, ...
  // =========================================================================
  const mcpMatch = pathname.match(/^\/mcps\/([a-zA-Z0-9_-]+)(?:\/(sse|messages|mcp|health))?\/?$/);
  if (mcpMatch) {
    const serverId = mcpMatch[1];
    const subRoute = mcpMatch[2] || '';
    const srv = manager.servers.get(serverId);

    if (!srv) return sendJson(res, 404, { error: `MCP server '${serverId}' not found in Hub` });
    // A launcher entry is a plain process, not a stdio JSON-RPC server: never spawn it as one.
    if (isServiceConfig(srv)) {
      return sendJson(res, 404, { error: `'${serverId}' is a service, use /apps/${serverId}/ instead` });
    }
    if (!authorizeMcpRequest(req, res)) return;

    // A. Health check
    if (subRoute === 'health') {
      const urls = serverUrls(req, serverId);
      return sendJson(res, 200, {
        status: 'ok',
        name: srv.name,
        id: serverId,
        transport: 'stdio (aggregated by MCP Hub)',
        hubPort: PORT,
        url: urls.streamableHttp,
        endpoints: urls,
        protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
        sessions: {
          streamableHttp: Array.from(manager.httpSessions.values()).filter((s) => s.serverId === serverId).length,
          legacySse: Array.from(manager.sessions.values()).filter((s) => s.serverId === serverId).length
        },
        authRequired: Boolean(AUTH_TOKEN)
      });
    }

    // B. Legacy HTTP+SSE transport endpoints
    if (subRoute === 'sse') return handleLegacySse(req, res, serverId);
    if (subRoute === 'messages') {
      if (req.method !== 'POST') return sendEmpty(res, 405, { Allow: 'POST' });
      return handleLegacyMessages(req, res, serverId, parsedUrl);
    }

    // C. Streamable HTTP (POST/GET/DELETE) on /mcps/:name/mcp and /mcps/:name
    return handleStreamableHttp(req, res, serverId, srv, subRoute);
  }

  // =========================================================================
  // 1b. LAUNCHER ROUTE: /apps/:id/* proxies to a supervised service
  // =========================================================================
  const appMatch = pathname.match(/^\/apps\/([a-zA-Z0-9_-]+)(\/.*)?$/);
  if (appMatch) {
    const serviceId = appMatch[1];
    const restPath = appMatch[2] || '';
    const srv = manager.servers.get(serviceId);
    if (!srv) return sendJson(res, 404, { error: `Service '${serviceId}' not found in Hub` });
    if (!isServiceConfig(srv)) {
      return sendJson(res, 404, { error: `'${serviceId}' is an MCP server, use /mcps/${serviceId}/mcp` });
    }
    if (!srv.proxy) {
      const direct = srv.port ? `http://${srv.host || '127.0.0.1'}:${srv.port}` : 'its own address';
      return sendJson(res, 404, {
        error: `Service '${serviceId}' is not proxied by the hub, use ${direct} directly (set "proxy": true to mirror it here)`
      });
    }
    if (!authorizeMcpRequest(req, res)) return;
    if (restPath === '' || restPath === '/') {
      if (req.method === 'GET' || req.method === 'HEAD') {
        return sendServicePage(res, req, srv, manager.services.get(serviceId));
      }
    }
    return proxyToService(req, res, srv, restPath, parsedUrl.search);
  }

  // =========================================================================
  // 2. REST API ROUTES: /api/*
  // =========================================================================
  if (pathname.startsWith('/api/')) {
    // List all
    if (pathname === '/api/servers' && req.method === 'GET') {
      return sendJson(res, 200, { servers: manager.getAllStatus(), hubPort: PORT });
    }

    // Add server
    if (pathname === '/api/servers' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        if (!body.name || !body.command) {
          return sendJson(res, 400, { error: 'Name and command are required' });
        }
        const created = manager.addOrUpdateServer(body);
        return sendJson(res, 201, { success: true, server: created });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    // Bulk actions over every configured server: /api/servers/start-all and /api/servers/stop-all
    if (
      (pathname === '/api/servers/start-all' || pathname === '/api/servers/stop-all') &&
      req.method === 'POST'
    ) {
      const action = pathname.endsWith('start-all') ? 'start' : 'stop';
      const results = [];
      for (const [id, srv] of manager.servers.entries()) {
        if (!srv.enabled) {
          results.push({ id, skipped: 'disabled' });
          continue;
        }
        try {
          if (action === 'start') {
            results.push(await manager.startServer(id));
          } else {
            manager.stopServer(id);
            results.push({ id, stopped: true });
          }
        } catch (e) {
          results.push({ id, error: e.message });
        }
      }
      return sendJson(res, 200, {
        success: results.every((r) => !r.error),
        action,
        results
      });
    }

    // Update an existing server: PUT /api/servers/:id. The id comes from the path so a rename
    // cannot be smuggled in through the body, and the payload replaces the whole entry.
    const updateMatch = pathname.match(/^\/api\/servers\/([a-zA-Z0-9_-]+)$/);
    if (updateMatch && req.method === 'PUT') {
      const id = updateMatch[1];
      if (!manager.servers.has(id)) return sendJson(res, 404, { error: `Server ${id} not found` });
      try {
        const body = await parseBody(req);
        if (!body.name || !body.command) {
          return sendJson(res, 400, { error: 'Name and command are required' });
        }
        return sendJson(res, 200, { success: true, server: manager.addOrUpdateServer({ ...body, id }) });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    // Action on single server: /api/servers/:id/:action
    const actionMatch = pathname.match(/^\/api\/servers\/([a-zA-Z0-9_-]+)\/(start|stop|restart|logs|health|usage)$/);
    if (actionMatch) {
      const [, id, action] = actionMatch;
      if (!manager.servers.has(id)) return sendJson(res, 404, { error: `Server ${id} not found` });

      if (action === 'start' || action === 'restart') {
        try {
          const session = await manager.restartServer(id);
          return sendJson(res, 200, { success: true, pid: session?.process?.pid ?? null });
        } catch (e) {
          return sendJson(res, e.statusCode || 500, { error: e.message });
        }
      }
      if (action === 'stop') {
        return sendJson(res, 200, manager.stopServer(id));
      }
      if (action === 'logs') {
        return sendJson(res, 200, { logs: manager.logs.get(id) || [] });
      }
      if (action === 'health') {
        try {
          return sendJson(res, 200, { id, health: await manager.probeServerHealth(id) });
        } catch (e) {
          return sendJson(res, e.statusCode || 500, { error: e.message });
        }
      }
      if (action === 'usage') {
        try {
          return sendJson(res, 200, { id, ...(await manager.probeServerUsage(id)) });
        } catch (e) {
          return sendJson(res, e.statusCode || 500, { error: e.message });
        }
      }
    }

    // Real-time SSE log stream: /api/servers/:id/logs/stream
    const streamMatch = pathname.match(/^\/api\/servers\/([a-zA-Z0-9_-]+)\/logs\/stream$/);
    if (streamMatch && req.method === 'GET') {
      const id = streamMatch[1];
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });

      const initialLogs = manager.logs.get(id) || [];
      res.write(`data: ${JSON.stringify({ type: 'history', logs: initialLogs })}\n\n`);

      const logListener = (entry) => {
        res.write(`data: ${JSON.stringify({ type: 'log', entry })}\n\n`);
      };

      manager.on(`log:${id}`, logListener);
      req.on('close', () => manager.removeListener(`log:${id}`, logListener));
      return;
    }

    // SSE events for dashboard auto-sync
    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });

      const changeListener = () => {
        res.write(`data: ${JSON.stringify({ type: 'servers', servers: manager.getAllStatus() })}\n\n`);
      };

      manager.on('change', changeListener);
      manager.on('configChange', changeListener);

      const pingTimer = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(pingTimer);
        manager.removeListener('change', changeListener);
        manager.removeListener('configChange', changeListener);
      });
      return;
    }

    // Delete server
    const serverMatch = pathname.match(/^\/api\/servers\/([a-zA-Z0-9_-]+)$/);
    if (serverMatch && req.method === 'DELETE') {
      return sendJson(res, 200, manager.removeServer(serverMatch[1]));
    }

    return sendJson(res, 404, { error: 'Not found' });
  }

  // =========================================================================
  // 3. STATIC WEB DASHBOARD
  // =========================================================================
  let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } else {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(indexPath).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not Found');
    }
  }
});

// Warm up the shared persistent sessions / services so the first client does not pay for the
// spawn. Disabled entries and entries with autostart switched off stay down until asked for.
function warmUp() {
  for (const [id, srv] of manager.servers.entries()) {
    if (!srv.enabled || !srv.autoStart) {
      console.log(`[Hub] Leaving ${id} stopped (${!srv.enabled ? 'disabled' : 'autostart off'})`);
      continue;
    }
    try {
      if (isServiceConfig(srv)) {
        manager.startService(id).catch((e) => console.error(`[Hub] Failed to start ${id}:`, e.message));
      } else {
        manager.getPersistentSession(id);
      }
    } catch (e) {
      console.error(`[Hub] Failed to start ${id}:`, e.message);
    }
  }
}

function destroyAllSessions() {
  for (const sessions of [manager.httpSessions, manager.sessions, manager.persistentSessions]) {
    for (const session of sessions.values()) session.destroy();
    sessions.clear();
  }
  for (const service of manager.services.values()) service.destroy();
  manager.services.clear();
}

export async function startHub({ port = PORT, host = HOST, warm = true, banner = true, signals = true } = {}) {
  if (warm) warmUp();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const actualPort = server.address().port;

  if (banner) {
    const body = [
      '│  ⚡ MCP Unified Hub (Single-Port Aggregation)          │',
      '├────────────────────────────────────────────────────────┤',
      `│  🌐 Dashboard:        http://127.0.0.1:${String(actualPort).padEnd(18)}│`,
      '│  🔀 Streamable HTTP:  /mcps/<id>/mcp                   │',
      '│  📡 Legacy SSE:       /mcps/<id>/sse                   │',
      `│  🔒 Auth:             ${(AUTH_TOKEN ? 'Bearer token required' : 'open (set MCP_HUB_TOKEN)').padEnd(31)}│`,
      '└────────────────────────────────────────────────────────┘'
    ];
    const lines = Array.from(manager.servers.values()).map((srv) => {
      const parked = !srv.enabled ? '  [disabled]' : !srv.autoStart ? '  [manual start]' : '';
      const where = isServiceConfig(srv)
        ? `http://127.0.0.1:${actualPort}/apps/${srv.id}/`
        : `http://127.0.0.1:${actualPort}/mcps/${srv.id}/mcp`;
      return `  - ${srv.name || srv.id}: ${where}${parked}`;
    });
    console.log(`
┌────────────────────────────────────────────────────────┐
${body.join('\n')}
📦 Managed servers & services:
${lines.join('\n')}
`);
  }

  const close = async () => {
    destroyAllSessions();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };

  if (signals) {
    const shutdown = () => {
      console.log('[Hub] Shutting down child processes...');
      close().then(() => process.exit(0), () => process.exit(0));
      // Never hang forever on a stuck connection.
      setTimeout(() => process.exit(0), 1500).unref();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }

  return {
    server,
    port: actualPort,
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`,
    close
  };
}

export { manager, server, StdioSession, HttpSession };

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  startHub().catch((error) => {
    console.error('[Hub] Failed to start:', error.message);
    process.exit(1);
  });
}
