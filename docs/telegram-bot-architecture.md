# Telegram Bot 架构详解

本文档解释 Telegram Bot 的工作原理，以及 mini-claw 和 openclaw 的实现方式。

## 1. Telegram Bot 基础概念

### 1.1 Bot 是什么？

Telegram Bot 不是一个独立的服务器，而是：
- 一个 **Bot Token**（由 @BotFather 创建）
- 一个 **本地进程**，使用这个 Token 与 Telegram 服务器通信

### 1.2 消息获取方式

Telegram 提供两种方式让 Bot 获取消息：

#### 方式一：Long Polling（长轮询）

```
本地进程 ──getUpdates请求──▶ Telegram 服务器
         ◀──等待30秒或有新消息──
```

- Bot 主动向 Telegram 服务器发起 HTTP 请求
- 服务器保持连接最多 30 秒，有新消息立即返回
- 适合开发和本地运行
- **缺点**：同一 Token 只能有一个进程轮询（否则 409 冲突）

##### Long Polling 详细工作原理

Long Polling 是**持续循环**进行的，不是定期轮询：

```
┌─────────────────────────────────────────────────────────────────┐
│                        Long Polling 循环                         │
│                                                                  │
│   Bot 进程                              Telegram 服务器           │
│      │                                        │                  │
│      │──── getUpdates (timeout=30s) ─────────▶│                  │
│      │                                        │                  │
│      │         (服务器保持连接等待...)          │                  │
│      │                                        │                  │
│      │◀─────── 返回新消息或超时 ───────────────│                  │
│      │                                        │                  │
│      │──── getUpdates (timeout=30s) ─────────▶│  ← 立即再次请求   │
│      │                                        │                  │
│      │         (服务器保持连接等待...)          │                  │
│      │                                        │                  │
│      │◀─────── 返回新消息或超时 ───────────────│                  │
│      │                                        │                  │
│      │              ... 无限循环 ...           │                  │
│      ▼                                        ▼                  │
└─────────────────────────────────────────────────────────────────┘
```

**关键点**：
- **不是定时轮询**：不是每隔 X 秒请求一次
- **持续连接**：一个请求结束后立即发起下一个
- **服务器等待**：Telegram 服务器会保持连接最多 30 秒
- **即时响应**：有新消息时立即返回，不用等 30 秒

**grammY 内部实现逻辑**：

```typescript
while (running) {
  try {
    // 发起请求，最多等待 30 秒
    const updates = await bot.api.getUpdates({
      offset: lastUpdateId + 1,
      timeout: 30,  // 秒
    })

    // 处理收到的消息
    for (const update of updates) {
      await handleUpdate(update)
      lastUpdateId = update.update_id
    }
  } catch (error) {
    // 错误处理，指数退避重试
    await sleep(backoffTime)
  }
  // 立即开始下一次请求（没有额外延迟）
}
```

**与定时轮询的效率对比**：

| 方式 | 消息延迟 | 资源消耗 |
|------|----------|----------|
| 定时轮询 (每5秒) | 平均 2.5 秒 | 每5秒一次请求 |
| Long Polling | **几乎实时** | 每30秒一次请求（无消息时） |

##### 实时性分析

**正常情况：几乎实时（< 1秒）**

```
用户发送消息 → Telegram 服务器 → Bot 进程（正在等待的 getUpdates 立即返回）
                                    ↓
                               延迟 < 1 秒
```

**可能不实时的情况**：

| 情况 | 延迟 | 原因 |
|------|------|------|
| 网络抖动 | 几秒 | 请求失败后重试 |
| 进程重启 | 几秒 | 需要重新建立连接 |
| 409 冲突 | 卡住 | 多实例抢占，一个会失败 |
| 代理不稳定 | 不定 | 代理连接断开 |
| Telegram 服务器问题 | 罕见 | Telegram 的问题 |

##### offset 机制保证不丢消息

```typescript
// 每次请求带上 offset = 上次最后消息ID + 1
getUpdates({ offset: 656044418, timeout: 30 })
```

即使进程重启，只要保存了 `offset`，重启后会从上次位置继续拉取，**不会丢消息**。

**实时性总结**：
- ✅ 正常运行时：实时（< 1秒）
- ✅ 重启后：不丢消息（靠 offset）
- ⚠️ 网络问题：短暂延迟
- ❌ 进程挂了期间：无法收到，但重启后能补上

