# OpenClaw Subagent 系统详解

本文档介绍 OpenClaw 中的 Subagent（子代理）系统，包括架构设计、使用方法和实现细节。

## 概述

Subagent 是 OpenClaw 的核心功能之一，允许主代理生成隔离的后台代理来执行特定任务。任务完成后，结果会自动通告回主代理。

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                        主代理 (Main Agent)                   │
│                                                             │
│  用户: "帮我研究 AI 趋势，同时分析这份数据"                    │
│                                                             │
│  主代理: 我来创建两个后台任务...                              │
│         ├─→ sessions_spawn("研究 AI 趋势")                  │
│         └─→ sessions_spawn("分析数据")                      │
└─────────────────────────────────────────────────────────────┘
                    │                       │
                    ▼                       ▼
┌─────────────────────────┐   ┌─────────────────────────┐
│   Subagent 1            │   │   Subagent 2            │
│   (隔离会话)             │   │   (隔离会话)             │
│                         │   │                         │
│   任务: 研究 AI 趋势     │   │   任务: 分析数据         │
│   状态: 运行中...        │   │   状态: 运行中...        │
└─────────────────────────┘   └─────────────────────────┘
                    │                       │
                    ▼                       ▼
┌─────────────────────────────────────────────────────────────┐
│                      通告流程 (Announce)                     │
│                                                             │
│  Subagent 完成 → 收集结果 → 发送回主代理 → 通知用户          │
└─────────────────────────────────────────────────────────────┘
```

## 核心文件

| 文件 | 功能 |
|------|------|
| `src/agents/tools/sessions-spawn-tool.ts` | `sessions_spawn` 工具实现 |
| `src/agents/subagent-registry.ts` | Subagent 生命周期管理 |
| `src/agents/subagent-announce.ts` | 结果通告流程 |
| `src/auto-reply/reply/commands-subagents.ts` | `/subagents` 命令处理 |

## 使用方法

### 1. 创建 Subagent

主代理通过 `sessions_spawn` 工具创建 subagent：

```typescript
// 工具参数
{
  task: string;              // 必需：任务描述
  label?: string;            // 可选：运行标签（便于识别）
  model?: string;            // 可选：覆盖模型
  thinking?: string;         // 可选：思考级别 (off/low/medium/high)
  runTimeoutSeconds?: number; // 可选：超时时间
  cleanup?: "delete" | "keep"; // 可选：完成后是否删除会话
}
```

**示例调用：**
```json
{
  "task": "Research the latest AI trends and summarize key findings",
  "label": "AI Research",
  "model": "claude-sonnet-4-5",
  "runTimeoutSeconds": 300,
  "cleanup": "keep"
}
```

**返回结果：**
```json
{
  "status": "accepted",
  "childSessionKey": "agent:main:subagent:550e8400-e29b-41d4-a716-446655440000",
  "runId": "run-12345"
}
```

### 2. 管理 Subagent

使用 `/subagents` 命令管理：

```bash
/subagents list              # 列出所有 subagent
/subagents stop <id|#|all>   # 停止指定的 subagent
/subagents log <id|#>        # 查看 subagent 日志
/subagents info <id|#>       # 查看详细信息
/subagents send <id|#> <msg> # 向 subagent 发送消息
```

**列表输出示例：**
```
🧭 Subagents (current session)
Active: 1 · Done: 2

1) running · AI Research · 2m30s · run 550e8400
2) done · Data Analysis · 5m12s · run 123abc45
```

## 实现细节

### 1. 创建流程

```typescript
// sessions-spawn-tool.ts 核心逻辑

// 1. 生成子会话键
const childSessionKey = `agent:${agentId}:subagent:${crypto.randomUUID()}`;

// 2. 构建 subagent 系统提示
const childSystemPrompt = buildSubagentSystemPrompt({
  requesterSessionKey,
  childSessionKey,
  task,
  label,
});

// 3. 启动后台运行
const response = await callGateway({
  method: "agent",
  params: {
    message: task,
    sessionKey: childSessionKey,
    deliver: false,  // 不直接交付，等待通告
    lane: AGENT_LANE_SUBAGENT,
    extraSystemPrompt: childSystemPrompt,
  },
});

// 4. 注册运行以便跟踪
registerSubagentRun({
  runId: response.runId,
  childSessionKey,
  requesterSessionKey,
  task,
  cleanup,
});
```

### 2. Subagent 系统提示

每个 subagent 会收到特殊的系统提示：

```markdown
# Subagent Context

You are a **subagent** spawned by the main agent for a specific task.

