# OpenClaw 异步工具实现解析

OpenClaw 的 `exec` 工具实现了两种异步执行模式：**流式工具**（执行中持续输出中间结果）和**后台工具**（不阻塞当前 Agent turn，由 Gateway 管理生命周期）。两种模式可以组合使用。

---

## 一、流式工具（Streaming Tools）

### 核心机制

工具的 `execute` 方法接收一个 `onUpdate` 回调，每当有新输出时调用它推送中间结果，Agent 不需要等工具执行完就能看到进展。

### 工具签名

```typescript
// pi-agent-core 定义的工具执行签名
execute: async (
  toolCallId: string,
  args: unknown,
  signal?: AbortSignal,
  onUpdate?: (partialResult: AgentToolResult<T>) => void  // 关键：流式回调
) => AgentToolResult<T>
```

### 实现：exec 工具的流式输出

`exec` 工具在子进程的 stdout/stderr 每次收到数据时，通过 `onUpdate` 推送当前输出快照：

```typescript
// src/agents/bash-tools.exec.ts:651-683

// 构造流式更新函数
const emitUpdate = () => {
  if (!opts.onUpdate) return;
  const tailText = session.tail || session.aggregated;
  const warningText = opts.warnings.length ? `${opts.warnings.join("\n")}\n\n` : "";
  opts.onUpdate({
    content: [{ type: "text", text: warningText + (tailText || "") }],
    details: {
      status: "running",
      sessionId,
      pid: session.pid ?? undefined,
      startedAt,
      cwd: session.cwd,
      tail: session.tail,
    },
  });
};

// stdout 每收到一块数据就推送一次
const handleStdout = (data: string) => {
  const str = sanitizeBinaryOutput(data.toString());
  for (const chunk of chunkString(str)) {
    appendOutput(session, "stdout", chunk);
    emitUpdate();  // ← 每个 chunk 都触发流式更新
  }
};

// stderr 同理
const handleStderr = (data: string) => {
  const str = sanitizeBinaryOutput(data.toString());
  for (const chunk of chunkString(str)) {
    appendOutput(session, "stderr", chunk);
    emitUpdate();
  }
};
```

### 事件传播链

`onUpdate` 被调用后，事件沿以下路径传播到客户端：

```typescript
// src/agents/pi-embedded-subscribe.handlers.tools.ts:116-146

export function handleToolExecutionUpdate(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & {
    toolName: string;
    toolCallId: string;
    partialResult?: unknown;
  },
) {
  const toolName = normalizeToolName(String(evt.toolName));
  const toolCallId = String(evt.toolCallId);
  const partial = evt.partialResult;
  const sanitized = sanitizeToolResult(partial);

  // 发射到全局事件流，WebSocket 客户端可以订阅
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "tool",
    data: {
      phase: "update",       // "start" | "update" | "result"
      name: toolName,
      toolCallId,
      partialResult: sanitized,
    },
  });
}
```

### 流式工具时序图

```
Agent                exec tool              子进程
  │                     │                     │
  │── execute(onUpdate) │                     │
  │                     │── spawn ───────────►│
  │                     │                     │
  │                     │◄── stdout chunk 1 ──│
  │◄── onUpdate(tail) ──│                     │
  │                     │◄── stderr chunk ────│
  │◄── onUpdate(tail) ──│                     │
  │                     │◄── stdout chunk 2 ──│
  │◄── onUpdate(tail) ──│                     │
  │                     │                     │
  │                     │◄── exit(0) ─────────│
  │◄── return(result) ──│                     │
  │                                           │
  │── 继续 LLM 对话 ──►                       │
```

**要点**：流式工具**阻塞**当前 Agent turn，但客户端能实时看到输出进展。

---

## 二、后台工具（Background Tools）

### 核心机制

通过 `yieldMs` / `background` 参数，`exec` 工具可以在超时前或立即将进程"后台化"——工具立即返回 `status: "running"` + `sessionId`，Agent 不被阻塞，进程在后台继续运行。后续通过 `process` 工具管理。

### 参数定义