#### 方式二：Webhook（回调）

```
Telegram 服务器 ──POST请求──▶ 你的公网服务器
                ◀──200 OK──
```

- 你提供一个公网 HTTPS URL
- Telegram 有新消息时主动推送到你的服务器
- 适合生产环境部署
- **要求**：需要公网可访问的 HTTPS 端点

## 2. mini-claw 架构

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                      本地 Gateway 进程                        │
│                                                              │
│  ┌────────────┐    ┌────────────┐    ┌────────────────────┐ │
│  │  Telegram  │    │   Agent    │    │      Tools         │ │
│  │  Channel   │───▶│  Runner    │───▶│  - web_search      │ │
│  │  (grammY)  │    │   (LLM)    │    │  - github_*        │ │
│  └────────────┘    └────────────┘    │  - cron_*          │ │
│        │                 │           └────────────────────┘ │
│        │                 │                                   │
│  ┌────────────┐    ┌────────────┐                           │
│  │ WebSocket  │    │  Session   │                           │
│  │  Channel   │    │  Manager   │                           │
│  └────────────┘    └────────────┘                           │
└─────────────────────────────────────────────────────────────┘
         │                                      │
         ▼                                      ▼
   Telegram API                           LLM Provider
   (via proxy)                          (OpenAI 兼容)
```

### 2.2 消息流程

```
1. 用户在 Telegram 发送消息
         │
         ▼
2. Telegram 服务器收到消息
         │
         ▼
3. Gateway 进程通过 Long Polling 获取消息
   (grammY 库自动处理)
         │
         ▼
4. TelegramChannel.handleMessage() 处理消息
   - 检查 allowFrom 白名单
   - 构建 Message 对象
         │
         ▼
5. ChannelRegistry 分发给 messageHandler
         │
         ▼
6. Gateway.processMessage() 处理
   - 获取或创建 AgentRunner
   - 绑定 Session
         │
         ▼
7. AgentRunner.run() 执行
   - 调用 LLM
   - 执行 Tools
   - 生成回复
         │
         ▼
8. 通过 TelegramChannel.send() 发送回复
         │
         ▼
9. 用户在 Telegram 收到回复
```

### 2.3 关键代码位置

| 组件 | 文件 | 说明 |
|------|------|------|
| Telegram Channel | `src/channels/telegram.ts` | Bot 创建、消息处理、代理支持 |
| Gateway | `src/gateway/server.ts` | 消息路由、Agent 管理 |
| Agent Runner | `src/agents/runner.ts` | LLM 调用、Tool 执行 |
| Tools | `src/agents/tools/` | Composio 工具、Cron 工具 |
| Config | `src/infra/env.ts` | 配置读取 |

### 2.4 配置示例

```json
// ~/.mini-claw/config.json
{
  "telegram": {
    "botToken": "123456:ABC...",
    "allowFrom": ["7488297577"]  // 只允许这个用户
  },
  "providers": {
    "providers": {
      "default": {
        "baseUrl": "https://api.openai.com/v1",
        "apiKey": "sk-...",
        "models": ["gpt-4"]
      }
    }
  }
}
```

## 3. openclaw 架构

### 3.1 OpenClaw 启动时会附带启动 Channel 进程吗？

**答案：是的，会自动启动。**

当 OpenClaw Gateway 启动时，会自动启动所有已配置且启用的 channel 进程（包括 Telegram Bot）。这是通过 Gateway 服务器的 channel 管理机制实现的。

### 3.2 启动流程详解

#### 3.2.1 Gateway 服务器启动入口

启动命令: `openclaw gateway run`

入口文件: `src/cli/gateway-cli/run.ts`

```
runGatewayCommand()
  → startGatewayServer() (src/gateway/server.impl.ts)
```

#### 3.2.2 Gateway 服务器初始化

在 `src/gateway/server.impl.ts` 中，Gateway 服务器启动时会：

1. 加载配置 (`loadConfig()`)
2. 初始化插件注册表 (`loadGatewayPlugins()`)
3. 创建 Channel Manager (`createChannelManager()`)
4. 启动各种 sidecars 服务 (`startGatewaySidecars()`)

关键代码片段 (server.impl.ts:382-388):
```typescript
const channelManager = createChannelManager({
  loadConfig,
  channelLogs,
  channelRuntimeEnvs,
});
const { getRuntimeSnapshot, startChannels, startChannel, stopChannel, markChannelLoggedOut } =
  channelManager;