## Your Role
- You were created to handle: [任务描述]
- Complete this task. That's your entire purpose.
- You are NOT the main agent. Don't try to be.

## Rules
1. **Stay focused** - Do your assigned task, nothing else
2. **Complete the task** - Your final message will be reported to the main agent
3. **Don't initiate** - No heartbeats, no proactive actions
4. **Be ephemeral** - You may be terminated after completion

## Session Context
- Label: [标签]
- Requester: [请求者会话]
- Your session: [子会话键]
```

### 3. 生命周期管理

```typescript
// subagent-registry.ts

// 监听生命周期事件
onAgentEvent((evt) => {
  if (evt.stream === "lifecycle") {
    const { phase, runId } = evt;

    if (phase === "start") {
      // 记录开始时间
      updateRun(runId, { startedAt: Date.now() });
    }

    if (phase === "end" || phase === "error") {
      // 记录结束，触发通告
      updateRun(runId, {
        endedAt: Date.now(),
        outcome: phase === "end" ? "ok" : "error"
      });
      triggerAnnounce(runId);
    }
  }
});
```

### 4. 通告流程

```typescript
// subagent-announce.ts

async function runSubagentAnnounceFlow(params) {
  // 1. 获取 subagent 的最终回复
  const reply = await getLastAssistantMessage(params.childSessionKey);

  // 2. 收集统计信息
  const stats = {
    duration: params.endedAt - params.startedAt,
    tokens: await getTokenUsage(params.runId),
  };

  // 3. 构建通告消息
  const triggerMessage = `
A background task "${params.label}" just completed.

Findings:
${reply}

Duration: ${formatDuration(stats.duration)}
Tokens: ${stats.tokens}

Summarize this naturally for the user.
`;

  // 4. 发送回主代理
  await callGateway({
    method: "agent",
    params: {
      sessionKey: params.requesterSessionKey,
      message: triggerMessage,
      deliver: true,  // 交付给用户
    },
  });

  // 5. 清理（如果配置了 cleanup: "delete"）
  if (params.cleanup === "delete") {
    await deleteSession(params.childSessionKey);
  }
}
```

## 配置选项

### openclaw.json 配置

```json5
{
  "agents": {
    "defaults": {
      "subagents": {
        "maxConcurrent": 8,           // 最大并发数
        "archiveAfterMinutes": 60,    // 自动归档时间
        "model": "claude-sonnet-4-5", // 默认模型
        "thinking": "low"             // 默认思考级别
      }
    }
  },
  "tools": {
    "subagents": {
      "tools": {
        "deny": ["gateway", "cron"],  // 禁止的工具
        // "allow": ["read", "bash"]  // 或使用允许列表
      }
    }
  }
}
```

### 工具限制

Subagent 默认**不能访问**以下工具（防止嵌套和混乱）：
- `sessions_list` - 列出会话
- `sessions_history` - 查看历史
- `sessions_send` - 发送消息
- `sessions_spawn` - 创建 subagent（**禁止嵌套**）

## Agent-to-Agent 通信

除了 subagent，OpenClaw 还支持代理间直接通信：

### 启用配置

```json5
{
  "tools": {
    "agentToAgent": {
      "enabled": true,
      "allow": ["agent1", "agent2", "agent3"]
    }
  }
}
```

### 使用 sessions_send

```typescript
// 代理 A 向代理 B 发送消息
{
  "agentId": "agent-b",
  "label": "work-session",
  "message": "Can you help me analyze this?",
  "timeoutSeconds": 30
}
```

### Ping-Pong 对话

Agent-to-Agent 支持最多 5 轮来回对话：

```
Agent A: "请帮我分析这个数据"
    ↓
Agent B: "好的，你需要什么类型的分析？"
    ↓
Agent A: "主要看趋势和异常值"
    ↓
Agent B: "明白了，这是分析结果..."
    ↓
(结束或继续，最多 5 轮)
```

代理可以回复特殊标记停止对话：
- `REPLY_SKIP` - 停止 ping-pong
- `ANNOUNCE_SKIP` - 不发送最终通告

## 数据结构

### SubagentRunRecord

```typescript
interface SubagentRunRecord {
  runId: string;                    // 运行 ID
  childSessionKey: string;          // 子会话键
  requesterSessionKey: string;      // 请求者会话
  task: string;                     // 任务描述
  label?: string;                   // 标签
  cleanup: "delete" | "keep";       // 清理策略
  createdAt: number;                // 创建时间
  startedAt?: number;               // 开始时间
  endedAt?: number;                 // 结束时间
  outcome?: "ok" | "error" | "timeout"; // 结果
}
```

## Session 清理机制

Subagent 完成后，session 的处理取决于 `cleanup` 参数：

### cleanup 参数

| 值 | 行为 |
|----|------|
| `"keep"` (默认) | 保留 session，延迟归档 |
| `"delete"` | 完成后立即删除 |

### 延迟归档流程

```typescript
// subagent-registry.ts

