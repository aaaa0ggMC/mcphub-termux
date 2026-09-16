// Minimal MCP server over stdio, used by the MCP Hub transport tests.
// Speaks line delimited JSON-RPC 2.0 and reports its own pid so tests can prove that
// every Streamable HTTP session gets its own backend process.
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });

let initialized = false;
let notifications = 0;
let initParams = null;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (message.method === undefined) return; // JSON-RPC response from the client

  switch (message.method) {
    case 'initialize':
      initParams = message.params || {};
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-mcp', version: '1.0.0' }
        }
      });
      return;
    case 'notifications/initialized':
      initialized = true;
      process.stderr.write('fake-mcp initialized\n');
      return;
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
            { name: 'notify', description: 'Emit a notification before responding', inputSchema: { type: 'object' } }
          ]
        }
      });
      return;
    case 'tools/call': {
      const name = message.params?.name;
      if (name === 'notify') {
        notifications += 1;
        send({
          jsonrpc: '2.0',
          method: 'notifications/message',
          params: { level: 'info', data: `tick ${notifications}`, pid: process.pid }
        });
      }
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: `${name}:pid=${process.pid}:initialized=${initialized}` }],
          // `handshake` describes how this process was initialized; the resume tests use it to
          // prove that a resumed session replayed the client's own initialize.
          structuredContent: {
            name,
            pid: process.pid,
            initialized,
            handshake: {
              initialized,
              protocolVersion: initParams?.protocolVersion || null,
              clientInfo: initParams?.clientInfo || null
            }
          }
        }
      });
      return;
    }
    case 'ping':
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      return;
    default:
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
});

rl.on('close', () => process.exit(0));