```

#### 3.2.3 Channel 启动机制

在 `src/gateway/server-startup.ts` 中，`startGatewaySidecars()` 函数会调用 `startChannels()`:

```typescript
// 第116-129行
const skipChannels =
  isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
  isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS);
if (!skipChannels) {
  try {
    await params.startChannels();
  } catch (err) {
    params.logChannels.error(`channel startup failed: ${String(err)}`);
  }
}
```

#### 3.2.4 Channel Manager 实现

`src/gateway/server-channels.ts` 中的 `createChannelManager()` 负责管理所有 channel 的生命周期：

```typescript
const startChannels = async () => {
  for (const plugin of listChannelPlugins()) {
    await startChannel(plugin.id);
  }
};
```

每个 channel 的启动逻辑 (简化版):
```typescript
const startChannel = async (channelId: ChannelId, accountId?: string) => {
  const plugin = getChannelPlugin(channelId);
  const startAccount = plugin?.gateway?.startAccount;
  if (!startAccount) return;

  // 检查是否启用
  const enabled = plugin.config.isEnabled?.(account, cfg);
  if (!enabled) return;

  // 检查是否已配置
  const configured = await plugin.config.isConfigured?.(account, cfg);
  if (!configured) return;

  // 启动 channel
  const abort = new AbortController();
  const task = startAccount({
    cfg,
    accountId,
    account,
    runtime,
    abortSignal: abort.signal,
    // ...
  });
};
```

### 3.3 Telegram Bot 具体实现

#### Channel Plugin 接口

Telegram 作为一个 channel plugin，需要实现 `ChannelGatewayAdapter` 接口 (`src/channels/plugins/types.adapters.ts:194-196`):

```typescript
export type ChannelGatewayAdapter<ResolvedAccount = unknown> = {
  startAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<unknown>;
  stopAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<void>;
  // ...
};
```

#### Telegram Monitor

Telegram Bot 的核心监控逻辑在 `src/telegram/monitor.ts`:

```typescript
export async function monitorTelegramProvider(opts: MonitorTelegramOpts = {}) {
  // 1. 加载配置
  const cfg = opts.config ?? loadConfig();
  const account = resolveTelegramAccount({ cfg, accountId: opts.accountId });
  const token = opts.token?.trim() || account.token;

  // 2. 创建 Bot 实例
  const bot = createTelegramBot({
    token,
    runtime: opts.runtime,
    proxyFetch,
    config: cfg,
    accountId: account.accountId,
    // ...
  });

  // 3. 选择运行模式
  if (opts.useWebhook) {
    // Webhook 模式
    await startTelegramWebhook({ ... });
    return;
  }

  // 4. Long Polling 模式 (默认)
  while (!opts.abortSignal?.aborted) {
    const runner = run(bot, createTelegramRunnerOptions(cfg));
    await runner.task();
  }
}
```

### 3.4 配置控制

#### 启用/禁用 Channel

可以通过以下方式控制 channel 是否启动：

1. **配置文件** (`~/.openclaw/config.yaml`):
```yaml
channels:
  telegram:
    enabled: false  # 禁用 Telegram
    accounts:
      default:
        botToken: "YOUR_BOT_TOKEN"
```

2. **环境变量**:
```bash
# 跳过所有 channel 启动
OPENCLAW_SKIP_CHANNELS=1

# 或旧版变量
OPENCLAW_SKIP_PROVIDERS=1
```

#### 多账户支持

Telegram 支持多账户配置：
```yaml
channels:
  telegram:
    accounts:
      default:
        botToken: "BOT_TOKEN_1"
      secondary:
        botToken: "BOT_TOKEN_2"
        enabled: true
