# OpenClaw 主动消息发送机制

> **注**: 本文档分析的是 **OpenClaw** 的实现，用于学习参考。

## 核心问题

**Q: OpenClaw 中 session 如何主动向用户发送消息（Telegram/Web/WhatsApp 等）？是通过 tool 实现的吗？**

**A: 主要通过两个 Agent Tool 实现，加上 Cron 调度投递和 Gateway 底层 API，共四种机制。所有路径最终汇聚到同一个投递管线 `deliverOutboundPayloads()`。**

---

## 架构总览

```
┌──────────────────────────────────────────────────────┐
│                   Agent / Gateway                     │
│                                                       │
│  1. message tool ──────────┐                          │
│  2. sessions_send tool ────┤                          │
│  3. cron --announce ───────┤→ deliverOutboundPayloads │
│  4. gateway send method ───┘   (infra/outbound)       │
│                                       │               │
│              ┌────────────────────────┼──────────┐    │
│              ▼           ▼            ▼          ▼    │
│          Telegram    WhatsApp      Slack     Discord   │
│          Web/WS      Signal       LINE      iMessage   │
└──────────────────────────────────────────────────────┘
```

---

## 1. `message` tool — 主要的主动发送工具

**代码**: `openclaw/src/agents/tools/message-tool.ts:387`

Agent 在对话中调用 `message` tool 即可主动向任意渠道发送消息。这是**最常用**的主动发送方式。

### Agent 调用示例

```json
{
  "action": "send",
  "channel": "telegram",
  "target": "123456789",
  "message": "你好，这是一条主动推送的消息！"
}
```

### 支持的 action

| 类别 | action |
|------|--------|
| 发送 | `send`, `sendWithEffect`, `sendAttachment`, `reply`, `thread-reply` |
| 广播 | `broadcast`（多目标） |
| 互动 | `react`, `poll`, `pin`, `unpin`, `sticker` |
| 管理 | `delete`, `fetchMessages`, `typing`, `createThread` |

### 调用链

```
message tool execute()
  → runMessageAction()             # infra/outbound/message-action-runner.ts:161
    → handleSendAction()           # 解析 target/channel/account
      → deliverOutboundPayloads()  # infra/outbound/deliver.ts:179
        → createChannelHandler()   # 选择渠道 sender
          → sendMessageTelegram()  # telegram/send.ts:200
          → sendMessageWhatsApp()  # web/outbound.ts:14
          → ...
```

### SILENT_REPLY_TOKEN 机制

当 Agent 用 `message(action=send)` 主动发送了消息后，它的文本回复应该只包含 `NO_REPLY`，避免通过正常回复路径再发一次重复消息。

系统提示词中的指令（`openclaw/src/agents/system-prompt.ts:120`）：

> If you use `message` (`action=send`) to deliver your user-visible reply,
> respond with ONLY: NO_REPLY

### 关键文件

| 文件 | 职责 |
|------|------|
| `src/agents/tools/message-tool.ts` | Tool 定义、schema、入口 |
| `src/infra/outbound/message-action-runner.ts` | Action 分发与执行 |
| `src/infra/outbound/deliver.ts` | 统一投递管线 |
| `src/telegram/send.ts` | Telegram 发送器 |
| `src/web/outbound.ts` | WhatsApp 发送器 |

---

## 2. `sessions_send` tool — 跨 Session 通信

**代码**: `openclaw/src/agents/tools/sessions-send-tool.ts:37`

用于 Agent 之间的通信（A2A），向另一个 session 发送消息。**不是直接面向终端用户的**。

### Agent 调用示例

```json
{
  "sessionKey": "agent:ops:main",
  "message": "请生成今日报告。"
}
```

### 调用链

```
sessions_send execute()
  → callGateway("chat.send")     # 将消息注入目标 session
  → callGateway("chat.wait")     # 等待目标 agent 回复
  → runSessionsSendA2AFlow()     # 可选的 ping-pong 多轮对话
```

### 适用场景

- 一个 Agent 委托另一个 Agent 执行任务
- 多 Agent 协作场景
- **不适合**直接给 Telegram/Web 用户发消息（应该用 `message` tool）

---

## 3. Cron 投递 — 定时主动推送

**代码**: `openclaw/src/cron/isolated-agent/run.ts:480`