// 1. 注册时计算归档时间
const archiveAfterMs = config.agents?.defaults?.subagents?.archiveAfterMinutes ?? 60
const archiveAtMs = Date.now() + archiveAfterMs * 60_000

// 2. 启动定时清理器
function startSweeper() {
  sweeper = setInterval(() => {
    sweepSubagentRuns()
  }, 60_000)  // 每分钟检查一次
}

// 3. 清理过期的 session
async function sweepSubagentRuns() {
  const now = Date.now()
  for (const [runId, entry] of subagentRuns.entries()) {
    if (entry.archiveAtMs && entry.archiveAtMs <= now) {
      // 从注册表删除
      subagentRuns.delete(runId)
      // 调用 gateway 删除 session
      await callGateway({
        method: "sessions.delete",
        params: { key: entry.childSessionKey, deleteTranscript: true },
      })
    }
  }
}
```

### 清理流程图

```
subagent 完成
    │
    ├─ cleanup="delete" ──→ 立即删除 session + transcript
    │
    └─ cleanup="keep" ────→ 保留 session
                               │
                               └─ archiveAfterMinutes 后
                                      │
                                      └─ sweeper 自动删除
```

## Registry 持久化

Subagent 运行记录会持久化到磁盘，支持 gateway 重启后恢复：

```typescript
// subagent-registry.store.ts

// 保存路径: ~/.openclaw/subagent-registry.json
function saveSubagentRegistryToDisk(runs: Map<string, SubagentRunRecord>) {
  const data = Object.fromEntries(runs)
  writeFileSync(registryPath, JSON.stringify(data, null, 2))
}

// 启动时恢复
function loadSubagentRegistryFromDisk(): Map<string, SubagentRunRecord> {
  if (!existsSync(registryPath)) return new Map()
  const data = JSON.parse(readFileSync(registryPath, 'utf-8'))
  return new Map(Object.entries(data))
}
```

### 恢复流程

```typescript
function restoreSubagentRunsOnce() {
  const restored = loadSubagentRegistryFromDisk()

  for (const [runId, entry] of restored.entries()) {
    subagentRuns.set(runId, entry)

    // 恢复未完成的 subagent
    if (!entry.endedAt) {
      // 重新等待完成
      waitForSubagentCompletion(runId, waitTimeoutMs)
    } else if (!entry.cleanupCompletedAt) {
      // 重新触发通告流程
      runSubagentAnnounceFlow(entry)
    }
  }
}
```

## 跨 Agent Spawn

Subagent 可以使用不同的 agent 配置：

```typescript
// sessions-spawn-tool.ts

// 1. 确定目标 agent
const targetAgentId = requestedAgentId
  ? normalizeAgentId(requestedAgentId)
  : requesterAgentId  // 默认使用当前 agent

// 2. 权限检查（跨 agent 需要授权）
if (targetAgentId !== requesterAgentId) {
  const allowAgents = resolveAgentConfig(cfg, requesterAgentId)
    ?.subagents?.allowAgents ?? []

  if (!allowAgents.includes(targetAgentId) && !allowAgents.includes("*")) {
    return { status: "forbidden", error: "agentId not allowed" }
  }
}

// 3. 加载目标 agent 的配置
const targetAgentConfig = resolveAgentConfig(cfg, targetAgentId)
```

### 配置示例

```json5
{
  "agents": {
    "list": [
      {
        "id": "main",
        "subagents": {
          "allowAgents": ["researcher", "coder"],  // 允许 spawn 这些 agent
          "model": "claude-sonnet-4-5"             // subagent 默认模型
        }
      },
      {
        "id": "researcher",
        "model": "claude-opus-4-5",
        "identity": { "name": "Research Assistant" }
      }
    ]
  }
}
```

## 限制和注意事项

1. **禁止嵌套** - Subagent 不能创建 subagent（session key 包含 `:subagent:` 时拒绝）
2. **持久化恢复** - Gateway 重启后会恢复未完成的 subagent
3. **工具受限** - Subagent 默认无法访问会话工具
4. **上下文有限** - 仅注入基础文档，不含完整人格设定
5. **并发限制** - 默认最多 8 个并发 subagent

## 使用场景

1. **并行研究** - 同时研究多个主题
2. **后台任务** - 长时间运行的分析任务
3. **专业分工** - 不同 agent 处理不同领域
4. **异步处理** - 用户无需等待的任务

---

# Mini-Claw Subagent 实现

Mini-Claw 参考 OpenClaw 实现了简化版的 subagent 系统。

## 文件结构

```
mini-claw/src/agents/
├── subagent/
│   ├── types.ts          # 类型定义
│   ├── registry.ts       # 注册表管理
│   ├── announce.ts       # 通告机制
│   └── index.ts          # 导出
└── tools/
    └── subagent-spawn.ts # spawn 工具
