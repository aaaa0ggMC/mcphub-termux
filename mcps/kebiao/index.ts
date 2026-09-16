// 课表 MCP 的 hub 适配器：把「客户端能不能访问」这道门钉在 hub 这一侧。
//
// 为什么门禁必须在这里，而不是在 kebiao 自己那边：kebiao 的 KEBIAO_TOKEN 只在它
// 自己的 HTTP 服务器里检查（src/server.js 的中间件），而 hub 是用 stdio 拉它的。
// stdio 上不存在「客户端凭证」这个概念 —— 谁来拉进程，谁就能设进程的环境变量，
// 所以后端自己检查 token 等于自己检查自己，挡不住任何人。客户端唯一拿得出手、
// 而 hub 又能看到的东西是**请求头**。这就是这个适配器存在的唯一理由。
//
// 行为：
//   * 没有令牌、令牌不对、或者服务端根本没配令牌 → 拒绝整个会话，
//     连 initialize 和 tools/list 都不给（fail closed）。
//   * 令牌对得上 → 原样转发，不该改的一律不改。
//
// 识别的请求头：
//   X-Kebiao-Token / X-Kebiao-Key     令牌（推荐：不会和 hub 自己的 token 撞车）
//   Authorization: Bearer <token>     与 kebiao 自己那条 HTTP 路径的用法一致
//
// 令牌来源：servers.json 里这个条目的 env.KEBIAO_TOKEN。hub 会把 config.env 交给
// 适配器进程（也会交给后端），所以直接读 process.env 就是它。
// 注意 hub 自己没有开关的情况下，控制台用 /api/servers 读到的 env 会做脱敏处理。
import { firstHeader, respondError, runAdapter } from '../_adapter.js';
import type { AdapterContext } from '../_adapter.js';
import { timingSafeEqual } from 'node:crypto';

const TOKEN_HEADERS = ['x-kebiao-token', 'x-kebiao-key', 'x-kebiao-api-key'];

const EXPECTED = String(process.env.KEBIAO_TOKEN || '').trim();

// 会话建立时定下来的令牌，只用于比较；不打印、不回传。
let sessionToken = '';

function tokenFromHeaders(ctx: AdapterContext): string {
  const direct = firstHeader(ctx, TOKEN_HEADERS);
  if (direct) return direct;
  // 与 kebiao 自己的 HTTP 路径保持一致；只有形状确实像 Bearer 时才认
  const authorization = firstHeader(ctx, ['authorization']);
  return /^bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim() ?? '';
}

function sameToken(a: string, b: string): boolean {
  if (!a || !b) return false;
  const given = Buffer.from(a);
  const expected = Buffer.from(b);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

if (!EXPECTED) {
  console.error(
    '[adapter:kebiao] 没有配置 KEBIAO_TOKEN：所有会话都会被拒绝。'
    + '请在 servers.json 这个条目的 env 里设置令牌（并让客户端在请求头里带上同一个值）。'
  );
}

runAdapter({
  spawnEnv(ctx: AdapterContext) {
    sessionToken = tokenFromHeaders(ctx);
    ctx.log(sameToken(sessionToken, EXPECTED)
      ? '本会话令牌正确：放行'
      : '本会话没有（或错误的）令牌：拒绝访问（课表服务不提供匿名访问）');
    return {};
  },

  transformMessage(message, ctx: AdapterContext) {
    if (!message || typeof message !== 'object' || !message.method) return message;

    // 门禁：令牌不对的会话一律拒绝。
    // 注意这里不区分「没带」和「带错了」—— 外面的调用方不需要知道哪一种，
    // 而日志里已经写清楚了。
    if (!sameToken(sessionToken, EXPECTED)) {
      return respondError(
        message,
        -32001,
        EXPECTED
          ? 'Unauthorized: 缺少或错误的课表令牌。请在客户端配置里带上 X-Kebiao-Token'
            + '（或 Authorization: Bearer <token>），值就是 servers.json 里这条的 KEBIAO_TOKEN。'
          : 'Unauthorized: 课表服务没有配置 KEBIAO_TOKEN，已拒绝所有访问（fail closed）。'
      );
    }

    if (message.method === 'notifications/initialized') return message;

    // 会话中途换令牌不会生效：后端进程在建立时就定了。明说比让人误判强。
    const presented = tokenFromHeaders(ctx);
    if (presented && !sameToken(presented, sessionToken)) {
      return respondError(message, -32001, '本会话已用另一个令牌建立，中途更换不会生效：请重新建立 MCP 会话');
    }
    return message;
  }
});