Cron 定时任务执行隔离 Agent 轮次后，通过 `--announce` 将输出投递到指定渠道。这是**基于时间的主动推送**的主要方式。

### 配置示例

```bash
openclaw cron add \
  --name "每日简报" \
  --cron "0 7 * * *" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --message "生成今日简报：天气、日历、邮件摘要。" \
  --announce \
  --channel telegram \
  --to "123456789"
```

### 调用链

```
CronService 定时器触发
  → runCronIsolatedAgentTurn()    # cron/isolated-agent/run.ts
    → runEmbeddedPiAgent()        # 执行 agent 轮次，收集 payloads
    → resolveCronDeliveryPlan()   # cron/delivery.ts — 解析投递计划
    → deliverOutboundPayloads()   # infra/outbound/deliver.ts
      → 渠道 sender
```

### 投递模式

| 模式 | 行为 |
|------|------|
| `announce` | 将 agent 输出投递到配置的 channel/target |
| `none` | 只执行 agent，不投递（用于副作用） |

### 智能跳过

Cron 投递有两种自动跳过逻辑（`run.ts:441-451`）：

1. **心跳空回复跳过**: 如果 agent 只回复了 `HEARTBEAT_OK` 没有实质内容，不投递
2. **message tool 已发送跳过**: 如果 agent 在执行过程中已经通过 `message` tool 发送到了同一目标，不重复投递

---

## 4. Gateway `send` 方法 — 底层 API

**代码**: `openclaw/src/gateway/server-methods/send.ts`

Gateway 暴露 `send` JSON-RPC 方法，任何连接到 Gateway 的客户端（CLI、Control UI、原生 App）都可以调用。

### 调用链

```
Gateway 客户端 → send({ to, message, channel })
  → resolveOutboundTarget()       # 解析目标
  → deliverOutboundPayloads()     # 统一投递
    → 渠道 sender
```

CLI 命令 `openclaw agent --deliver` 和 `openclaw message` 底层都走这个方法。

---

## 核心投递管线

**所有四种机制最终汇聚于**: `deliverOutboundPayloads()`

**代码**: `openclaw/src/infra/outbound/deliver.ts:179`

```
deliverOutboundPayloads({ cfg, channel, to, payloads, ... })
  → createChannelHandler()     # 根据 channel 选择插件 + outbound 配置
  → normalize payloads         # 分块、文本限制、媒体处理
  → for each payload:
      → sendText() / sendMedia() / sendPayload()
  → optional: mirror           # 镜像写入 session 记录
```

### 各渠道 sender

| 渠道 | 文件 | 入口函数 |
|------|------|----------|
| Telegram | `src/telegram/send.ts` | `sendMessageTelegram()` |
| WhatsApp | `src/web/outbound.ts` | `sendMessageWhatsApp()` |
| Slack | `src/slack/send.ts` | — |
| Discord | `src/discord/send.ts` | — |
| Signal | `src/signal/send.ts` | — |
| LINE | `src/line/send.ts` | — |
| iMessage | `src/channels/plugins/bluebubbles-outbound.ts` | — |
| Web/WS | 内部 WebSocket 推送 | 无外部 API 调用 |

---

## 对比：被动回复 vs 主动发送

### 被动回复（默认路径，不需要 tool）

```
用户发消息 (Telegram/Web/...)
  → agent run → 生成回复 payloads
  → routeReply()                  # auto-reply/reply/route-reply.ts:57
    → deliverOutboundPayloads()
      → 原始渠道（哪来的回哪去）
```

这是**自动的**，agent 不需要调用任何 tool。

### 主动发送（需要 tool 或 cron）

Agent 必须显式调用 `message` tool 或通过 cron 配置 `--announce`。

---

## 决策指南

| 场景 | 使用机制 |
|------|----------|
| Agent 想给特定用户/群发消息 | `message` tool |
| Agent 想广播到多个目标 | `message` tool (`action=broadcast`) |
| Agent 想委托另一个 Agent | `sessions_send` tool |
| 定时日报 / 提醒 | Cron + `--announce` |
| CLI 脚本推送消息 | `openclaw agent --deliver` 或 `openclaw message` |
| 回复刚发消息的用户 | 自动（不需要 tool） |
