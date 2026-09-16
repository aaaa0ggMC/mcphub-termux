// 记账 MCP 的 hub 适配器。
//
// 记账服务默认脱敏，原文（raw）需要一把密钥；直接连 stdio 时密钥走环境变量，
// 而通过 hub 连的时候客户端只能发 HTTP 头。这个适配器把「头」翻译成后端认的
// 环境变量，顺便把几件与隐私相关的事固定在 hub 这一层：
//
//   * **没有密钥就拒绝整个会话**（和 kebiao 的 Bearer 令牌同理）。hub 默认监听
//     0.0.0.0，局域网里任何设备都能连上来；如果不设门禁，它们不仅能读到你的消费
//     金额、分类、时间，还能直接调用写工具删改你的账目。所以这里不提供匿名访问：
//     没有 X-Ledger-Key 的会话，每条请求都回 -32001。
//   * 密钥只从请求头读，绝不进工具参数 —— 参数会进模型上下文和调用日志，
//     等于把钥匙一起交出去。这里读到的值只交给后端进程，不打印、不回传。
//   * 密钥在会话建立时生效（后端进程的环境变量是启动时固定的）。会话中途换了
//     一把不同的密钥时直接报错，而不是悄悄按旧权限继续 —— 让调用方以为有原文
//     权限却拿到脱敏数据，比报错危险得多。
//   * 可以被指向的账本文件默认锁在 LEDGER_MCP_BASE_DIR 之内，且需要显式打开
//     LEDGER_MCP_ALLOW_DB_HEADER=1；否则 X-Ledger-Db 一律忽略。
//
// 识别的请求头：
//   X-Ledger-Key / X-Ledger-Privacy-Key / X-Privacy-Key   隐私密钥（64 位十六进制）
//   Authorization: Bearer <64 位十六进制>                  同上（避免与 hub token 混淆）
//   X-Ledger-Db                                            指定账本 sqlite（需显式开启）
//   X-Ledger-Level                                         count|redacted|raw，本会话的等级上限（也是默认等级）
//                                                          模型只能往下降，改不了它
//   X-Ledger-Reveal-Budget                                 覆盖本会话的逐条披露预算
import { firstHeader, respondError, runAdapter } from '../_adapter.js';
import type { AdapterContext } from '../_adapter.js';
import { isAbsolute, resolve, sep } from 'node:path';

const KEY_HEADERS = ['x-ledger-key', 'x-ledger-privacy-key', 'x-privacy-key'];
const DB_HEADERS = ['x-ledger-db', 'x-ledger-database'];
const LEVEL_HEADERS = ['x-ledger-level'];
const BUDGET_HEADERS = ['x-ledger-reveal-budget'];
const LEVELS = ['count', 'redacted', 'raw'];

const BASE_DIR = process.env.LEDGER_MCP_BASE_DIR || process.env.HOME || '';
const ALLOW_DB_HEADER = process.env.LEDGER_MCP_ALLOW_DB_HEADER === '1';

// 会话建立时定下来的密钥。只用于比较，不做任何输出。
let sessionKey = '';
let warnedDb = false;

function keyFromHeaders(ctx: AdapterContext): string {
  const direct = firstHeader(ctx, KEY_HEADERS);
  if (direct) return direct;
  // hub 自己也可能在用 Authorization 传 token，所以只有形状确实像密钥时才认
  const authorization = firstHeader(ctx, ['authorization']);
  const bearer = /^bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim() ?? '';
  return /^[0-9a-f]{64}$/i.test(bearer) ? bearer : '';
}

function dbFromHeaders(ctx: AdapterContext): string {
  const raw = firstHeader(ctx, DB_HEADERS);
  if (!raw) return '';
  if (!ALLOW_DB_HEADER) {
    if (!warnedDb) {
      warnedDb = true;
      ctx.log('忽略 X-Ledger-Db：需要设置 LEDGER_MCP_ALLOW_DB_HEADER=1 才允许客户端指定账本文件');
    }
    return '';
  }
  if (!BASE_DIR) return '';
  const base = resolve(BASE_DIR);
  const target = isAbsolute(raw) ? resolve(raw) : resolve(base, raw);
  // 只允许落在基准目录之内：否则一个请求头就能让服务去读任意路径
  if (target !== base && !target.startsWith(base + sep)) {
    ctx.log('拒绝越界的 X-Ledger-Db（超出 LEDGER_MCP_BASE_DIR）');
    return '';
  }
  return target;
}

runAdapter({
  spawnEnv(ctx: AdapterContext) {
    const key = keyFromHeaders(ctx);
    sessionKey = key;

    const env: Record<string, string> = {};
    if (key) env.LEDGER_PRIVACY_KEY = key;

    const db = dbFromHeaders(ctx);
    if (db) env.LEDGER_DB = db;

    // 客户端配置里写的等级 = 这条连接的天花板，同时也是默认等级。
    // 没写就是 redacted：模型能连上、能做分析和记账，但看不到原文。
    const level = firstHeader(ctx, LEVEL_HEADERS).toLowerCase();
    const ceiling = LEVELS.includes(level) ? level : 'redacted';
    env.LEDGER_MAX_LEVEL = ceiling;
    env.LEDGER_DEFAULT_LEVEL = ceiling;

    const budget = firstHeader(ctx, BUDGET_HEADERS);
    if (/^(\d+|off)$/i.test(budget)) env.LEDGER_REVEAL_BUDGET = budget;

    ctx.log(key
      ? `本会话已提供隐私密钥，等级上限 ${ceiling}`
      : '本会话没有密钥：拒绝访问（本服务不提供匿名访问）');
    return env;
  },

  transformMessage(message, ctx: AdapterContext) {
    if (!message || typeof message !== 'object' || !message.method) return message;
    if (message.method === 'notifications/initialized') return message;

    // 门禁：没有密钥的会话一律拒绝，连 initialize 和 tools/list 都不给
    if (!sessionKey) {
      return respondError(
        message,
        -32001,
        'Unauthorized: 缺少 X-Ledger-Key。记账 MCP 不提供匿名访问（hub 默认监听 0.0.0.0，'
        + '否则局域网里任何设备都能读写这份账本）。请在客户端配置里带上 data/privacy.key 的内容重新建立会话：'
        + 'X-Ledger-Key: <64 位十六进制>'
      );
    }

    const presented = keyFromHeaders(ctx);
    if (presented && presented !== sessionKey) {
      // 后端进程的环境变量已经固定，中途换密钥不会生效；明说比让人误判强
      return respondError(
        message,
        -32001,
        sessionKey
          ? '本会话已用另一个隐私密钥建立，中途更换不会生效：请重新建立 MCP 会话'
          : '本会话建立时没有携带隐私密钥，现在补发也不会生效：请重新建立 MCP 会话'
      );
    }
    return message;
  }
});
