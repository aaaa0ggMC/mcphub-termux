# MCP Hub

本地服务中枢 + 移动端 Web 控制台。两件事：

- **MCP 聚合**：把多个本地 stdio MCP 服务聚合成一个端口上的 Streamable HTTP / HTTP+SSE 端点，
  不必给每个 MCP 单独开端口。
- **启动器**：托管普通的常驻进程（如 `codex-proxy` 这类自带端口的本地 HTTP 服务），统一
  启动/停止/重载、抓日志、做健康检查。这类服务默认**保持自己的端口**，只有在条目里显式写
  `"proxy": true` 时，hub 才额外把它镜像到 `/apps/<id>/`。

两种条目用同一个 `servers.json`、同一套开关（`enabled` / `autoStart`）、同一个控制台；
区别只有 `"kind"`：不写或 `"mcp"` 是 stdio MCP 服务，`"service"` 是启动器托管的进程。

没有依赖需要安装，`node index.js` 就能跑；Termux 上 `pkg install nodejs` 即可。仓库名是 `mcphub-termux`，克隆目录叫什么名字都行——启动脚本按自身位置定位项目。

## 启动

先准备自己的配置（`servers.json` 是每台机器各自的运行时状态，不进版本库，控制台里的增删改会直接写回它）：

```bash
cp servers.example.json servers.json
```

```bash
bin/mcp-hub start     # 后台启动（默认 http://127.0.0.1:8888）
bin/mcp-hub status    # 查看 hub、MCP 服务与托管服务的状态
bin/mcp-hub fg        # 前台运行，便于调试
bin/mcp-hub logs
bin/mcp-hub stop
```

`bin/mcp-hub` 用 `#!/usr/bin/env bash`，在电脑上直接可用；Termux 默认装了 `termux-exec`，会把 `/usr/bin/env` 重写到 `$PREFIX/bin/env`，所以同一个文件在手机上也能直接执行。

## 端点

| 端点 | 说明 |
| --- | --- |
| `POST/GET/DELETE /mcps/<id>/mcp` | **Streamable HTTP**（推荐，MCP 2025-03-26 ~ 2025-11-25） |
| `GET /mcps/<id>/sse` + `POST /mcps/<id>/messages` | 旧版 HTTP+SSE 传输（2024-11-05） |
| `GET /mcps/<id>/health` | 健康检查 / 传输能力探测 |
| `GET /mcps/<id>` | 浏览器访问时的信息页；`POST` 等价于 `/mcps/<id>/mcp` |
| `/apps/<id>/*` | 仅当服务条目写了 `"proxy": true`：把请求转发到该服务自己的端口 |
| `GET /apps/<id>` | 该服务的镜像信息页（上游地址、健康状态） |
| `GET /` | 移动端优先的控制台：服务卡片、批量启停、实时日志、增删改；深/浅色跟随系统并可手动切换 |
| `/api/*` | 控制台 REST API（服务器增删改、`/api/servers/start-all` 与 `stop-all` 批量启停、`/api/servers/<id>/health` 立即探活、`/api/servers/<id>/usage` 立即读一次额度、日志、SSE 事件流） |

同一个 `POST /mcps/<id>`（不带 `/mcp`）仍然可用，兼容旧配置。

## Streamable HTTP 行为

实现遵循 MCP 规范（2025-03-26 / 2025-06-18 / 2025-11-25）：

- **协议版本**：支持 `2025-11-25`、`2025-06-18`、`2025-03-26`、`2024-11-05`、`2024-10-07`。
  请求带 `MCP-Protocol-Version` 头且不在列表内时返回 `400`；缺省按 `2025-03-26` 处理。
- **会话**：`initialize` 的响应带 `Mcp-Session-Id` 头，后续请求必须回传。每个 MCP 会话独占一个
  后端 stdio 进程，会话之间状态互不影响。
- **自动续会话**：客户端带回一个 hub 已不认识的 `Mcp-Session-Id`（空闲回收、hub 重启、后端进程
  崩溃）时，hub 不返回 `404`，而是**用同一个 id** 重新拉起后端进程继续服务：凭据随每个请求走
  HTTP 头，新进程可以直接处理下一个请求；同时 hub 会自动重放客户端当初那次 `initialize`
  （协议版本、`clientInfo`、`capabilities`），所以客户端不用重新握手，缓存的会话 id 继续有效。
  没有任何握手记录时用 hub 自己的 `initialize`（`clientInfo` 为 `mcp-hub`）。
  设 `MCP_HUB_RESUME_SESSION=0` 可关闭该行为（恢复严格规范行为：未知/过期会话一律 `404`）。
