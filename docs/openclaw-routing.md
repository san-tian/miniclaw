# OpenClaw 消息路由机制

## 核心概念

消息到达后，系统根据**绑定规则**决定由哪个 Agent 处理。

## 路由优先级

从高到低依次匹配，匹配成功即停止：

1. **Peer 绑定** - 特定用户或群组
2. **Guild/Team 绑定** - Discord 服务器 / Slack 工作区
3. **Account 绑定** - 特定账户的默认 Agent
4. **Channel 绑定** - 通道的默认 Agent
5. **默认 Agent** - 兜底

## 配置示例

```yaml
bindings:
  # VIP 用户 → 专属 Agent
  - match:
      channel: telegram
      peer: { kind: dm, id: "123456" }
    agentId: vip-agent

  # 某个群组 → 客服 Agent
  - match:
      channel: telegram
      peer: { kind: group, id: "-100999" }
    agentId: support-agent

  # Discord 某服务器 → 游戏 Agent
  - match:
      channel: discord
      guildId: "888777"
    agentId: gaming-agent

  # Telegram 通道默认 → 通用 Agent
  - match:
      channel: telegram
      accountId: "*"
    agentId: default-agent
```

## 匹配流程

```
消息到达
    ↓
有没有匹配的 peer 绑定？ ──是──→ 用该 Agent
    ↓ 否
有没有匹配的 guild/team？ ──是──→ 用该 Agent
    ↓ 否
有没有匹配的 account？ ──是──→ 用该 Agent
    ↓ 否
有没有匹配的 channel？ ──是──→ 用该 Agent
    ↓ 否
用默认 Agent
```

## 核心代码

`src/routing/resolve-route.ts` - 路由解析主逻辑

---

## Session Key 机制

OpenClaw 使用 **Session Key** 来标识和复用会话。每次对话时，系统会根据消息来源生成一个确定性的 session key，**相同来源的消息会复用同一个 session**。

### Session Key 生成规则

Session key 的格式取决于消息类型和配置：

#### 1. DM（私聊）消息

由 `dmScope` 配置决定（默认 `main`）：

| dmScope | Session Key 格式 | 说明 |
|---------|-----------------|------|
| `main` | `agent:{agentId}:main` | 所有 DM 共享一个 session |
| `per-peer` | `agent:{agentId}:dm:{peerId}` | 每个用户独立 session |
| `per-channel-peer` | `agent:{agentId}:{channel}:dm:{peerId}` | 每个渠道+用户独立 |
| `per-account-channel-peer` | `agent:{agentId}:{channel}:{accountId}:dm:{peerId}` | 最细粒度 |

#### 2. 群组消息

```
agent:{agentId}:{channel}:group:{groupId}
```

例如：`agent:main:telegram:group:-1001234567890`

#### 3. 论坛/话题消息

如果群组是论坛（Forum），会附加 topic ID：

```
agent:{agentId}:{channel}:group:{groupId}:thread:{topicId}
```

### Telegram 示例

```typescript
// bot-message-context.ts 核心逻辑

// 1. 解析路由，获取 base session key
const route = resolveAgentRoute({
  cfg,
  channel: "telegram",
  accountId: account.accountId,
  peer: {
    kind: isGroup ? "group" : "dm",
    id: peerId,  // 群组ID 或 用户ID
  },
});
const baseSessionKey = route.sessionKey;

// 2. 如果有 thread（DM 中的回复链或论坛话题），附加 thread 后缀
const threadKeys = dmThreadId != null
  ? resolveThreadSessionKeys({ baseSessionKey, threadId: String(dmThreadId) })
  : null;
const sessionKey = threadKeys?.sessionKey ?? baseSessionKey;
```

### 关键结论

**Telegram bot 每次对话会复用旧的 session，而不是创建新的。**

具体行为：

| 场景 | Session 行为 |
|------|-------------|
| 同一用户私聊 | 复用同一 session（默认 `dmScope=main` 时所有 DM 共享） |
| 同一群组消息 | 复用同一 session（按 groupId 区分） |
| 论坛不同话题 | 每个话题独立 session |
| 不同用户私聊 | 取决于 `dmScope` 配置 |

### 配置 dmScope

```json5
{
  "session": {
    "dmScope": "per-peer"  // 每个用户独立 session
  }
}
```

可选值：
- `main` (默认) - 所有 DM 共享一个 session
- `per-peer` - 每个用户独立 session
- `per-channel-peer` - 每个渠道+用户独立
- `per-account-channel-peer` - 最细粒度（多账户场景）

### Identity Links（身份关联）

可以将不同渠道的用户关联到同一身份，共享 session：

```json5
{
  "session": {
    "dmScope": "per-peer",
    "identityLinks": {
      "alice": ["telegram:123456", "discord:789012"],
      "bob": ["telegram:654321", "slack:U123ABC"]
    }
  }
}
```

这样 Alice 在 Telegram 和 Discord 的消息会使用同一个 session。