```

## 核心组件

### 1. SubagentRegistry

管理 subagent 生命周期和持久化：

```typescript
// registry.ts
class SubagentRegistry {
  private runs: Map<string, SubagentRunRecord> = new Map()

  // 注册新的 subagent 运行
  register(params: {
    runId: string
    childSessionKey: string
    requesterSessionKey: string
    task: string
    cleanup: 'delete' | 'keep'
  }): void

  // 标记完成
  markCompleted(runId: string, outcome: SubagentOutcome): void

  // 注册完成回调
  onCompletion(runId: string, callback: (record) => void): void

  // 列出请求者的所有 subagent
  listByRequester(requesterSessionKey: string): SubagentRunRecord[]
}
```

### 2. subagent_spawn 工具

```typescript
// subagent-spawn.ts
export const subagentSpawnTool: Tool = {
  name: 'subagent_spawn',
  description: 'Spawn a background sub-agent...',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'The task to perform' },
      label: { type: 'string', description: 'Optional label' },
      cleanup: { type: 'string', description: 'delete or keep' },
    },
    required: ['task'],
  },
  execute: async (input) => {
    // 1. 生成 runId 和 childSessionKey
    // 2. 创建子会话
    // 3. 注册到 registry
    // 4. 返回 accepted 状态
  },
}
```

### 3. 禁止嵌套

通过工具过滤实现：

```typescript
// tools/index.ts
const SUBAGENT_DENIED_TOOLS = new Set(['subagent_spawn'])

export function getAllTools(options?: { isSubagent?: boolean }): Tool[] {
  let allTools = [...builtinTools, ...composioTools]

  if (options?.isSubagent) {
    allTools = allTools.filter((t) => !SUBAGENT_DENIED_TOOLS.has(t.name))
  }

  return allTools
}
```

### 4. AgentRunner 支持

```typescript
// runner.ts
export interface AgentRunnerConfig {
  agentConfig?: AgentConfig
  llmConfig?: LLMClientConfig
  isSubagent?: boolean           // 标记为 subagent
  extraSystemPrompt?: string     // 额外系统提示
}

// 在 run() 中使用过滤后的工具
const toolSchemas = getToolSchemas({ isSubagent: this.isSubagent })
```

## 与 OpenClaw 的对比

| 功能 | OpenClaw | Mini-Claw |
|------|----------|-----------|
| Subagent spawn | ✅ `sessions_spawn` | ✅ `subagent_spawn` |
| 禁止嵌套 | ✅ session key 检查 | ✅ 工具过滤 |
| Registry 持久化 | ✅ 完整 | ✅ 简化版 |
| 生命周期事件 | ✅ gateway 事件 | ⚠️ 回调方式 |
| 通告机制 | ✅ 自动发送 | ✅ Debounce + Collect |
| 跨 Agent spawn | ✅ 支持 | ❌ 未实现 |
| 延迟归档 | ✅ sweeper | ✅ sweeper |

## 通告机制（Announce Flow）

Mini-Claw 实现了完整的 **Debounce + Collect** 通告模式，核心在 `src/agents/subagent/announce.ts`。

### 单个 Subagent 完成

```
subagent 完成
    │
    ▼
runAnnounceFlow()
    │  读取子会话最后一条 assistant 消息作为 findings
    ▼
enqueueAnnounce()
    │  入队 ANNOUNCE_QUEUES，启动 2s debounce 定时器
    ▼
(2s 无新结果)
    │
    ▼
drainQueue() → buildTriggerMessage()
    │  构建单条摘要消息
    ▼
gatewayRef.triggerAgent()
    │  主 agent 运行中 → steer 模式注入
    │  主 agent 空闲   → 重新唤起
    ▼