```

### 3.5 整体架构

openclaw 采用更复杂的插件化架构：

```
┌─────────────────────────────────────────────────────────────────┐
│                         Gateway 进程                             │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Plugin Registry                        │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐    │   │
│  │  │ Telegram │ │ Discord  │ │  Slack   │ │  Signal  │    │   │
│  │  │  Plugin  │ │  Plugin  │ │  Plugin  │ │  Plugin  │    │   │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘    │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   Channel Manager                         │   │
│  │  - 生命周期管理 (start/stop)                               │   │
│  │  - 运行时状态追踪                                          │   │
│  │  - 错误恢复                                                │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Routing Layer                          │   │
│  │  - 根据 channel/account/peer 路由到 Agent                  │   │
│  │  - Session 管理                                           │   │
│  │  - Bindings 配置                                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                      Agent Layer                          │   │
│  │  - 多 Agent 支持                                          │   │
│  │  - Tool 执行                                              │   │
│  │  - 流式响应                                               │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Telegram 插件详情

```
extensions/telegram/
├── src/
│   ├── channel.ts      # 插件定义 (telegramPlugin)
│   └── runtime.ts      # 运行时绑定
└── openclaw.plugin.json

src/telegram/
├── bot.ts              # Bot 创建、中间件
├── bot-handlers.ts     # 消息/回调/反应处理
├── bot-message.ts      # 消息处理器工厂
├── bot-updates.ts      # 去重、媒体组缓冲
├── monitor.ts          # Long Polling 循环
├── webhook.ts          # Webhook 服务器
└── send.ts             # 发送消息
```

### 3.3 关键特性

| 特性 | 说明 |
|------|------|
| Polling + Webhook | 支持两种模式，通过配置切换 |
| 多账户 | 一个 Gateway 可运行多个 Bot |
| 去重 | 防止重复处理同一消息 |
| 媒体组 | 缓冲多图消息，合并处理 |
| 流式响应 | 实时更新草稿消息 |
| 错误恢复 | 指数退避重试 |
| 并发控制 | 每个 chat 顺序处理 |

## 4. 架构对比

| 方面 | mini-claw | openclaw |
|------|-----------|----------|
| 复杂度 | 简单，单文件实现 | 复杂，插件化架构 |
| 消息获取 | 仅 Long Polling | Polling + Webhook |
| 多账户 | 不支持 | 支持 |
| 去重 | 无 | 有 |
| 流式响应 | WebSocket 支持 | Telegram 草稿更新 |
| 错误处理 | 基础 | 完善（指数退避） |
| 代理支持 | 有 | 有 |
| 访问控制 | allowFrom 白名单 | 多层策略 |

## 5. 常见问题

### Q: 为什么会出现 409 冲突错误？

**原因**：同一个 Bot Token 只能有一个进程使用 Long Polling。如果有多个进程同时轮询，Telegram 会返回 409 错误。

**解决方案**：
1. 确保只有一个进程在运行
2. 启动时使用 `drop_pending_updates: true` 清除旧的轮询会话
3. 等待 30 秒让旧会话超时

### Q: Bot 需要公网服务器吗？

**不需要**（使用 Long Polling 时）：
- Bot 主动连接 Telegram 服务器
- 只需要能访问 `api.telegram.org`
- 可以在 NAT 后面运行

**需要**（使用 Webhook 时）：
- Telegram 需要能访问你的服务器
- 需要 HTTPS 和有效证书

### Q: 代理是怎么工作的？

```typescript
// 使用 https-proxy-agent
const agent = new HttpsProxyAgent('http://127.0.0.1:7890')

this.bot = new Bot(token, {
  client: {
    baseFetchConfig: { agent }
  }
})
```

所有到 Telegram API 的请求都会通过代理转发。

### Q: Tool 调用是怎么工作的？

```
用户消息 → LLM 分析 → 决定调用 Tool → 执行 Tool → 获取结果 → LLM 生成回复
```

Tools 在同一进程内执行，不需要额外的网络请求（除非 Tool 本身需要访问外部 API）。