```typescript
// src/agents/bash-tools.exec.ts:195-241

const execSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  yieldMs: Type.Optional(
    Type.Number({
      description: "Milliseconds to wait before backgrounding (default 10000)",
    }),
  ),
  background: Type.Optional(
    Type.Boolean({ description: "Run in background immediately" }),
  ),
  timeout: Type.Optional(
    Type.Number({
      description: "Timeout in seconds (optional, kills process on expiry)",
    }),
  ),
  // ...
});
```

### yield 窗口计算

```typescript
// src/agents/bash-tools.exec.ts:855-864

const backgroundRequested = params.background === true;
const yieldRequested = typeof params.yieldMs === "number";

const yieldWindow = allowBackground
  ? backgroundRequested
    ? 0                    // background=true → 立即后台化（0ms）
    : clampNumber(         // yieldMs → 等待指定毫秒后后台化
        params.yieldMs ?? defaultBackgroundMs,
        defaultBackgroundMs, 10, 120_000
      )
  : null;                  // 不允许后台 → 同步执行
```

### 后台化核心逻辑

```typescript
// src/agents/bash-tools.exec.ts:1523-1624

let yielded = false;
let yieldTimer: NodeJS.Timeout | null = null;

// 中止信号不应杀死已后台化的会话
const onAbortSignal = () => {
  if (yielded || run.session.backgrounded) return;
  run.kill();
};

return new Promise<AgentToolResult<ExecToolDetails>>((resolve, reject) => {

  // 后台化时立即返回的响应
  const resolveRunning = () =>
    resolve({
      content: [{
        type: "text",
        text: `Command still running (session ${run.session.id}, pid ${
          run.session.pid ?? "n/a"
        }). Use process (list/poll/log/write/kill/clear/remove) for follow-up.`,
      }],
      details: {
        status: "running",
        sessionId: run.session.id,
        pid: run.session.pid ?? undefined,
        startedAt: run.startedAt,
        cwd: run.session.cwd,
        tail: run.session.tail,
      },
    });

  // 执行后台化
  const onYieldNow = () => {
    if (yieldTimer) clearTimeout(yieldTimer);
    if (yielded) return;
    yielded = true;
    markBackgrounded(run.session);  // 标记会话为后台状态
    resolveRunning();               // 立即 resolve，释放 Agent turn
  };

  // 根据 yieldWindow 决定何时后台化
  if (allowBackground && yieldWindow !== null) {
    if (yieldWindow === 0) {
      onYieldNow();                 // 立即后台化
    } else {
      yieldTimer = setTimeout(() => {
        yielded = true;
        markBackgrounded(run.session);
        resolveRunning();
      }, yieldWindow);              // 延迟后台化
    }
  }

  // 进程完成时的处理
  run.promise.then((outcome) => {
    if (yieldTimer) clearTimeout(yieldTimer);
    if (yielded || run.session.backgrounded) return;  // 已后台化，忽略
    // 前台完成，正常返回结果
    resolve({
      content: [{ type: "text", text: outcome.aggregated || "(no output)" }],
      details: { status: "completed", exitCode: outcome.exitCode ?? 0, ... },
    });
  });
});
```

### 进程会话注册表

后台化的进程由全局注册表管理，`process` 工具通过它查询和操控：

```typescript
// src/agents/bash-process-registry.ts:26-52

export interface ProcessSession {
  id: string;
  command: string;
  scopeKey?: string;          // Agent 作用域（隔离不同 Agent 的会话）
  sessionKey?: string;        // 用于退出通知的路由 key
  notifyOnExit?: boolean;     // 退出时是否通知
  exitNotified?: boolean;
  child?: ChildProcessWithoutNullStreams;
  stdin?: SessionStdin;
  pid?: number;
  startedAt: number;
  aggregated: string;         // 全量输出
  tail: string;               // 最近输出（用于快速预览）
  exitCode?: number | null;
  exited: boolean;
  backgrounded: boolean;      // ← 关键标记
}

// 全局注册表
const runningSessions = new Map<string, ProcessSession>();
const finishedSessions = new Map<string, FinishedSession>();
```

### 退出通知机制

后台进程退出时，通过系统事件 + 心跳唤醒通知 Agent：