- **POST**：请求返回 `Content-Type: application/json` 的单个响应；若客户端 `Accept` 只接受
  `text/event-stream`，则在 SSE 流上返回结果（流在响应发出后关闭）。
  通知 / 客户端响应（无 `id`）返回 `202 Accepted`，无响应体。
- **GET**：需要 `Accept: text/event-stream` 与有效会话，返回服务器到客户端的 SSE 流
  （服务端发起的 sampling/elicitation 请求、通知都会推送到该流）。支持 `Last-Event-ID` 断线重放。
- **DELETE**：终止会话，返回 `204`；开启自动续会话时，删除一个 hub 已经不认识的 id 同样返回
  `204`（客户端清理会话不会变成报错）。
- 其他情况：`Accept` 不含 json/event-stream 返回 `406`；不支持的方法返回 `405`；非法 JSON 返回 `400`。
- 没有 `Mcp-Session-Id` 的普通请求会交给常驻共享进程处理（本 hub 旧有行为，方便脚本直接 POST）。
  设置 `MCP_HUB_REQUIRE_SESSION=1` 可改为严格模式（无会话返回 `400`）。

## 客户端接入

```json
{
  "mcpServers": {
    "kebiao": { "type": "http", "url": "http://127.0.0.1:8888/mcps/kebiao/mcp" }
  }
}
```

旧版只支持 SSE 的客户端：

```json
{ "mcpServers": { "kebiao": { "type": "sse", "url": "http://127.0.0.1:8888/mcps/kebiao/sse" } } }
```

命令行验证：