## 6. OpenClaw 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway Server                       │
│                    (src/gateway/server.impl.ts)                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              Channel Manager                             │    │
│  │              (src/gateway/server-channels.ts)            │    │
│  │                                                          │    │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐        │    │
│  │  │  Telegram   │ │  WhatsApp   │ │   Discord   │  ...   │    │
│  │  │  Channel    │ │  Channel    │ │   Channel   │        │    │
│  │  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘        │    │
│  │         │               │               │                │    │
│  └─────────┼───────────────┼───────────────┼────────────────┘    │
│            │               │               │                     │
│            ▼               ▼               ▼                     │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              Plugin Runtime                              │    │
│  │              (src/plugins/runtime/index.ts)              │    │
│  │                                                          │    │
│  │  monitorTelegramProvider()                               │    │
│  │  monitorWebChannel() (WhatsApp)                          │    │
│  │  monitorDiscordProvider()                                │    │
│  │  monitorSlackProvider()                                  │    │
│  │  monitorSignalProvider()                                 │    │
│  │  ...                                                     │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Telegram Bot                                  │
│                    (src/telegram/bot.ts)                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Grammy Bot Instance                                     │    │
│  │  - apiThrottler (限流)                                   │    │
│  │  - sequentialize (消息顺序处理)                          │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Handlers                                                │    │
│  │  - Native Commands (/start, /help, etc.)                 │    │
│  │  - Message Handlers (text, photo, voice, etc.)           │    │
│  │  - Reaction Handlers                                     │    │
│  │  - Callback Query Handlers                               │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  运行模式                                                │    │
│  │  - Long Polling (默认): grammyjs/runner                  │    │
│  │  - Webhook: webhookCallback()                            │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## 7. OpenClaw 关键文件索引

| 文件路径 | 功能 |
|---------|------|
| `src/cli/gateway-cli/run.ts` | Gateway CLI 入口 |
| `src/gateway/server.impl.ts` | Gateway 服务器实现 |
| `src/gateway/server-channels.ts` | Channel Manager |
| `src/gateway/server-startup.ts` | Sidecar 启动逻辑 |
| `src/telegram/monitor.ts` | Telegram 监控主循环 |
| `src/telegram/bot.ts` | Grammy Bot 创建和配置 |
| `src/telegram/bot-handlers.ts` | 消息处理器注册 |
| `src/telegram/bot-native-commands.ts` | 原生命令处理 |
| `src/channels/plugins/types.plugin.ts` | Channel Plugin 类型定义 |
| `src/channels/plugins/types.adapters.ts` | Channel Adapter 接口 |
| `src/plugins/runtime/index.ts` | Plugin Runtime (包含 monitorTelegramProvider) |

## 8. 总结

### OpenClaw 启动时 Channel 进程的行为

1. **OpenClaw 启动时会自动启动 Telegram Bot** - 这是通过 Gateway 服务器的 channel 管理机制实现的
2. **启动条件**:
   - Channel 必须在配置中启用 (`enabled: true` 或未设置)
   - 必须提供有效的 Bot Token
   - 环境变量 `OPENCLAW_SKIP_CHANNELS` 未设置
3. **运行模式**: 默认使用 Long Polling，也支持 Webhook 模式
4. **并发处理**: 使用 `@grammyjs/runner` 实现并发消息处理
5. **多账户**: 支持同时运行多个 Telegram Bot 账户

## 9. 扩展阅读