```typescript
// src/agents/bash-tools.exec.ts:376-396

function maybeNotifyOnExit(session: ProcessSession, status: "completed" | "failed") {
  if (!session.backgrounded || !session.notifyOnExit || session.exitNotified) return;
  const sessionKey = session.sessionKey?.trim();
  if (!sessionKey) return;

  session.exitNotified = true;
  const exitLabel = session.exitSignal
    ? `signal ${session.exitSignal}`
    : `code ${session.exitCode ?? 0}`;
  const output = normalizeNotifyOutput(
    tail(session.tail || session.aggregated || "", DEFAULT_NOTIFY_TAIL_CHARS),
  );
  const summary = output
    ? `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel}) :: ${output}`
    : `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel})`;

  enqueueSystemEvent(summary, { sessionKey });   // 入队系统事件
  requestHeartbeatNow({ reason: `exec:${session.id}:exit` });  // 唤醒 Agent
}
```

### 后台工具时序图

```
Agent                exec tool              子进程           process tool
  │                     │                     │                  │
  │── exec(background)──│                     │                  │
  │                     │── spawn ───────────►│                  │
  │                     │                     │                  │
  │                     │── markBackgrounded()│                  │
  │◄─ {status:"running",│                     │                  │
  │    sessionId:"abc"} │                     │                  │
  │                     │                     │                  │
  │── 继续 LLM 对话 ──►│                     │(后台运行中...)    │
  │                     │                     │                  │
  │── process(poll,"abc")──────────────────────────────────────►│
  │◄─ {new output...} ─────────────────────────────────────────│
  │                     │                     │                  │
  │                     │              exit(0)│                  │
  │                     │── maybeNotifyOnExit()                  │
  │◄── [系统事件] ──────│                     │                  │
  │                     │                     │                  │
  │── process(log,"abc")───────────────────────────────────────►│
  │◄─ {full output} ───────────────────────────────────────────│
```

**要点**：后台工具**不阻塞** Agent turn，Agent 可以继续对话或执行其他工具，稍后通过 `process` 工具回来查看结果。

---

## 三、两种模式对比

| | 流式工具 | 后台工具 |
|---|---------|---------|
| **阻塞** | 阻塞当前 turn | 不阻塞，立即返回 |
| **触发方式** | 工具内部自动（有 stdout 就推） | `background: true` 或 `yieldMs` 参数 |
| **中间输出** | 通过 `onUpdate` 回调实时推送 | 通过 `process poll/log` 主动拉取 |
| **完成通知** | 工具 return 即完成 | `notifyOnExit` → 系统事件 + 心跳唤醒 |
| **会话管理** | 无需 | `bash-process-registry` 全局注册表 |
| **典型场景** | `npm install`（想看进度） | `npm run build`（先去干别的） |

### 组合使用

两种模式可以叠加：一个 `exec` 调用先流式输出 10 秒，如果 10 秒内没完成就自动后台化。

```
0s          10s (yieldMs)
│── 流式输出 ──│── 后台化，Agent 继续 ──►
│  onUpdate()  │  resolveRunning()
│  onUpdate()  │
│  onUpdate()  │
```

这就是 `yieldMs` 的默认行为：先给 Agent 看 10 秒实时输出，超时后自动转后台，不卡住对话。

---

## 四、`process` 工具操作一览

后台化的进程通过 `process` 工具管理：

| Action | 说明 |
|--------|------|
| `list` | 列出所有后台会话（运行中 + 已完成） |
| `poll` | 拉取新增输出（增量），同时报告退出状态 |
| `log` | 读取全量输出（支持 `offset` + `limit` 分页） |
| `write` | 向 stdin 写入数据（可选 `eof` 关闭） |
| `kill` | 终止运行中的会话 |
| `clear` | 清除已完成的会话记录 |
| `remove` | 运行中则 kill，已完成则 clear |

会话按 `scopeKey` 隔离，每个 Agent 只能看到自己启动的进程。

---

## 五、实际使用场景

### 场景 1：流式工具——安装依赖（用户想盯着看）

> **用户**：帮我安装这个项目的依赖
>
> Agent 调用 `exec("npm install")`，`onUpdate` 持续推送安装进度。用户在聊天界面实时看到滚动输出，不用干等空白屏幕。命令跑完后 Agent 才继续下一步。