```bash
# 初始化（响应头带 Mcp-Session-Id）
curl -i -X POST http://127.0.0.1:8888/mcps/kebiao/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

# 带会话 id 调用工具
curl -X POST http://127.0.0.1:8888/mcps/kebiao/mcp \
  -H 'Content-Type: application/json' -H 'Mcp-Session-Id: <上面返回的 id>' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

## 服务配置（`servers.json`）

每个条目要么是一个后端 stdio MCP 服务，要么是一个启动器托管的进程（`kind: "service"`）。
控制台里的增删改会写回这个文件。

从 `servers.example.json` 复制一份开始。`command`、`cwd`、`args` 和 `env` 的值支持 `~`、`$HOME`、`${HOME}`，hub 在拉起进程前展开，所以同一份配置可以从手机搬到电脑，不必改一堆绝对路径。

| 字段 | 说明 |
| --- | --- |
| `id` / `name` / `icon` / `description` | 标识与展示信息。`id` 出现在 `/mcps/<id>/...` 与 `/apps/<id>/...` 路由里 |
| `kind` | 可选，不写即 `"mcp"`（stdio JSON-RPC）。`"service"` 表示由 hub 托管的普通进程 |
| `command` / `args` / `cwd` / `env` | 启动方式；配了 `adapter` 时这些会原样交给适配器（只对 `mcp` 有意义） |
| `adapter` | 可选，如 `mcps/bilibili/index.ts`，用来改写转发消息或后端环境变量 |
| `enabled` | 默认 `true`。设为 `false` 即停用：hub 启动时不拉起它，单个与批量启动都会跳过（`POST /api/servers/<id>/start` 返回 `409`），控制台显示「已停用」。把正在运行的服务改成 `false` 会立刻停掉它 |
| `autoStart` | 默认 `true`。设为 `false` 表示 hub 启动时留空，需要手动或批量启动 |

两个开关都是「不写即默认开启」，所以老配置不需要迁移。管理接口：
`GET`/`POST /api/servers`、`PUT`/`DELETE /api/servers/:id`、`POST /api/servers/start-all` 与
`POST /api/servers/stop-all`（批量接口会跳过已停用的服务，并在结果的 `skipped` 字段里说明）、
`GET /api/servers/:id/health`（立刻探一次活，而不是等下一次轮询）。

## 托管服务与启动器（`kind: "service"`）

除了 MCP 聚合，hub 也能当启动器：托管你自己的常驻进程，统一开关、看日志、探健康。
典型例子是 `codex-proxy`（一个基于 Codex CLI 登录的 OpenAI 兼容本地服务）：

```json
{
  "id": "codex-proxy",
  "kind": "service",
  "name": "Codex Proxy",
  "command": "~/codex-proxy/codex-proxy",
  "args": ["--port", "6769"],
  "cwd": "~/codex-proxy",
  "port": 6769,
  "host": "127.0.0.1",
  "healthPath": "/healthz",
  "usagePath": "/v1/usage",
  "restart": "on-failure"
}
```

| 字段 | 说明 |
| --- | --- |
| `port` / `host` | 服务自己监听的端口与地址（默认 host `127.0.0.1`）。用来探活，也用来在控制台里显示/打开它的地址；`port` 为空表示这个进程没有 HTTP 面儿，此时健康状态就等同进程存活 |
| `healthPath` | 健康检查路径，默认 `/healthz`。返回 `4xx` 以内算健康，`5xx` 或连不上算异常 |
| `restart` | 退出后的重启策略：`on-failure`（默认，只有非 0 退出才重启）、`always`、`no`。5 分钟内最多重启 5 次，超了会停下来并在控制台报「restart limit reached」，避免崩溃循环 |
| `proxy` | 默认 `false`。**服务保持自己的端口**；只有显式写 `true` 时，hub 才额外汇镜像到 `/apps/<id>/`（流式转发，SSE 不会被缓冲） |
| `usagePath` | 可选。服务上报额度的接口路径（如 `/v1/usage`，返回 `{"windows": {...}}`），配了就会按 60s 轮询，并在控制台卡片上显示每个窗口「剩 N%」 |
| `adapter` | 对 `service` 无意义，会被忽略 |

行为说明：

- 启动器用**独立进程组**拉起服务，停止时先 `SIGTERM`、宽限 4 秒后 `SIGKILL`（在 Termux 上
  整组一起收掉，不会留下孤儿进程）。
- 输出进控制台的实时日志，和 MCP 服务共用一套日志接口与 SSE 流。
- 进程刚起来时会以 700ms 的间隔快速探活，稳定后按 15s 轮询；状态变化会推给控制台。
- 一个服务条目只会被 hub 托管一个实例：`/api/servers/<id>/start` 对已运行的服务是幂等的；
  改了配置不会自动重启正在跑的进程（控制台里显示的还是当前进程的地址与日志），点「重载」或
  `POST /api/servers/<id>/restart` 之后新配置才生效。
- 服务条目在 `/mcps/<id>/...` 上会返回 `404` 并提示改用 `/apps/<id>/`（或它自己的地址），
  反之 MCP 条目在 `/apps/<id>/...` 上也会被拒绝——两边不会互相误拉进程。

### 额度显示（`usagePath`）

服务自己上报额度时（`codex-proxy` 的 `/v1/usage` 就是这样），在条目里加上 `usagePath` 即可：

```json
{
  "id": "codex-proxy",
  "kind": "service",
  "usagePath": "/v1/usage",
  "...": "..."
}
```

hub 每 60 秒读一次，归一化后放进 `/api/servers` 的 `usage` 字段（`GET /api/servers/<id>/usage`
可以立刻读一次）。支持两种形状，`{"windows": {<key>: {...}}}` 对象或 `{"windows": [...]}` 数组，
每个窗口读这几个字段：

| 字段 | 说明 |
| --- | --- |
| `remaining_percent` | 必填，剩余百分比。没有它整个窗口会被跳过 |
| `used_percent` | 可选，缺失时按 `100 - remaining_percent` 反推 |
| `label` / `short_label` | 展示名。卡片上优先用 `short_label`（`weekly` / `7d` 这种长短之分） |
| `window_seconds` | 窗口长度，用来排序（短的在前） |
| `resets_at` | 重置时间，详情里显示「重置于 …」 |

控制台卡片对每个窗口显示一行「额度 5h 剩 100%」，颜色按剩余量分档（≤30% 黄、≤10% 红）；
点「详情」还能看到进度条与重置时间。额度接口报错不会影响服务本身的状态——探测失败只会让
额度消失，健康状态照旧。

## 每服务适配器（`mcps/<id>/index.ts`）

有些能力后端本身没有、又不适合对所有服务一刀切。这时给单个服务写一个适配器：在
`servers.json` 的条目里加一行 `"adapter": "mcps/<id>/index.ts"`，hub 就不再直接启动
`command`/`args`，而是启动这个适配器；适配器再启动真正的后端、双向转发 stdio，并按需改写消息。

```json
{
  "id": "bilibili",
  "command": "node",
  "args": ["dist/index.js"],
  "cwd": "/path/to/bilibili-api-node/mcp",
  "adapter": "mcps/bilibili/index.ts"
}
```

hub 传给适配器的环境变量：

| 变量 | 说明 |
| --- | --- |
| `MCP_ADAPTER_COMMAND` / `MCP_ADAPTER_ARGS` / `MCP_ADAPTER_CWD` / `MCP_ADAPTER_ENV` | 真正的后端命令、参数（JSON 数组）、工作目录、额外环境变量（JSON 对象） |
| `MCP_HUB_SERVER_ID` / `MCP_HUB_SESSION_ID` | 服务 id / 当前 MCP 会话 id |
| `MCP_HUB_HEADERS` | 打开该会话那次 HTTP 请求的请求头（JSON 对象） |

另外 hub 会把**每一次**转发请求的请求头放进 `params._meta["mcp-hub/headers"]`，适配器可以用它
覆盖会话快照（同一次会话里客户端换了 cookie 也能生效）。这些请求头不会写进控制台日志，也不会
出现在返回给客户端的响应里。

适配器只需要调用 `runAdapter()`：

```js
import { firstHeader, runAdapter } from '../_adapter.js';

