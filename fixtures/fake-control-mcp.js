// Backend fixture for the adapter tests. It behaves like a small MCP server over stdio and
// reports what it received, so tests can prove that an adapter rewrote the arguments or the
// environment before the backend ever saw them.
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const TOOLS = [
  {
    name: 'echo_arguments',
    description: 'Echo the arguments it was called with',
    inputSchema: { type: 'object', properties: { cookie: { type: 'string' }, credential_path: { type: 'string' } } }
  },
  {
    name: 'login',
    description: 'Tool that takes no credential argument',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'report_env',
    description: 'Report an environment variable of the backend process',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } }
  }
];

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (message.method === undefined) return;

  switch (message.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-control-mcp', version: '1.0.0' }
        }
      });
      return;
    case 'notifications/initialized':
      return;
    case 'tools/list':
      send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
      return;
    case 'tools/call': {
      const name = message.params?.name;
      const args = message.params?.arguments || {};
      const env = {};
      if (name === 'report_env' && typeof args.name === 'string') env[args.name] = process.env[args.name] ?? null;
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ name, args, env }) }],
          structuredContent: { name, arguments: args, env, pid: process.pid }
        }
      });
      return;
    }
    default:
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
});

rl.on('close', () => process.exit(0));