适合：`npm install`、`docker build`、`pytest`——执行时间中等（几秒到几十秒），用户想看进度或实时排错。

### 场景 2：后台工具——跑测试的同时干别的

> **用户**：帮我跑一下完整的测试套件，然后搜一下最近的 AI 新闻发到 Telegram
>
> Agent 调用 `exec("npm run test:full", { background: true })`，工具立即返回 `session: abc123, status: running`。Agent 不等测试跑完，直接去搜索新闻 + 发 Telegram。20 分钟后测试跑完，`notifyOnExit` 触发系统事件唤醒 Agent，Agent 用 `process(poll, "abc123")` 拉取结果告诉用户「测试全部通过」。

适合：`cargo build`（大项目编译）、`rsync` 大文件同步、长时间训练脚本——执行时间长（分钟级），用户不想干等。

### 场景 3：组合使用——短命令同步等、长命令自动让路

> **用户**：执行 make build
>
> Agent 调用 `exec("make build")`（默认 `yieldMs=10000`）。前 10 秒流式输出编译日志，用户能看到进度。如果 10 秒内编译完了，直接返回结果；如果 10 秒没完，自动后台化，Agent 告诉用户「编译还在跑，session ID 是 xxx，我先继续别的」。

这就是 `yieldMs` 的设计意图：**短命令同步等、长命令自动让路**，不需要用户提前判断命令会跑多久。

---

## 六、后台命令的感知机制与局限

### Agent 什么时候知道后台命令完成了？

有三种触发方式：

| 触发方式 | 时机 | 机制 |
|---------|------|------|
| 进程正常退出 | 命令执行完毕 | `notifyOnExit` → 系统事件 + 心跳唤醒 Agent |
| 超时强杀 | 默认 1800s（30 分钟） | kill 进程 → 同上，status 为 `failed` |
| 用户主动询问 | 用户说"跑完了吗" | Agent 调用 `process poll` 查看 |

### 退出通知的完整流程

```
后台进程退出
    │
    ▼
maybeNotifyOnExit()
    ├── enqueueSystemEvent("Exec completed (abc12345, code 0) :: output...")
    │       → 摘要进入系统事件队列
    └── requestHeartbeatNow()
            → 立即触发心跳，唤醒 Agent 事件循环
                │
                ▼
        Agent 在下一个 turn 看到：
        [SYSTEM] Exec completed (abc12345, code 0) :: All 142 tests passed.
                │
                ▼
        Agent 决定下一步（汇报用户 / 执行后续操作）
```

### 重要局限：运行期间 Agent 不会主动轮询

后台进程运行中（未退出、未超时），Agent **不会**自动去查看进度。这是事件驱动的设计取舍——不做无意义的轮询。

例如一个命令跑了 29 分钟还没完，Agent 是"不知道"的，直到：
- 第 30 分钟超时被杀，触发退出通知
- 或者用户主动问"跑完了吗"，Agent 才去 `process poll`

### 应对策略

- **调小 timeout**：对预期耗时短的命令设置更短的超时
- **System prompt 提示**：在 Agent 的 system prompt 中加入"长时间后台任务应定期 `process poll` 检查进度"
- **用户侧感知**：Web UI / Telegram 可以展示后台会话列表，用户随时点击查看

---

## 七、SystemEvent 与 Heartbeat 机制详解

后台工具的退出通知依赖两个基础设施协作：**SystemEvent**（发生了什么）和 **Heartbeat**（唤醒 Agent 去处理）。

### 7.1 SystemEvent：会话级事件队列

一个轻量的内存队列，按 sessionKey 隔离，存放人类可读的事件文本。**不持久化**，消费即销毁。

```typescript
// src/infra/system-events.ts

export type SystemEvent = { text: string; ts: number };

const MAX_EVENTS = 20;
const queues = new Map<string, SessionQueue>();  // 按 sessionKey 隔离

// 入队：后台进程退出、cron 触发、channel 事件等都会调用
export function enqueueSystemEvent(text: string, options: { sessionKey: string }) {
  const entry = queues.get(key) ?? createNew();
  if (entry.lastText === cleaned) return;  // 跳过连续重复
  entry.queue.push({ text: cleaned, ts: Date.now() });
  if (entry.queue.length > MAX_EVENTS) entry.queue.shift();  // 最多 20 条
}

// 消费：Agent 下次运行时一次性取走所有事件
export function drainSystemEvents(sessionKey: string): string[] {
  // 取出所有事件文本，清空队列
  return drainSystemEventEntries(sessionKey).map((event) => event.text);
}
```