runAdapter({
  spawnEnv(ctx) {                  // 启动后端前调整环境变量（可选）
    return { MEMORY_FILE_PATH: firstHeader(ctx, ['x-memory-file']) || '/tmp/memory.jsonl' };
  },
  transformMessage(message, ctx) {  // 客户端 -> 后端（可选）
    return message;
  },
  transformReply(message, ctx) {    // 后端 -> 客户端（可选）
    return message;
  }
});
```

Node 可以直接运行 `.ts`，所以适配器用 TypeScript 写、由 `node mcps/<id>/index.ts` 启动，不需要编译。

### 自带适配器

- `mcps/bilibili/index.ts`：bilibili 后端只在它自己的 HTTP 模式下读 `X-Bilibili-Cookie`，走 hub 时
  请求头到不了后端。适配器把请求头里的凭据送到后端的两处：
  - `tools/call` 的 `cookie` / `credential_path` 参数，逐请求生效（客户端自己传的参数优先），只对
    确实声明了该参数的工具生效；
  - 后端进程的 `BILIBILI_COOKIE` / `BILIBILI_CREDENTIAL_PATH` / `BILIBILI_SESSDATA` 等环境变量，
    在会话启动时固定，用来覆盖不接受凭据参数的 login 类工具（`bilibili_get_credential_status`
    也是靠它，并且它自己还接受 `cookie` 参数，所以逐请求的凭据也能生效）。

  识别的头包括 `X-Bilibili-Cookie`、`X-Cookie`、`Cookie`、`X-Bilibili-Credential-Path`、
  `Authorization: Bearer <cookie>` 以及 `X-Bilibili-Sessdata` 等分项头。
- `mcps/memory/index.ts`：`@modelcontextprotocol/server-memory` 只认 `MEMORY_FILE_PATH`，
  常见的 `X-API-KEY` 校验其实来自 `mcp-proxy`。适配器把两者补回来：
  - 设置 `MCP_HUB_MEMORY_API_KEY` 后，请求必须带 `X-API-KEY: <key>`（或
    `Authorization: Bearer <key>`），否则返回 `-32001`；不设置则完全不校验。
  - 请求头带 `X-Memory-File` / `X-Memory-User` / `X-Memory-Session` 时该会话使用独立记忆文件，
    默认仍是 `MEMORY_FILE_PATH`。`X-Memory-File` 只允许 `MCP_HUB_MEMORY_DIR`
    （默认取 `MEMORY_FILE_PATH` 所在目录）内的路径，越界会退回默认文件。

写适配器时注意：请求头里可能有凭据，不要在适配器里打印它们（适配器的 stderr 会进 hub 日志）。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MCP_HUB_PORT` | `8888` | 监听端口 |
| `MCP_HUB_HOST` | `0.0.0.0` | 监听地址 |
| `MCP_HUB_CONFIG` | `servers.json` | 服务列表配置文件路径 |
| `MCP_HUB_TOKEN` | 空 | 设置后 `/mcps/*` 需要 `Authorization: Bearer <token>`（控制台不受影响） |
| `MCP_HUB_ALLOWED_ORIGINS` | 空 | 允许的跨域 Origin，逗号分隔（同源请求始终允许） |
| `MCP_HUB_REQUIRE_SESSION` | 未设置 | 设为 `1` 时无 `Mcp-Session-Id` 的请求一律 `400` |
| `MCP_HUB_REQUEST_TIMEOUT_MS` | `60000` | 单个 JSON-RPC 请求超时 |
| `MCP_HUB_MAX_SESSIONS` | `32` | 并发 Streamable HTTP 会话上限（超出返回 `503`） |
| `MCP_HUB_SESSION_IDLE_MS` | `1800000` | 空闲会话回收时间（无打开 SSE 流时） |
| `MCP_HUB_RESUME_SESSION` | 未设置（开启） | 设为 `0` 关闭自动续会话：未知/过期的 `Mcp-Session-Id` 返回 `404` |
| `MCP_HUB_HANDSHAKE_CACHE` | `256` | 记住最近多少个 `initialize` 握手，续会话时用于重放 |
| `MCP_HUB_HEALTH_INTERVAL_MS` | `15000` | 服务稳定后的健康检查间隔 |
| `MCP_HUB_HEALTH_STARTUP_INTERVAL_MS` | `700` | 服务刚启动时的快速探活间隔 |
| `MCP_HUB_HEALTH_TIMEOUT_MS` | `3000` | 单次探活超时 |
| `MCP_HUB_SERVICE_STOP_GRACE_MS` | `4000` | 停止服务时 `SIGTERM` 到 `SIGKILL` 的宽限时间 |
| `MCP_HUB_SERVICE_RESTART_DELAY_MS` | `1200` | 崩溃后重新拉起的延迟 |
| `MCP_HUB_SERVICE_MAX_RESTARTS` | `5` | 5 分钟窗口内允许的重启次数上限 |
| `MCP_HUB_USAGE_INTERVAL_MS` | `60000` | 配了 `usagePath` 的服务读额度的间隔 |
| `MCP_HUB_USAGE_TIMEOUT_MS` | `5000` | 单次读额度的超时 |

