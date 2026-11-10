# agentrouter-responses-shim sentry-fix

> 修复 **Codex(桌面版 / 新版 CLI)** 在 **AgentRouter** 等「多资源池化」Responses 网关下,
> 长会话回放时出现的 `stream disconnected before completion: response.failed event received`
> 流中断问题。
>
> A patch for [`agentrouter-responses-shim`](https://www.npmjs.com/package/agentrouter-responses-shim)
> 2.0.1 that also strips **nested** `encrypted_content` blocks, fixing
> `invalid_encrypted_content` → `response.failed` stream aborts on pooled
> OpenAI-Responses-compatible gateways (e.g. AgentRouter).

本仓库包含两个可叠加的本地补丁:

| 补丁 | 内容 |
|---|---|
| `sentry-fix-v1` | 递归清理嵌套 `encrypted_content`,修复 `invalid_encrypted_content` → `response.failed` 流中断 |
| `cursor-retry-v1` | `--retry-429` 429/5xx 自动重试(首字节前)、`--routes` 多上游前缀路由、`--proxy` 出站代理 |

---

## 症状

在 Codex 中与某个会话续聊(尤其涉及多智能体 / 长历史回放)时:

```
stream disconnected before completion: response.failed event received
```

抓取上游 SSE 可以看到真实错误:

```
event: error
data: {"type":"error","error":{"type":"invalid_request_error",
  "code":"invalid_encrypted_content",
  "message":"Encrypted function output content could not be decrypted or decoded.","param":null}}

event: response.failed
```

HTTP 层面是 `200`,失败发生在流内部,所以客户端只能看到「流中断」。Codex 会按退避策略
反复重试(6s → 12s → …),但每次都会失败。

## 根因

新版 Codex 协议会把部分内容以**加密块**的形式放进历史条目里(Fernet 格式,特征前缀
`gAAAAA...`),例如多智能体消息:

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

这些密文**与创建它的上游资源绑定**。AgentRouter 这类网关背后是一个 Azure 资源池,
同一个会话的相邻请求可能落在不同资源上;一旦回放的历史里带着「别的资源」生成的密文,
上游解密失败 → `invalid_encrypted_content` → 流被掐断。

`agentrouter-responses-shim@2.0.1` 已经会清理顶层的 reasoning 密文与条目 ID,但它
**只检查 `item.encrypted_content`,不扫描 `content[]` / `output[]` 等嵌套位置**,
于是这类藏在嵌套结构里的密文被原样放行,导致问题依旧。

## 修复内容(sentry-fix-v1)

对 `agentrouter-responses-shim@2.0.1` 的两处修改(共 +52 / -1 行):

| 文件 | 修改 |
|---|---|
| `src/sanitize.mjs` | 新增 `hasNestedEncrypted()` / `removeNestedEncrypted()`:递归探测并清理**任意深度**的 `encrypted_content`;对形如 `{"type":"encrypted_content",...}` 的数组元素整块移除。保持输入不可变(先探测,需要时才 `structuredClone`)。新增计数 `nested_encrypted_blocks_removed`。 |
| `src/server.mjs` | `changed` 判定纳入 `nested_encrypted_blocks_removed > 0`,否则只清出嵌套密文时不会重新序列化请求体。 |

**语义说明**:被删除的只是密文块本身;所在条目的明文外壳(如 `agent_message` 的
`Message Type: ... Payload:` 头部)会保留,对话可以正常继续。由于这些密文在池化
网关下被证明不可跨资源解密,**删除是客户端侧唯一可行的修复路径**。

## 修复内容(cursor-retry-v1:429 重试 / 多上游路由 / 出站代理)

在 `sentry-fix-v1` 基础上新增 3 个可选能力(默认全部关闭,不传参数时行为与原版一致):

| 参数 | 说明 |
|---|---|
| `--retry-429 N` | 遇到 **429/502/503/504** 时,在**首字节写出前**自动重试,最多 N 次(默认 0 = 关闭) |
| `--retry-backoff-ms N` | 首次退避毫秒数,每次翻倍,默认 30000 |
| `--retry-max-wait-ms N` | 退避上限,默认 180000 |
| `--routes FILE` | 前缀路由文件,一个 shim 进程服务多个上游(多 provider 模式) |
| `--proxy URL` | 出站 HTTP(S) 代理(CONNECT 隧道),可按路由单独配置 |

对应环境变量:`SHIM_RETRY_429`、`SHIM_RETRY_BACKOFF_MS`、`SHIM_RETRY_MAX_WAIT_MS`、
`SHIM_ROUTES_FILE`、`SHIM_PROXY`。

### 重试行为

- 只重试 **429 / 502 / 503 / 504**,且必须发生在**第一个响应字节之前**
  (Azure/OpenAI 的限流在请求入口直接返回 429,正是这个窗口);
- 退避为指数翻倍(8s → 16s → 32s → …),受 `--retry-max-wait-ms` 封顶;
- 若上游返回 `Retry-After` 头(秒数或 HTTP 日期),**优先按它等待**;
- 每次重试记录一条 `retry_429` 日志事件(含 attempt/等待时长/上游地址);
- 客户端首字节超时(如 cc-switch 默认 120s)会限制总重试窗口,参数需与之匹配。

### 多上游路由示例

`routes.json`:

```json
{
  "ga": { "upstream": "https://gateway-a.example.com/v1" },
  "gb": { "upstream": "https://gateway-b.example.com/v1", "proxy": "http://127.0.0.1:7890" }
}
```

启动与使用:

```bash
agentrouter-shim --routes routes.json --retry-429 4 --retry-backoff-ms 8000 --retry-max-wait-ms 30000 --port 18080
```

此时 `POST http://127.0.0.1:18080/ga/v1/responses` 会转发到
`https://gateway-a.example.com/v1/responses`(前缀被剥离、`/v1` 自动归一)。
各 provider 的 base_url 填 `http://127.0.0.1:18080/<前缀>/v1` 即可。

> `--proxy` 走 undici(ProxyAgent,支持 h2),需要额外安装:
> `npm install -g undici`。不装则仅在不使用 `--proxy` 时正常工作。

## 验证

1. **单元验证**(`examples/demo.mjs`,无网络、无密钥):

   ```bash
   node examples/demo.mjs
   ```

   覆盖:嵌套密文移除计数、明文块保留、输入对象不可变、原有 reasoning/ID 清理逻辑回归。

2. **A/B 对照**(同一最小请求,直连上游):

   | 请求 | 结果 |
   |---|---|
   | 带 1 个真实 `encrypted_content` 块 | 约 1.3s 即 `response.failed` + `invalid_encrypted_content` |
   | 同请求去掉该密文块 | 正常返回 `200` 流式响应 |

3. **生产验证**:10 万+ token 的真实长会话连续多轮,均 `200` 完成;
   shim 日志中每条请求可见:

   ```json
   {"path":"/responses","sanitized":{"reasoning_items_removed":17,"item_ids_removed":80,
    "nested_encrypted_blocks_removed":22},"usage":{"input_tokens":117414,...},"status":200}
   ```

4. **429 重试验证**(cursor-retry-v1):

   - 合成测试:假上游连续返回 2 次 `429`(带 `Retry-After: 1`)→ shim 自动重试 →
     第 3 次请求 `200`,客户端无感;日志出现两条 `retry_429` 事件(attempt 1/2,等待 1000ms)。
   - 生产验证:上游真实返回 `429` 时,日志可见
     `{"event":"retry_429","upstream_status":429,"attempt":1,"wait_ms":8000,...}`,
     退避序列 8s → 16s → 30s → 30s。

## 目录结构

```
├── patches/
│   ├── sentry-fix-v1.patch     # 相对 npm 2.0.1 原版的标准 unified diff
│   └── cursor-retry-v1.patch   # 在 sentry-fix-v1 之上叠加(429 重试/路由/代理)
├── src-patched/
│   ├── sanitize.mjs            # 打好补丁的完整文件(可直接覆盖)
│   ├── server.mjs              # 打好补丁的完整文件(可直接覆盖)
│   ├── retry-cli.mjs           # cursor-retry:CLI 参数解析
│   └── retry-routing.mjs       # cursor-retry:路由 / 重试 / 代理实现
├── scripts/
│   ├── apply.ps1               # Windows:自动定位全局包、备份、覆盖、重启
│   └── restore.ps1             # 回滚到补丁前
├── examples/
│   └── demo.mjs                # 单元验证脚本(node examples/demo.mjs)
└── LICENSE                     # MIT(来自原包,Copyright (c) 2026 stevenarai)
```

## 安装 / 应用补丁

**前置**:已全局安装 `agentrouter-responses-shim@2.0.1`

```bash
npm install -g agentrouter-responses-shim
```

### 方式 A:一键脚本(Windows)

```powershell
pwsh -File .\scripts\apply.ps1
```

脚本会:定位 `npm root -g` → 备份原文件为 `*.orig-2.0.1` → 覆盖 `src/` 四个文件
(`sanitize.mjs`、`server.mjs`、`retry-cli.mjs`、`retry-routing.mjs`)→
如果 shim 正在运行则重启它(配合守护脚本会自动拉起)。

### 方式 B:手动覆盖

把 `src-patched/` 下的四个文件复制到:

```
$(npm root -g)/agentrouter-responses-shim/src/
```

然后重启 shim。

### 方式 C:git apply

```bash
cd "$(npm root -g)/agentrouter-responses-shim"
git apply /path/to/patches/sentry-fix-v1.patch
git apply /path/to/patches/cursor-retry-v1.patch   # 可选:429 重试/路由/代理
```

### 验证补丁生效

重启 shim 后,发送任意一条带历史回放的请求,观察 shim 日志
(`--log-usage` 输出到 stderr)中是否出现 `nested_encrypted_blocks_removed` 字段。

## 回滚

```powershell
pwsh -File .\scripts\restore.ps1
```

或直接 `npm install -g agentrouter-responses-shim` 重装覆盖,再重启 shim。

## 已知限制

- 补丁只作用于客户端可见的密文块;**被删密文的实际内容会从上下文中丢失**——
  这是池化网关下的固有限制,无法避免。
- `npm install -g` 升级/重装该包会覆盖补丁,需重新应用(上游版本差异较大时,
  建议移植逻辑而不是整文件覆盖)。
- 本补丁针对 `agentrouter-responses-shim@2.0.1` 编写并验证;其他版本需自行核对。
- 429 重试只在**流式响应首字节之前**有效;流已经开始后无法重试(协议限制)。
  总重试时长还受客户端首字节超时约束(例如 cc-switch 默认 120s),
  `--retry-429`/退避参数需按实际超时预算调整。
- `--proxy` 依赖 undici(`npm install -g undici`),未安装时不要使用该参数。

## 复现上游问题的最小步骤(用于给上游提 issue)

1. 准备一个 `agent_message` 条目,`content` 里放一个任意 `gAAAAA` 前缀的
   `{"type":"encrypted_content",...}` 块(真实密文块可由 Codex 长会话抓包获得);
2. 将该条目连同一条普通 `message` 发给池化网关的 `POST /v1/responses`;
3. 请求首包后即收到 `response.failed` + `invalid_encrypted_content`;
4. 删除该密文块后同请求正常返回。

## 鸣谢

- 原项目:[agentrouter-responses-shim](https://www.npmjs.com/package/agentrouter-responses-shim)
  (stevenarai),本仓库是其在 MIT 许可下针对上述场景的补丁。
- 友情链接:[LINUX DO](https://linux.do/)

## License

[MIT](LICENSE) © 2026 stevenarai(原包);
本仓库修改部分同样以 MIT 发布。