**关键点**：事件入队后不会立即被 Agent 看到——需要 Heartbeat 唤醒 Agent，Agent 在下一个 turn 的 prompt 中才会读到这些事件。

### 7.2 Heartbeat：定时唤醒 + 即时唤醒

Heartbeat 是一个定时器，周期性地调用 LLM 检查是否有需要处理的事情。同时支持即时唤醒（如后台进程退出时）。

#### 即时唤醒（heartbeat-wake）

```typescript
// src/infra/heartbeat-wake.ts

let handler: HeartbeatWakeHandler | null = null;
let pendingReason: string | null = null;

const DEFAULT_COALESCE_MS = 250;  // 250ms 内的多次请求合并为一次

// 任何地方都可以调用，请求立即执行一次心跳
export function requestHeartbeatNow(opts?: { reason?: string }) {
  pendingReason = opts?.reason ?? "requested";
  schedule(DEFAULT_COALESCE_MS);  // 250ms 后执行（合并短时间内的多次请求）
}

function schedule(coalesceMs: number) {
  timer = setTimeout(async () => {
    const reason = pendingReason;
    pendingReason = null;
    running = true;
    const res = await handler({ reason });
    // 如果主通道忙（requests-in-flight），1 秒后重试
    if (res.status === "skipped" && res.reason === "requests-in-flight") {
      schedule(DEFAULT_RETRY_MS);  // 1000ms
    }
    running = false;
  }, coalesceMs);
}
```

#### 心跳运行器（heartbeat-runner）

心跳触发后实际执行的逻辑：

```typescript
// src/infra/heartbeat-runner.ts（简化）

// 后台进程退出时使用的特殊 prompt
const EXEC_EVENT_PROMPT =
  "An async command you ran earlier has completed. " +
  "The result is shown in the system messages above. " +
  "Please relay the command output to the user in a helpful way.";

export async function runHeartbeatOnce(opts) {
  // 1. 检查是否在活跃时间段内
  if (!isWithinActiveHours(cfg, heartbeat)) return { status: "skipped" };

  // 2. 检查主通道是否空闲（避免和用户消息冲突）
  if (getQueueSize(CommandLane.Main) > 0) return { status: "skipped", reason: "requests-in-flight" };

  // 3. 查看是否有待处理的 exec 退出事件
  const pendingEvents = peekSystemEvents(sessionKey);
  const hasExecCompletion = pendingEvents.some(evt => evt.includes("Exec finished"));

  // 4. 选择 prompt：有 exec 事件用专用 prompt，否则用常规心跳 prompt
  const prompt = hasExecCompletion ? EXEC_EVENT_PROMPT : resolveHeartbeatPrompt(cfg);

  // 5. 调用 LLM（system events 会被注入到 prompt 上下文中）
  const replyResult = await getReplyFromConfig(ctx, { isHeartbeat: true }, cfg);

  // 6. 如果 LLM 有话要说（不是 HEARTBEAT_OK），发送到用户的 channel
  if (shouldDeliver) {
    await deliverOutboundPayloads({
      channel: delivery.channel,  // telegram / discord / web 等
      to: delivery.to,
      payloads: [{ text: normalized.text }],
    });
  }
}
```

### 7.3 完整通知链路

把所有环节串起来：

```
后台进程退出
    │
    ▼
maybeNotifyOnExit()
    ├── enqueueSystemEvent(                          ← SystemEvent 入队
    │     "Exec completed (abc12345, code 0) :: output...",
    │     { sessionKey: "telegram:12345" }
    │   )
    └── requestHeartbeatNow(                         ← 请求即时心跳
          { reason: "exec:abc12345:exit" }
        )
            │
            ▼ (250ms 合并窗口)
        heartbeat-wake 触发 handler
            │
            ▼
        runHeartbeatOnce()
            ├── peekSystemEvents() → 发现 exec 退出事件
            ├── 使用 EXEC_EVENT_PROMPT 调用 LLM
            │     LLM 看到: "[SYSTEM] Exec completed (abc12345, code 0) :: All tests passed"
            │     LLM 回复: "你的测试全部通过了！142 个用例，耗时 3 分 22 秒。"
            └── deliverOutboundPayloads()
                  → 发送到 Telegram / Discord / Web UI
                      │
                      ▼
                  用户收到消息 ✓
```

