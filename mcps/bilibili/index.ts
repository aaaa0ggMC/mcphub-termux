// Bilibili MCP adapter.
//
// The bilibili MCP server understands `X-Bilibili-Cookie` (and friends) only in its own
// HTTP mode, because it reads the credential from the HTTP request. Through MCP Hub the
// client talks to the hub and the hub talks stdio to the server, so those headers would
// otherwise stop at the hub.
//
// This adapter closes that gap in two places:
//   * It takes the credential from the headers the client sent to the hub and adds it to
//     `tools/call` as the per-request `cookie` / `credential_path` argument the bilibili
//     server already supports (see mcp/server.ts of bilibili-api-node). Tools that do not
//     declare such an argument - the login category - are left untouched, and an argument
//     sent by the client always wins.
//   * It also passes the credential of the session as `BILIBILI_COOKIE` /
//     `BILIBILI_CREDENTIAL_PATH` / `BILIBILI_SESSDATA` ... to the backend process, which is
//     how the login tools - `bilibili_get_credential_status` in particular - learn about it.
//     Those environment variables are fixed when the session starts; the per-request argument
//     above is what keeps later requests of the same session in sync.
import { firstHeader, runAdapter, toolAccepts } from '../_adapter.js';
import type { AdapterContext } from '../_adapter.js';

const COOKIE_HEADERS = ['x-bilibili-cookie', 'x-cookie', 'cookie'];
const PATH_HEADERS = ['x-bilibili-credential-path', 'x-credential-path'];
const CREDENTIAL_PARTS: Array<[string, string[]]> = [
  ['SESSDATA', ['x-bilibili-sessdata', 'x-sessdata']],
  ['bili_jct', ['x-bilibili-bili-jct', 'x-bili-jct']],
  ['buvid3', ['x-bilibili-buvid3', 'x-buvid3']],
  ['DedeUserID', ['x-bilibili-dedeuserid', 'x-dedeuserid']],
  ['ac_time_value', ['x-bilibili-ac-time-value', 'x-ac-time-value']]
];

type HeaderCredential =
  | { kind: 'cookie'; value: string }
  | { kind: 'path'; value: string }
  | { kind: 'parts'; parts: Array<[string, string]> };

let loggedOnce = false;
let skippedOnce = false;

function credentialFromHeaders(ctx: AdapterContext): HeaderCredential | null {
  const cookie = firstHeader(ctx, COOKIE_HEADERS);
  if (cookie) return { kind: 'cookie', value: cookie };

  const path = firstHeader(ctx, PATH_HEADERS);
  if (path) return { kind: 'path', value: path };

  const authorization = firstHeader(ctx, ['authorization']);
  if (/^bearer\s+/i.test(authorization)) {
    return { kind: 'cookie', value: authorization.replace(/^bearer\s+/i, '').trim() };
  }

  const parts = CREDENTIAL_PARTS
    .map(([name, headers]) => [name, firstHeader(ctx, headers)] as const)
    .filter(([, value]) => value) as Array<[string, string]>;
  return parts.length ? { kind: 'parts', parts } : null;
}

// Both arguments end up in BiliCredential.fromInput(), so either one can carry a cookie
// string or a credential file path - pick whichever the tool actually declares.
function credentialArgument(credential: HeaderCredential): string {
  if (credential.kind === 'parts') {
    return credential.parts.map(([name, value]) => `${name}=${value}`).join('; ');
  }
  return credential.value;
}

// The same credential shaped as the environment the bilibili server reads at startup
// (see mcp/context.ts there). This is what reaches tools that accept no credential argument.
function credentialEnv(credential: HeaderCredential): Record<string, string> {
  if (credential.kind === 'cookie') return { BILIBILI_COOKIE: credential.value };
  if (credential.kind === 'path') return { BILIBILI_CREDENTIAL_PATH: credential.value };

  const env: Record<string, string> = {};
  for (const [name, value] of credential.parts) env[`BILIBILI_${name.toUpperCase()}`] = value;
  return env;
}

function argumentName(ctx: AdapterContext, toolName: string): string | null {
  if (toolAccepts(ctx, toolName, 'cookie') !== false) return 'cookie';
  if (toolAccepts(ctx, toolName, 'credential_path') !== false) return 'credential_path';
  return null;
}

runAdapter({
  spawnEnv(ctx) {
    const credential = credentialFromHeaders(ctx);
    return credential ? credentialEnv(credential) : {};
  },

  transformMessage(message, ctx) {
    if (!message || typeof message !== 'object' || message.method !== 'tools/call') return message;

    const params = message.params || {};
    const args = params.arguments || {};
    if (args.cookie || args.credential_path || args.credential) return message;

    const credential = credentialFromHeaders(ctx);
    if (!credential) return message;

    const argument = argumentName(ctx, params.name);
    if (!argument) {
      if (!skippedOnce) {
        skippedOnce = true;
        // Never log the credential itself, only the fact that this tool cannot take one.
        ctx.log(`tool ${params.name} takes no credential argument, using the backend environment only`);
      }
      return message;
    }

    if (!loggedOnce) {
      loggedOnce = true;
      ctx.log(`using credentials from the ${ctx.requestHeaders ? 'request' : 'session'} headers for tool calls`);
    }
    return {
      ...message,
      params: { ...params, arguments: { ...args, [argument]: credentialArgument(credential) } }
    };
  }
});