## 安全

- 校验 `Origin`（防 DNS rebinding）：跨域浏览器请求默认拒绝，可用 `MCP_HUB_ALLOWED_ORIGINS` 放行。
- 需要鉴权时设置 `MCP_HUB_TOKEN`（作用于 `/mcps/*` 与 `/apps/*`；旧版 SSE 若用 `EventSource`
  需自行附带头）。服务自己的端口不受 hub 管辖，该保护需要服务自身提供。
- 只有 `"proxy": true` 的服务才经 hub 转发；`/apps/*` 转发时不改写上游响应头，上游的 CORS 等
  设置照旧生效。
- 默认监听 `0.0.0.0`，建议仅在可信网络使用，或设置 token。
- `/api/servers` 会返回服务配置，其中名字像密钥的 `env` 值（`*KEY*`/`*TOKEN*`/`*SECRET*` 等）
  以 `***` 返回；其余值仍是明文，别把明文密钥写进 `servers.json`。

## 测试

```bash
npm test          # node --test，无需第三方依赖
```

测试使用 `fixtures/fake-mcp.js`（最小 stdio MCP 服务）覆盖会话、SSE、鉴权、Origin 校验等行为，
`test/adapters.test.js` 用 `fixtures/fake-control-mcp.js` 验证适配器的头部注入与环境变量改写，
`test/resume.test.js` 验证会话过期 / 后端进程崩溃后的自动续会话与握手重放，
`test/services.test.js` 用 `fixtures/fake-service.js`（最小 HTTP 服务）验证启动器的托管、探活、
重启策略、`/apps/<id>/` 镜像转发与 `usagePath` 额度轮询（fixture 自带一个 `/v1/usage`）。

## 已知限制

- 未实现 2026-07-28 的 stateless 修订（该版本移除 `initialize` 握手与 `Mcp-Session-Id`）；
  当前后端 stdio 服务仍使用握手模型，客户端携带该版本会收到 `400` 与支持的版本列表。
- 会话之间相互隔离，每个会话会启动一个后端进程；空闲 30 分钟后自动回收。
- 续会话只重放 `initialize` 并换一个后端进程，进程内的运行时状态（缓存、已加载的数据）不会恢复；
  凭据与参数都在 HTTP 头里、本身接近 stateless 的服务不受影响。
- 托管服务随 hub 一起退出（hub 是它们的父进程），不会做成开机自启的守护进程管理器。
- `/apps/<id>/` 只转发 HTTP，不含 WebSocket 升级。