### 7.4 Heartbeat 的双重角色

Heartbeat 不仅用于后台进程通知，它还是 Agent 的"自主行动"引擎：

| 触发源 | reason | 行为 |
|--------|--------|------|
| 定时器到期 | `"interval"` | 读取 HEARTBEAT.md，执行周期性检查任务 |
| 后台进程退出 | `"exec:xxx:exit"` | 读取 SystemEvent，转发结果给用户 |
| Cron 任务 | `"cron"` | 执行定时任务 |
| 外部事件 | 各种 | Channel 事件、节点状态变化等 |

配置项（在 `config.json` 的 `agents.defaults.heartbeat` 中）：

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `every` | `"5m"` | 定时心跳间隔 |
| `activeHours.start/end` | 无 | 静默时段（避免半夜发消息） |
| `target` | `"last"` | 发送目标（最近活跃的 channel） |
| `ackMaxChars` | 200 | HEARTBEAT_OK 响应最大字符数 |
| `notifyOnExit` | `true` | 后台进程退出时是否通知 |

---

## 八、Steer Mode：用户消息的实时注入

当 Agent 正在处理上一条消息时，用户发来新消息，走的是 **Steer Mode**——直接注入到运行中的 Agent，不经过 SystemEvent。

### 流程

```
Agent 正在处理消息 A（比如在跑第 3 轮 tool 调用）
    │
用户发来消息 B
    │
    ▼
Gateway.handleMessage()
    → agent.isActive() === true
    → 消息 B 进入 FollowupQueue
    → steer 回调立即触发 agent.inject("消息 B")
        │
        ▼
AgentRunner 内部：injectedMessages.push("消息 B")
        │
        ▼
    下一轮 tool loop 迭代开始时：
    if (injectedMessages.length > 0) {
      messages.push({
        role: "user",
        content: "[INTERRUPT] New message from user: 消息 B"
      })
    }
        │
        ▼
    LLM 在下一次调用时看到 [INTERRUPT]
    → 调整行为 / 回应用户 / 或继续当前任务
```

### 与 SystemEvent 的区别

| | 用户消息（Steer Mode） | SystemEvent |
|---|---|---|
| **注入方式** | `user` role 消息插入对话历史 | 系统上下文前缀注入 prompt |
| **时机** | Agent 运行中，下一轮 tool loop 立即可见 | Agent 空闲时，Heartbeat 唤醒后才可见 |
| **前缀** | `[INTERRUPT] New message from user:` | `[SYSTEM] Exec completed ...` |
| **触发者** | 用户主动发消息 | 系统事件（进程退出、cron 等） |
| **是否阻塞** | 不阻塞，注入后 Agent 自行决定如何处理 | 不阻塞，等下一次心跳处理 |

### 总结：Agent 的三种输入通道

```
                    ┌─────────────────────────────────┐
                    │          AgentRunner             │
                    │                                  │
  用户消息 ────────►│  messages[] (user role)           │  ← 正常对话
                    │                                  │
  Steer 注入 ──────►│  injectedMessages[]              │  ← Agent 运行中的实时打断
                    │    → [INTERRUPT] 前缀插入对话     │
                    │                                  │
  SystemEvent ─────►│  drainSystemEvents()             │  ← Agent 空闲时由 Heartbeat
                    │    → 注入 prompt 上下文前缀       │     唤醒后消费
                    └─────────────────────────────────┘
```

---

## 九、Heartbeat vs 直接发消息：为什么要多一层

### 对比