主 agent 生成自然语言摘要 → 回复用户
```

### 多个 Subagent 并发完成（Collect 模式）

当多个 subagent 在 2 秒窗口内陆续完成时，结果会被聚合：

```
subagent A 完成 → enqueue → 重置 2s 定时器
subagent B 完成 → enqueue → 重置 2s 定时器
subagent C 完成 → enqueue → 重置 2s 定时器
                                │
                          (2s 无新结果)
                                │
                                ▼
                    drainQueue() 检测队列 > 1 条
                                │
                                ▼
                    buildCollectedTriggerMessage()
                    合并所有结果为一条消息:
                    ┌──────────────────────────────┐
                    │ [3 background tasks completed]│
                    │                              │
                    │ --- Task 1: "A" (completed) --│
                    │ findings...                   │
                    │ --- Task 2: "B" (completed) --│
                    │ findings...                   │
                    │ --- Task 3: "C" (completed) --│
                    │ findings...                   │
                    │                              │
                    │ Summarize all findings...     │
                    └──────────────────────────────┘
                                │
                                ▼
                    gatewayRef.triggerAgent() 一次性发送
                                │
                                ▼
                    主 agent 综合所有结果回复用户
```

### 关键设计

| 参数 | 值 | 说明 |
|------|-----|------|
| `DEBOUNCE_MS` | 2000ms | 等待更多结果的窗口期 |
| 队列键 | `requesterSessionKey` | 按请求者会话隔离队列 |
| 防重入 | `draining` 标志 | 防止并发 drain |

### triggerAgent 的两种路径

通过 `gateway-ref.ts` 的 `triggerAgent()` 方法：

- **steered** — 主 agent 正在运行，消息以 `[INTERRUPT]` 前缀注入当前对话上下文
- **invoked** — 主 agent 空闲，重新唤起一轮 LLM 调用处理结果

主 agent 收到的 trigger 消息末尾附带指令：*"Summarize this naturally for the user. Keep it brief."*，因此用户看到的是自然语言摘要而非原始数据。

### 错误处理

subagent 执行失败时同样走 announce 流程，`outcome.status` 为 `"error"`，trigger 消息中包含错误信息，主 agent 会据此告知用户任务失败原因。

### 空闲唤醒：Mini-Claw vs OpenClaw（Heartbeat）

Mini-Claw 在主 agent 空闲时直接调用 `processMessage()` 发起一轮完整的 agent 调用。OpenClaw 则通过 **Heartbeat + SystemEvent** 机制实现更精细的控制。

**OpenClaw 的 Heartbeat 路径：**

```
后台任务完成
  → enqueueSystemEvent()        ← 事件入队（不直接发给 agent）
  → requestHeartbeatNow()       ← 请求即时心跳（250ms 合并窗口）
    → runHeartbeatOnce()        ← 心跳运行器
      → LLM 看到 SystemEvent + 专用 prompt
      → LLM 判断是否值得通知
        → 不值得 → 回复 HEARTBEAT_OK → 静默吞掉
        → 值得   → 回复摘要 → 投递到用户 channel
```

**Mini-Claw 的简化路径：**

```
subagent 完成
  → enqueueAnnounce()           ← 入队 + 2s debounce
  → drainQueue()
    → triggerAgent()
      → processMessage()        ← 直接发起完整 agent 调用，无过滤
      → agent 必定回复用户
```

**差异对比：**

| | OpenClaw (Heartbeat) | Mini-Claw (直接调用) |
|---|---|---|
| **LLM 过滤** | 有，LLM 可回复 `HEARTBEAT_OK` 静默 | 无，每次都完整推理并回复 |
| **活跃时段** | 尊重 `activeHours`，半夜不打扰 | 无，随时触发 |
| **队列冲突** | 主通道忙时跳过，稍后重试 | 无检查，可能和用户消息并发 |
| **事件合并** | 250ms 合并窗口 | 2s debounce（更粗粒度） |
| **成本控制** | 能跳过就跳过，省 token | 每次都完整调用 |
| **通知决策权** | LLM 自主判断值不值得通知 | 无过滤，一律通知 |

> **注意**：Mini-Claw 当前的实现是有意简化。如需对齐 OpenClaw 行为，需引入 `heartbeat-wake` + `SystemEvent` 基础设施，让 LLM 自己决定"这个结果值不值得通知用户"。详见 `docs/openclaw-async-tools.md` 第七节。

## 待完善功能

1. **Heartbeat 集成** - 引入 Heartbeat + SystemEvent 机制，空闲唤醒时让 LLM 过滤噪音
2. **跨 Agent spawn** - 支持指定不同的 agent 配置
3. **并发控制** - 限制最大并发 subagent 数量
