# agentrouter-responses-shim sentry-fix

> **本项目由 [艺の公益站](https://ultrarouter.org/sign-up?aff=KnwD) 提供支持** ——
> 一个面向 Codex / Claude Code 的公益中转服务。

[agentrouter-responses-shim](https://www.npmjs.com/package/agentrouter-responses-shim) `2.0.1`
的本地补丁集，解决 **Codex（桌面版 / 新版 CLI）** 在 **AgentRouter 等「多资源池化」Responses
网关**下的三类长会话问题：嵌套密文导致的流中断、限流 429 无重试、请求图片超上限。

A patch set for `agentrouter-responses-shim@2.0.1` that strips **nested** `encrypted_content`
blocks, adds opt-in 429 retry / prefix routing / outbound proxy, and keeps only the newest N
images per request.

包含三个**可叠加**的补丁：

| 补丁 | 内容 |
|---|---|
| `sentry-fix-v1` | 递归清理嵌套 `encrypted_content`，修复 `invalid_encrypted_content` → `response.failed` 流中断 |
| `cursor-retry-v1` | `--retry-429` 429/5xx 自动重试（首字节前）、`--routes` 多上游前缀路由、`--proxy` 出站代理 |
| `image-limit-v1` | `--max-images N` 只保留最新 N 张图片，更早的替换为文本占位，避免网关「超过 50 张图」400 |

## 目录

- [症状](#症状)
- [根因](#根因)
- [修复内容（sentry-fix-v1）](#修复内容sentry-fix-v1)
- [修复内容（cursor-retry-v1）](#修复内容cursor-retry-v1429-重试--多上游路由--出站代理)
- [修复内容（image-limit-v1）](#修复内容image-limit-v1图片数量上限)
- [安装](#安装)
- [验证](#验证)
- [目录结构](#目录结构)
- [回滚](#回滚)
- [已知限制](#已知限制)
- [复现上游问题的最小步骤](#复现上游问题的最小步骤用于给上游提-issue)
- [鸣谢](#鸣谢)
- [License](#license)

## 症状

在 Codex 中与某个会话续聊（尤其涉及多智能体 / 长历史回放）时：

```
stream disconnected before completion: response.failed event received
```

抓取上游 SSE 可以看到真实错误：

```
event: error
data: {"type":"error","error":{"type":"invalid_request_error",
  "code":"invalid_encrypted_content",
  "message":"Encrypted function output content could not be decrypted or decoded.","param":null}}

event: response.failed
```

HTTP 层面是 `200`，失败发生在流内部，所以客户端只能看到「流中断」。Codex 会按退避策略
反复重试（6s → 12s → …），但每次都会失败。

## 根因

新版 Codex 协议会把部分内容以**加密块**的形式放进历史条目里（Fernet 格式，特征前缀
`gAAAAA...`），例如多智能体消息：

```json
{
  "type": "agent_message",
  "author": "/root/some-agent",
  "recipient": "/root",
  "content": [
    { "type": "input_text", "text": "Message Type: MESSAGE\n...\nPayload:\n" },
    { "type": "encrypted_content", "encrypted_content": "gAAAAAB..." }
  ]
}
```

这些密文**与创建它的上游资源绑定**。AgentRouter 这类网关背后是一个 Azure 资源池，
同一个会话的相邻请求可能落在不同资源上；一旦回放的历史里带着「别的资源」生成的密文，
上游解密失败 → `invalid_encrypted_content` → 流被掐断。

`agentrouter-responses-shim@2.0.1` 已经会清理顶层的 reasoning 密文与条目 ID，但它
**只检查 `item.encrypted_content`，不扫描 `content[]` / `output[]` 等嵌套位置**，
于是这类藏在嵌套结构里的密文被原样放行，问题依旧。

## 修复内容（sentry-fix-v1）

对 `agentrouter-responses-shim@2.0.1` 的两处修改（共 +52 / -1 行）：

| 文件 | 修改 |
|---|---|
| `src/sanitize.mjs` | 新增 `hasNestedEncrypted()` / `removeNestedEncrypted()`：递归探测并清理**任意深度**的 `encrypted_content`；对形如 `{"type":"encrypted_content",...}` 的数组元素整块移除。保持输入不可变（先探测，需要时才 `structuredClone`）。新增计数 `nested_encrypted_blocks_removed`。 |
| `src/server.mjs` | `changed` 判定纳入 `nested_encrypted_blocks_removed > 0`，否则只清出嵌套密文时不会重新序列化请求体。 |

**语义说明**：被删除的只是密文块本身；所在条目的明文外壳（如 `agent_message` 的
`Message Type: ... Payload:` 头部）会保留，对话可以正常继续。由于这些密文在池化网关下
被证明不可跨资源解密，**删除是客户端侧唯一可行的修复路径**。

## 修复内容（cursor-retry-v1：429 重试 / 多上游路由 / 出站代理）

在 `sentry-fix-v1` 基础上新增 3 个可选能力（默认全部关闭，不传参数时行为与原版一致）：

| 参数 | 说明 |
|---|---|
| `--retry-429 N` | 遇到可重试状态码时，在**首字节写出前**自动重试，最多 N 次（默认 0 = 关闭） |
| `--retry-statuses LIST` | 可重试状态码，逗号分隔或区间，默认 `429,502,503,504`；例如 `404,429,502-504` |
| `--retry-stream` | 额外重试「HTTP 200 但首帧就是瞬时失败」的流（如 `Concurrency limit exceeded`） |
| `--retry-stream-hold-ms N` | 等待首个内容事件的上限，默认 6000 |
| `--retry-backoff-ms N` | 首次退避毫秒数，每次翻倍，默认 30000 |
| `--retry-max-wait-ms N` | 退避上限，默认 180000 |
| `--routes FILE` | 前缀路由文件，一个 shim 进程服务多个上游（多 provider 模式） |
| `--proxy URL` | 出站 HTTP(S) 代理（CONNECT 隧道），可按路由单独配置 |

对应环境变量：`SHIM_RETRY_429`、`SHIM_RETRY_STATUSES`、`SHIM_RETRY_STREAM`、
`SHIM_RETRY_STREAM_HOLD_MS`、`SHIM_RETRY_BACKOFF_MS`、`SHIM_RETRY_MAX_WAIT_MS`、
`SHIM_ROUTES_FILE`、`SHIM_PROXY`。

### 重试行为

- 只重试 `--retry-statuses` 列出的状态码，且必须发生在**第一个响应字节之前**
  （Azure/OpenAI 的限流在请求入口直接返回 429，正是这个窗口）；
- **瞬时传输错误同样重试**：`ENOTFOUND`、`EAI_AGAIN`、`ECONNRESET`、`ECONNREFUSED`、
  `ETIMEDOUT`、`EPROTO`（TLS 握手被重置）等（中继域名轮换时 DNS 会短暂掉线，此前会立刻 502）；
  日志事件为 `retry_connect`，重试次数与退避同上；
- **401/403 也按响应体判断**：若错误信息属于网关的瞬时判定
  （`This account only allows Codex official clients`、`unauthorized client detected` 等），
  同样重试（日志事件 `retry_auth`）；真正的鉴权失败（`invalid api key` 等）立即透传；
- **上游超时归类为 `ETIMEDOUT` 并可重试**：此前超时直接 502，现在按退避重试；
- **组级限流（`group requests-per-minute limit exceeded`）要按"分钟"退避**：
  5s/10s 这类短退避跨不过限流窗口，还会额外消耗配额。推荐生产值：
  `--retry-429 3 --retry-backoff-ms 20000 --retry-max-wait-ms 60000 --timeout 45000`
  （等待 20s → 40s → 60s），并把 cc-switch 的 `streaming_first_byte_timeout` 提到 **300s**，
  否则总重试时长会被客户端首字节超时先掐断；
- 实测：一次真实请求经历 `429 → 20s → 503 → 40s → 200`（总 72s），客户端全程无感；
- **流式响应有独立的空闲预算**（`--stream-idle-timeout-ms`，默认 600000）：
  推理模型常在首令牌前静默数十秒，若沿用较短的 `--timeout` 会被误杀，
  客户端看到的就是 `stream disconnected ... error decoding response body`；
  本补丁在收到响应头后把 socket 空闲超时切换到该长预算；
- **上游中途断流时用 SSE 错误帧收尾**，而不是直接 destroy 连接：
  截断的 chunked 流会让客户端报 `error decoding response body`，
  干净收尾后客户端读到的是标准 `event: error`，可正常重试且不会误判为网络故障；
- 建议的生产值：`--retry-statuses 404,429,502,503,504,520-527,530`
  （404：网关偶发误报；52x/530：Cloudflare 源站瞬断）；配合 `--retry-stream` 使用；
- 退避为指数翻倍（8s → 16s → 32s → …），受 `--retry-max-wait-ms` 封顶；
- 若上游返回 `Retry-After` 头（秒数或 HTTP 日期），**优先按它等待**；
- 每次重试记录一条 `retry_429` 日志事件（含 attempt / 等待时长 / 上游地址）；
- 客户端首字节超时（如 cc-switch 默认 120s）会限制总重试窗口，参数需与之匹配。

### 网关强制字段补全（`--ensure-prompt-cache-key`）

部分中继网关的 `/v1/responses` **强制要求 `prompt_cache_key`**，缺失时直接返回

```
400 {"error":{"message":"prompt_cache_key is required","type":"new_api_error",
     "code":"invalid_responses_request"}}
```

（实测：anyrouter.top 即如此）。Codex 通常会带这个字段，但某些请求/客户端会漏。
开启该开关后，shim 在转发前检查请求体，缺失时用 `session-id` / `thread-id`
请求头（或随机 UUID）补上，并在日志里标记 `prompt_cache_key_injected: true`。

> 该网关同时存在 TLS 握手被重置的情况（`unexpected EOF during handshake`），
> 可在 `routes.json` 里为该前缀单独挂代理：
> `{ "any": { "upstream": "https://anyrouter.top/v1", "proxy": "http://127.0.0.1:10808" } }`

### 主用/备用自动切换（`fallback` + 熔断）

路由条目可选配一个备用上游；主用连续失败达到阈值后自动切到备用，
冷却期结束再"半开"探测主用，成功即切回：

```json
{
  "cf": {
    "upstream": "https://ai.chatflowsai.com/v1",
    "fallback": { "upstream": "https://anyrouter.top/v1", "proxy": "http://127.0.0.1:10808" },
    "failover": { "failures": 3, "cooldownMs": 120000 }
  }
}
```

行为细节：
- **失败计数**：状态码重试、传输重试、流内错误重试都计一次；
- **熔断**：连续失败达到 `failures`（默认 3）→ 打开熔断，本请求剩余尝试直接走备用；
- **快速降级**：在主用上重试时退避被压到最多 2 秒，避免"等 60 秒才切换"；
- **每路由超时/重试预算**：慢上游（长 prompt、首字节几十秒）可单独放大
  `timeoutMs`，并减少 `retries`，避免"45 秒首字节超时"把大请求误杀成 502：
  ```json
  "cf": { "upstream": "https://...", "timeoutMs": 130000, "retries": 1, "backoffMs": 5000 }
  ```
  总预算需小于客户端首字节超时（cc-switch 默认 300s）；

- **冷却后半开**：`cooldownMs`（默认 120000）后先试一次主用，成功则清零并切回；
- **备用成功不治愈主用**：只有主用成功才重置计数（避免备用成功掩盖主用故障）；
- 日志事件：`failover_open` / `failover_use_fallback` / `failover_half_open` /
  `failover_use_primary` / `failover_reset`，请求日志新增 `route` 字段。

### 流内错误重试（`--retry-stream`）

有些网关不返回 HTTP 错误，而是先给 `200`，再在 SSE 里吐一条失败事件，例如：

```
event: response.failed
data: {"type":"response.failed","response":{"status":"failed",
  "error":{"message":"Concurrency limit exceeded for account, please retry later"}}}
```

客户端只会看到 `stream disconnected before completion`。开启 `--retry-stream` 后：

- shim **暂不把响应头写给客户端**，先缓冲，直到出现第一个「内容事件」
  （`output_text.delta` / `output_item.added` / `completed` 等）；
- 若在此之前出现**瞬时**错误（并发限制 / 限流 / 过载 / `retry later`），丢弃本次响应并重试；
- 若出现的是**永久性**错误（无效 key、客户端不被允许、参数错误），**不重试**，原样透传；
- 为避免慢首 token 被误判成卡死，最多只压 `--retry-stream-hold-ms`（默认 6s），
  超时即放行已缓冲内容。

重试日志为 `{"event":"retry_stream","attempt":1,"reason":"transient_stream_error",...}`。
只识别 SSE 行首的规范事件标记，普通正文里出现 "event: error" 字样不会被误判。

### 多上游路由示例

`routes.json`：

```json
{
  "ga": { "upstream": "https://gateway-a.example.com/v1" },
  "gb": { "upstream": "https://gateway-b.example.com/v1", "proxy": "http://127.0.0.1:7890" }
}
```

启动与使用：

```bash
agentrouter-shim --routes routes.json --retry-429 4 --retry-backoff-ms 8000 --retry-max-wait-ms 30000 --port 18080
```

此时 `POST http://127.0.0.1:18080/ga/v1/responses` 会转发到
`https://gateway-a.example.com/v1/responses`（前缀被剥离、`/v1` 自动归一）。
各 provider 的 `base_url` 填 `http://127.0.0.1:18080/<前缀>/v1` 即可。

> `--proxy` 走 undici（ProxyAgent，支持 h2），需要额外安装：
> `npm install -g undici`。不装则仅在不使用 `--proxy` 时正常工作。

## 修复内容（image-limit-v1：图片数量上限）

**症状**：长会话（尤其带屏幕截图 / computer-use 工具）续聊时报：

```
HTTP 400: Exceeded maximum number of images (50) allowed in the request
```

**根因**：Codex 会把历史里所有截图（工具输出中的 `{"type":"input_image",...}` 块）
原样回放；上游网关对单次请求的图片数量有硬上限（常见 50），超限即 400。
这属于**请求内容问题**，与密文 / 重试无关，shim 之前不会处理。

**修复**：新增 `--max-images N`（环境变量 `SHIM_MAX_IMAGES`，默认 0 = 关闭）。
启用后 shim 在转发前扫描 `input` 里所有图片块（含 `content[]`、`output[]` 深层嵌套），
**只保留最新的 N 张**，更早的整块替换为
`{"type":"input_text","text":"[older image omitted to respect the upstream image limit]"}`
（文件名 / 工具输出结构不变，tool call 配对不受影响）。

- 保持 copy-on-write：未超限时不复制、不修改原请求；
- 日志中新增 `images_removed` / `images_kept` 计数与 `max_images` 启动参数，
  便于观察是否触发裁剪；
- 建议值：上限 50 时取 **45**（留 5 张余量；统计的是图片块总数，是上游计数的超集，
  45 一定 ≤ 50）。若上游随后新增其他图片形态导致仍超限，可下调到 30。

重试 / 路由 / 图片限制三者可叠加，例如：

```bash
agentrouter-shim --routes routes.json --retry-429 4 --retry-backoff-ms 8000 --retry-max-wait-ms 30000 --max-images 45 --port 18080 --log-usage
```

## 安装

**前置**：已全局安装 `agentrouter-responses-shim@2.0.1`

```bash
npm install -g agentrouter-responses-shim
```

### 方式 A：一键脚本（Windows）

```powershell
pwsh -File .\scripts\apply.ps1
```

脚本会：定位 `npm root -g` → 备份原文件为 `*.orig-2.0.1` → 覆盖 `src/` 四个文件
（`sanitize.mjs`、`server.mjs`、`retry-cli.mjs`、`retry-routing.mjs`）与
`bin/agentrouter-shim.mjs` → 如果 shim 正在运行则重启它（配合
`scripts/supervise-shim.mjs` 守护会自动拉起）。

### 方式 B：手动覆盖

把 `src-patched/` 下的四个文件复制到：

```
$(npm root -g)/agentrouter-responses-shim/src/
```

再把 `bin-patched/agentrouter-shim.mjs` 复制到：

```
$(npm root -g)/agentrouter-responses-shim/bin/
```

然后重启 shim。

> `bin/agentrouter-shim.mjs` 必须一起换：它负责把 `--max-images` 等新参数并入配置；
> 旧 bin 用 `parseArgs(strict: true)`，遇到未声明参数会直接报错。

### 方式 C：git apply

```bash
cd "$(npm root -g)/agentrouter-responses-shim"
git apply /path/to/patches/sentry-fix-v1.patch
git apply /path/to/patches/cursor-retry-v1.patch   # 可选：重试/路由/代理
git apply /path/to/patches/image-limit-v1.patch    # 可选：图片数量上限
git apply /path/to/patches/retry-stream-v1.patch   # 可选：可配置状态码 + 流内错误重试
git apply /path/to/patches/retry-fixes-v1.patch    # 可选：传输错误重试 + CLI 参数透传修复
git apply /path/to/patches/retry-fixes-v2.patch    # 可选：401/403 瞬时判定重试 + 超时归类
git apply /path/to/patches/retry-fixes-v3.patch    # 可选：流空闲预算 + 中途断流干净收尾
git apply /path/to/patches/retry-fixes-v4.patch    # 可选：prompt_cache_key 自动补全
git apply /path/to/patches/retry-fixes-v5.patch    # 可选：500 容量错误 + TLS EPROTO 重试
git apply /path/to/patches/retry-fixes-v6.patch    # 可选：主用/备用自动切换（fallback + 熔断）
git apply /path/to/patches/retry-fixes-v7.patch    # 可选：每路由超时/重试预算
```

### 验证补丁生效

重启 shim 后，发送任意一条带历史回放的请求，观察 shim 日志
（`--log-usage` 输出到 stderr）中是否出现 `nested_encrypted_blocks_removed` 字段。

## 验证

1. **单元验证**（`examples/demo.mjs`，无网络、无密钥）：

   ```bash
   node examples/demo.mjs
   ```

   覆盖：嵌套密文移除计数、明文块保留、输入对象不可变、原有 reasoning/ID 清理逻辑回归。

2. **A/B 对照**（同一最小请求，直连上游）：

   | 请求 | 结果 |
   |---|---|
   | 带 1 个真实 `encrypted_content` 块 | 约 1.3s 即 `response.failed` + `invalid_encrypted_content` |
   | 同请求去掉该密文块 | 正常返回 `200` 流式响应 |

3. **生产验证**：10 万+ token 的真实长会话连续多轮，均 `200` 完成；
   shim 日志中每条请求可见：

   ```json
   {"path":"/responses","sanitized":{"reasoning_items_removed":17,"item_ids_removed":80,
    "nested_encrypted_blocks_removed":22},"usage":{"input_tokens":117414,...},"status":200}
   ```

4. **429 重试验证**（cursor-retry-v1）：

   - 合成测试：假上游连续返回 2 次 `429`（带 `Retry-After: 1`）→ shim 自动重试 →
     第 3 次请求 `200`，客户端无感；日志出现两条 `retry_429` 事件（attempt 1/2，等待 1000ms）。
   - 生产验证：上游真实返回 `429` 时，日志可见
     `{"event":"retry_429","upstream_status":429,"attempt":1,"wait_ms":8000,...}`，
     退避序列 8s → 16s → 30s → 30s。

5. **传输错误与 CLI 参数验证**(retry-fixes-v1):

   - `--retry-statuses` / `--retry-stream` / `--retry-stream-hold-ms` 三个 CLI 参数
     在 retry-stream-v1 中未并入 `overrides`，导致命令行开启无效（仅环境变量有效）；
     本补丁补上透传，并新增瞬时传输错误重试（日志事件 `retry_connect`）；
   - 实测 5/5：上游 404×2 → 200、并发限制 SSE 帧×2 → 200（客户端只见成功流）、
     连接重置×2 → 200、403 立即透传（不重试）、DNS `ENOTFOUND` 重试 3 次后 502；
   - 生产对照:`api666.zzzcoding.org` DNS 掉线期间日志出现 4 条 `retry_connect`，之后返回 502。

6. **401/403 瞬时判定验证**（retry-fixes-v2）：

   - 上游连续 2 次返回 `403 This account only allows Codex official clients` → 重试 2 次后 `200`；
   - 上游返回 `403 invalid api key` → **不重试**，立即透传（真鉴权失败不能被掩盖）；
   - 生产对照：`api666.zzzcoding.org` 缺少 `x-codex-*` 头时返回 403；
     带完整 Codex Desktop 头时正常 200（网关按请求头识别"官方客户端"）。

7. **流空闲与断流收尾验证**（retry-fixes-v3，2/2 通过）：

   - 上游发送 `response.created` 后静默 6 秒再输出：`--timeout 2s` +
     `--stream-idle-timeout-ms 15s` 时**不被误杀**，客户端完整收到后续事件；
   - 上游中途销毁 socket：客户端收到完整流（含 `event: error` 帧），
     不再出现 chunked 截断导致的 `error decoding response body`；
   - 生产对照：`chatflowsai` 曾出现 24 条 `completed=false`（其中 8 条
     `upstream_stream_error`），即 45s 空闲预算误杀长推理流；
     修复后同链路请求 `completed=true`（30.6s，84KB SSE 完整返回）。

8. **prompt_cache_key 补全验证**（retry-fixes-v4）：

   - anyrouter.top 不带该字段 → `400 prompt_cache_key is required`；带字段 → `200`（5.6s）；
   - 经 shim（`--ensure-prompt-cache-key` + 该前缀走代理）→ 缺字段也返回 `200`
     （日志 `prompt_cache_key_injected: true`，3.9s）。

9. **主用/备用切换验证**（retry-fixes-v6，4/4 通过）：

   - 主用连续 500 → 熔断 → 自动切备用（1.2s 内完成）；
   - 熔断期内请求直接走备用，不再试探主用；
   - 冷却期（测试用 1.5s）后半开探测主用，主用恢复即切回；
   - 备用成功不会重置主用熔断状态；
   - 生产：`/cf` 主用 chatflowsai 实测 `200`（3.0s），日志 `route:"/cf"`、
     `failover_use_primary`，无降级。

10. **慢上游超时预算验证**（retry-fixes-v7）：

    - 现象：chatflowsai `/v1/responses` 小请求约 27s、大 prompt 常 60s+ 才回首字节；
      全局 `--timeout 45000` 会把它误杀成 502，然后降级到同样慢的 any → 连续 502；
    - 修复：`cf`/`any` 路由单独设 `timeoutMs: 130000, retries: 1, backoffMs: 5000`
      （最坏 130+5+130 ≈ 265s，仍在 cc-switch 300s 首字节窗口内）；
    - 实测：全链路 `15721 → shim → chatflowsai` `200`，耗时 32s，日志 `route:"/cf"`、
      `failover_use_primary`。

11. **图片上限验证**（image-limit-v1）：

   - 单元验证：`node examples/image-limit.mjs`（60 张图 → 保留最新 30 张，10 项检查全过）；
   - 端到端：假上游收到 60 张图的请求 → shim 裁剪后上游实收 30 张 → `200`
     （`{"event":"listening",...,"max_images":45}`）；
   - 生产对照：未打补丁时上游返回
     `400 {"code":null,"message":"Exceeded maximum number of images (50) allowed in the request"}`；
     打补丁并启用 `--max-images 45` 后同类型长会话恢复正常（60 张进 → 上游实收 45 张 → 200）。

## 目录结构

```
├── patches/
│   ├── sentry-fix-v1.patch     # 相对 npm 2.0.1 原版的标准 unified diff
│   ├── cursor-retry-v1.patch   # 在 sentry-fix-v1 之上叠加（429 重试/路由/代理）
│   ├── image-limit-v1.patch    # 在 cursor-retry-v1 之上叠加（图片数量上限）
│   ├── retry-stream-v1.patch   # 在 image-limit-v1 之上叠加（可配置状态码 + 流内错误重试）
│   ├── retry-fixes-v1.patch    # 在 retry-stream-v1 之上叠加（传输错误重试 + CLI 参数透传修复）
│   ├── retry-fixes-v2.patch    # 在 retry-fixes-v1 之上叠加（401/403 瞬时判定重试 + 超时归类）
│   ├── retry-fixes-v3.patch    # 在 retry-fixes-v2 之上叠加（流空闲预算 + 中途断流干净收尾）
│   ├── retry-fixes-v4.patch    # 在 retry-fixes-v3 之上叠加（prompt_cache_key 自动补全）
│   ├── retry-fixes-v5.patch    # 在 retry-fixes-v4 之上叠加（500 容量错误与 TLS EPROTO 也重试）
│   ├── retry-fixes-v6.patch    # 在 retry-fixes-v5 之上叠加（主用/备用自动切换 + 熔断）
│   └── retry-fixes-v7.patch    # 在 retry-fixes-v6 之上叠加（每路由超时/重试预算）
├── src-patched/
│   ├── sanitize.mjs            # 打好补丁的完整文件（可直接覆盖）
│   ├── server.mjs              # 打好补丁的完整文件（可直接覆盖）
│   ├── retry-cli.mjs           # cursor-retry：CLI 参数解析
│   └── retry-routing.mjs       # cursor-retry：路由 / 重试 / 代理实现
├── bin-patched/
│   └── agentrouter-shim.mjs    # bin 入口（把 maxImages 并入 config）
├── scripts/
│   ├── apply.ps1               # Windows：自动定位全局包、备份、覆盖、重启
│   ├── restore.ps1             # 回滚到补丁前
│   └── supervise-shim.mjs      # 守护进程模板：崩溃自动拉起（推荐配合开机自启）
├── examples/
│   ├── demo.mjs                # sentry-fix 单元验证
│   └── image-limit.mjs         # image-limit 单元验证
└── LICENSE                     # MIT（来自原包，Copyright (c) 2026 stevenarai）
```

## 回滚

```powershell
pwsh -File .\scripts\restore.ps1
```

或直接 `npm install -g agentrouter-responses-shim` 重装覆盖，再重启 shim。

## 已知限制

- 补丁只作用于客户端可见的密文块；**被删密文的实际内容会从上下文中丢失**——
  这是池化网关下的固有限制，无法避免。
- `npm install -g` 升级/重装该包会覆盖补丁，需重新应用（上游版本差异较大时，
  建议移植逻辑而不是整文件覆盖）。
- 本补丁针对 `agentrouter-responses-shim@2.0.1` 编写并验证；其他版本需自行核对。
- 429 重试只在**流式响应首字节之前**有效；流已经开始后无法重试（协议限制）。
  `--retry-stream` 把窗口前移到「首个内容事件之前」，但一旦有内容写出，同样无法回退。
- 流内重试会短暂压住响应头（默认最多 6s）。若上游首 token 很慢，
  客户端在这段时间内看不到 `response.created`，属预期行为。
  总重试时长还受客户端首字节超时约束（例如 cc-switch 默认 120s），
  `--retry-429` / 退避参数需按实际超时预算调整。
- `--proxy` 依赖 undici（`npm install -g undici`），未安装时不要使用该参数。
- `--max-images` 裁掉的是历史图片的**内容**，只留一行占位文本；模型不会记得那些截图。

## 复现上游问题的最小步骤（用于给上游提 issue）

1. 准备一个 `agent_message` 条目，`content` 里放一个任意 `gAAAAA` 前缀的
   `{"type":"encrypted_content",...}` 块（真实密文块可由 Codex 长会话抓包获得）；
2. 将该条目连同一条普通 `message` 发给池化网关的 `POST /v1/responses`；
3. 请求首包后即收到 `response.failed` + `invalid_encrypted_content`；
4. 删除该密文块后同请求正常返回。

## 鸣谢

- 原项目：[agentrouter-responses-shim](https://www.npmjs.com/package/agentrouter-responses-shim)
  （stevenarai），本仓库是其在 MIT 许可下针对上述场景的补丁。
- 公益支持：[艺の公益站](https://ultrarouter.org/sign-up?aff=KnwD)
- 友情链接：[LINUX DO](https://linux.do/)

## License

[MIT](LICENSE) © 2026 stevenarai（原包）；
本仓库修改部分同样以 MIT 发布。