- [grammY 文档](https://grammy.dev/)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Composio 文档](https://docs.composio.dev/)

---

## 10. 消息发送机制详解

### 10.1 核心问题：回复消息是通过 Tool 还是 Gateway？

**答案：通过 Gateway + Bot API，不是 Tool。**

Tool 的作用是让 Agent **主动**发送消息（比如发到另一个群），而正常的对话回复走的是 Gateway 的 outbound 系统。

### 10.2 OpenClaw 消息发送流程

```
Agent 生成回复
    ↓
Gateway outbound delivery 系统
(src/infra/outbound/deliver.ts)
    ↓
loadChannelOutboundAdapter("telegram")
(src/channels/plugins/outbound/load.ts)
    ↓
telegramOutbound.sendText() / sendMedia()
(src/channels/plugins/outbound/telegram.ts)
    ↓
sendMessageTelegram()
(src/telegram/send.ts)
    ↓
Grammy Bot API → Telegram 服务器
```

**关键代码**：

```typescript
// src/channels/plugins/outbound/telegram.ts
export const telegramOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: markdownToTelegramHtmlChunks,
  textChunkLimit: 4000,

  sendText: async ({ to, text, accountId, deps, replyToId, threadId }) => {
    const send = deps?.sendTelegram ?? sendMessageTelegram;
    const result = await send(to, text, {
      textMode: "html",
      messageThreadId: parseThreadId(threadId),
      replyToMessageId: parseReplyToMessageId(replyToId),
      accountId: accountId ?? undefined,
    });
    return { channel: "telegram", ...result };
  },
  // ...
};
```

### 10.3 Mini-Claw 消息发送流程

```
Agent 生成回复
    ↓
Gateway.processMessage() 的 onComplete 回调
(src/gateway/server.ts)
    ↓
this.channels.send(msg.channel, msg.sessionKey, { text })
(src/channels/registry.ts)
    ↓
TelegramChannel.send(sessionKey, reply)
(src/channels/telegram.ts)
    ↓
this.bot.api.sendMessage(chatId, chunk)
Grammy Bot API → Telegram 服务器
```

**关键代码**：

```typescript
// src/gateway/server.ts
await agent.run(msg.text, {
  onComplete: (text) => {
    // 通过 channel registry 发送回复
    this.channels.send(msg.channel, msg.sessionKey, { text, toolCalls })
  },
})

// src/channels/telegram.ts
async send(sessionKey: string, reply: ChannelReply): Promise<void> {
  const chatId = sessionKey.replace('telegram:', '')
  // 直接使用 Grammy Bot API 发送
  await this.bot.api.sendMessage(chatId, chunk, {
    parse_mode: 'HTML',
  })
}
```

### 10.4 机制对比

| 方面 | OpenClaw | Mini-Claw |
|------|----------|-----------|
| 发送方式 | Gateway + Bot API | Gateway + Bot API |
| 适配器层 | `ChannelOutboundAdapter` | `Channel.send()` |
| 消息分块 | `markdownToTelegramHtmlChunks` | `splitMessage()` |
| HTML 解析 | 支持 | 支持（带 fallback） |
| 媒体发送 | 支持 | 基础支持 |
| 回复引用 | 支持 `replyToMessageId` | 不支持 |
| 论坛话题 | 支持 `messageThreadId` | 不支持 |

### 10.5 Tool vs Gateway 发送的区别

| 场景 | 使用方式 | 说明 |
|------|----------|------|
| **正常对话回复** | Gateway | Agent 回复当前对话，自动路由到原始渠道 |
| **主动发送消息** | Tool | Agent 主动发送到指定目标（如另一个群） |
| **跨渠道发送** | Tool | 从 Web 端发送到 Telegram |
| **定时消息** | Tool | Cron 触发的消息发送 |

### 10.6 Web 端使用 Telegram Session 的行为

当你在 Web 端使用某个 Telegram session 对话时：

**Mini-Claw 和 OpenClaw 的行为一致：回复不会发送到 Telegram。**

#### OpenClaw 的设计

OpenClaw 使用 `OriginatingChannel` 和 `OriginatingTo` 来追踪消息来源：

```typescript
// src/auto-reply/reply/route-reply.ts
if (channel === INTERNAL_MESSAGE_CHANNEL) {
  return {
    ok: false,
    error: "Webchat routing not supported for queued replies",
  };
}
```

Web 端（webchat）被视为内部渠道，不支持跨渠道路由。

#### Mini-Claw 的实现

```typescript
// src/gateway/server.ts
onComplete: (text) => {
  // msg.channel 是消息来源，不是 sessionKey 解析出的渠道
  this.channels.send(msg.channel, msg.sessionKey, { text, toolCalls })
}
```

消息从哪个渠道来，就回复到哪个渠道。

#### 设计意图

| 场景 | 行为 | 原因 |
|------|------|------|
| Web 端查看 Telegram session | 回复只在 Web 端显示 | Web 是管理/调试界面 |
| Web 端测试对话 | 不会发到 Telegram | 避免意外发送 |
| 需要发消息到 Telegram | 使用 Tool（如 `telegram_actions`） | 主动发送应该显式 |

#### 为什么不实现跨渠道发送？

1. **职责分离** - Web 端是管理/调试界面，不是消息入口
2. **避免混乱** - 用户在 Web 测试时，不希望消息意外发到 Telegram
3. **符合 OpenClaw 设计** - OpenClaw 也明确不支持这个场景
4. **主动发送用 Tool** - 如果真的需要从 Web 发消息到 Telegram，应该用专门的 Tool

#### 总结

```
Web 端消息 (使用 telegram session)
    ↓
Agent 处理并生成回复
    ↓
回复发送到 Web 端 ✅
回复发送到 Telegram ❌ (by design)
```

**这是正确的行为，不是 bug。**