| | Heartbeat 唤醒 | 直接发消息给 session |
|---|---|---|
| **发起者** | 系统内部（进程退出、定时器） | 用户 / Channel / 外部 |
| **Prompt** | 专用心跳 prompt，聚焦"检查+转发" | 用户原文，作为正常对话 |
| **SystemEvent** | 主动 drain 并注入上下文 | 不涉及 |
| **可抑制** | LLM 回复 HEARTBEAT_OK 时静默吞掉 | 响应一定发回 |
| **合并** | 250ms 内多次触发合并为一次 | 每条消息独立处理 |
| **让路** | 主通道忙时跳过，稍后重试 | 排队等待 |
| **成本** | 设计上尽量省（能跳过就跳过） | 每次都完整推理 |

### 为什么不直接发消息？

因为大多数后台事件不值得打扰用户。Heartbeat 让 LLM 自己判断"这个事值不值得通知"——不值得就静默，值得才投递。直接发消息没有这层过滤。

### LLM 怎么判断"值不值得通知"？

**不是 API 字段，是 prompt 约定 + token 检测。**

#### 第一步：Prompt 指令

心跳 prompt 明确告诉 LLM，没事就回复一个特殊 token：

```typescript
// src/auto-reply/heartbeat.ts:5-6

export const HEARTBEAT_PROMPT =
  "Read HEARTBEAT.md if it exists (workspace context). " +
  "Follow it strictly. Do not infer or repeat old tasks from prior chats. " +
  "If nothing needs attention, reply HEARTBEAT_OK.";
```

对于后台进程退出事件，使用专用 prompt，要求 LLM 转发结果：

```typescript
// src/infra/heartbeat-runner.ts:94-97

const EXEC_EVENT_PROMPT =
  "An async command you ran earlier has completed. " +
  "The result is shown in the system messages above. " +
  "Please relay the command output to the user in a helpful way.";
```

#### 第二步：Token 检测

LLM 回复后，代码检测响应中是否包含 `HEARTBEAT_OK` token：

```typescript
// src/auto-reply/heartbeat.ts:96-157（简化）

export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";

export function stripHeartbeatToken(raw?: string, opts?) {
  // 检测响应中是否包含 HEARTBEAT_OK（兼容 HTML/Markdown 包裹）
  const hasToken = trimmed.includes(HEARTBEAT_TOKEN);
  if (!hasToken) {
    return { shouldSkip: false, text: trimmed };  // 没有 token → 有实质内容，需要投递
  }

  // 剥离 token 后看剩余文本
  const stripped = stripTokenAtEdges(trimmed);
  if (!stripped.text) {
    return { shouldSkip: true, text: "" };  // 只有 token，没别的 → 静默
  }

  // 剩余文本很短（≤ maxAckChars=300）→ 也静默
  if (mode === "heartbeat" && rest.length <= maxAckChars) {
    return { shouldSkip: true, text: "" };
  }

  // 剩余文本较长 → 有实质内容，需要投递
  return { shouldSkip: false, text: rest };
}
```

#### 第三步：投递决策

```typescript
// src/infra/heartbeat-runner.ts（简化）

const normalized = normalizeHeartbeatReply(replyPayload, responsePrefix, ackMaxChars);

if (normalized.shouldSkip) {
  // LLM 认为没什么值得通知的 → 静默处理
  emitHeartbeatEvent({ status: "ok-token" });
  return;
}

// LLM 有话要说 → 投递到用户的 channel
await deliverOutboundPayloads({
  channel: delivery.channel,
  to: delivery.to,
  payloads: [{ text: normalized.text }],
});
```

#### 完整判断流程

```
Heartbeat 触发
    │
    ▼
LLM 收到 prompt + SystemEvents
    │
    ├── 没什么事 → 回复 "HEARTBEAT_OK"
    │                    │
    │                    ▼
    │              stripHeartbeatToken()
    │                    → shouldSkip: true
    │                    → 静默，不打扰用户 ✓
    │
    └── 有事要报告 → 回复 "你的测试全部通过了！142 个用例..."
                         │
                         ▼
                   stripHeartbeatToken()
                         → shouldSkip: false
                         → 投递到 Telegram / Discord / Web ✓
```

这个设计的好处：**通知的决策权交给 LLM**，而不是硬编码规则。LLM 能理解上下文——比如一个 `ls` 命令后台完成了不值得通知，但一个跑了 20 分钟的测试套件完成了就值得通知。
