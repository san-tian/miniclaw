# OpenClaw Cron 与 Session 的关系

## 核心问题

**Q: OpenClaw 的 cron 是和 session 绑定的吗？如果要它执行任务和发送消息，这两个会在同一个 session 里进行吗？**

**A: 取决于 `sessionTarget` 配置，有两种模式：`main` 和 `isolated`。**

---

## 两种 Session 模式

### 1. `sessionTarget: "main"` - 主 Session 模式

```
Cron 触发
    ↓
enqueueSystemEvent(text) → 注入到主 session 的消息队列
    ↓
requestHeartbeatNow() → 触发主 session 的 heartbeat
    ↓
主 Agent 处理消息（在主 session 上下文中）
    ↓
回复发送到主 session 绑定的渠道
```

**特点**：
- 任务在**主 session** 中执行
- 共享主 session 的对话历史和上下文
- 回复会发送到主 session 绑定的渠道（如 Telegram）
- 只支持 `payload.kind: "systemEvent"`（注入系统消息）

**代码位置**: `src/cron/service/timer.ts:125-176`

```typescript
if (job.sessionTarget === "main") {
  const text = resolveJobPayloadTextForMain(job);
  state.deps.enqueueSystemEvent(text, { agentId: job.agentId });
  if (job.wakeMode === "now" && state.deps.runHeartbeatOnce) {
    await state.deps.runHeartbeatOnce({ reason: `cron:${job.id}` });
  }
}
```

### 2. `sessionTarget: "isolated"` - 隔离 Session 模式

```
Cron 触发
    ↓
runIsolatedAgentJob() → 创建新的隔离 session
    ↓
Agent 在隔离 session 中执行任务
    ↓
结果摘要注入到主 session（可选）
    ↓
消息通过 delivery 配置发送到指定渠道
```

**特点**：
- 任务在**独立的隔离 session** 中执行
- 每次执行创建新的 session（`sessionId = crypto.randomUUID()`）
- 不共享主 session 的对话历史
- 支持 `payload.kind: "agentTurn"`（完整的 agent 对话）
- 可以配置独立的 delivery 目标

**代码位置**: `src/cron/isolated-agent/session.ts`

```typescript
export function resolveCronSession(params) {
  const sessionId = crypto.randomUUID();  // 每次创建新 session
  const sessionEntry: SessionEntry = {
    sessionId,
    updatedAt: params.nowMs,
    // 从原 session 继承部分配置
    thinkingLevel: entry?.thinkingLevel,
    model: entry?.model,
    lastChannel: entry?.lastChannel,
    // ...
  };
  return { sessionEntry, isNewSession: true };
}
```

---

## 配置示例

### Main Session 模式

```yaml
# 在主 session 中注入提醒消息
cron:
  - name: "每日提醒"
    schedule: { kind: "cron", expr: "0 9 * * *" }
    sessionTarget: "main"
    wakeMode: "now"
    payload:
      kind: "systemEvent"
      text: "早上好！今天有什么计划？"
```

### Isolated Session 模式

```yaml
# 在隔离 session 中执行任务，结果发送到 Telegram
cron:
  - name: "每日新闻摘要"
    schedule: { kind: "cron", expr: "0 8 * * *" }
    sessionTarget: "isolated"
    wakeMode: "now"
    payload:
      kind: "agentTurn"
      message: "搜索今天的科技新闻，生成摘要"
      deliver: true
      channel: "telegram"
      to: "7488297577"
    delivery:
      mode: "announce"
      channel: "telegram"
      to: "7488297577"
```

---

## 执行流程对比

| 方面 | Main Session | Isolated Session |
|------|--------------|------------------|
| Session 创建 | 使用现有主 session | 每次创建新 session |
| 对话历史 | 共享主 session 历史 | 独立，不共享 |
| Payload 类型 | `systemEvent` | `agentTurn` |
| 执行方式 | 注入消息 + heartbeat | 完整 agent 运行 |
| 消息发送 | 通过主 session 路由 | 通过 delivery 配置 |
| 结果通知 | 直接在主 session | 摘要注入主 session |

---

## 消息发送机制

### Main Session 模式的消息发送

```
systemEvent 注入到主 session
    ↓
heartbeat 触发 agent 处理
    ↓
agent 生成回复
    ↓
通过主 session 的 lastRoute 发送
（发送到用户最后交互的渠道）
```

### Isolated Session 模式的消息发送

```
agent 在隔离 session 中执行
    ↓
生成回复
    ↓
检查 delivery 配置
    ↓
deliverOutboundPayloads() 发送到指定渠道
    ↓
同时：摘要注入主 session（如果 delivery.mode != "none"）
```

**代码位置**: `src/cron/service/timer.ts:188-200`

```typescript
// 将摘要发送回主 session
const summaryText = res.summary?.trim();
const deliveryMode = job.delivery?.mode ?? "announce";
if (summaryText && deliveryMode !== "none") {
  const label = `Cron: ${summaryText}`;
  state.deps.enqueueSystemEvent(label, { agentId: job.agentId });
  if (job.wakeMode === "now") {
    state.deps.requestHeartbeatNow({ reason: `cron:${job.id}` });
  }
}
```

---

## 关键类型定义

```typescript
// src/cron/types.ts

export type CronSessionTarget = "main" | "isolated";
export type CronWakeMode = "next-heartbeat" | "now";

export type CronPayload =
  | { kind: "systemEvent"; text: string }  // main session 用
  | {
      kind: "agentTurn";                    // isolated session 用
      message: string;
      model?: string;
      thinking?: string;
      deliver?: boolean;
      channel?: CronMessageChannel;
      to?: string;
    };

export type CronDelivery = {
  mode: "none" | "announce";  // none=不通知主session, announce=通知
  channel?: CronMessageChannel;
  to?: string;
  bestEffort?: boolean;
};
```

---

## 总结

1. **Main Session 模式** (`sessionTarget: "main"`):
   - 任务和消息发送在**同一个主 session** 中
   - 适合简单的提醒、通知场景
   - 共享对话上下文

2. **Isolated Session 模式** (`sessionTarget: "isolated"`):
   - 任务在**独立的隔离 session** 中执行
   - 消息发送通过 **delivery 配置**指定目标
   - 适合复杂任务、不想污染主 session 历史的场景
   - 结果摘要会通知到主 session

3. **选择建议**:
   - 简单提醒 → `main` + `systemEvent`
   - 复杂任务（搜索、分析）→ `isolated` + `agentTurn`
   - 需要保持对话连贯性 → `main`
   - 需要独立执行不干扰主对话 → `isolated`
