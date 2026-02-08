# OpenClaw 架构解析

## 项目概述

OpenClaw 是一个**个人 AI 助手平台**，运行在用户自己的设备上。它通过多种消息渠道（WhatsApp、Telegram、Slack、Discord、Signal、iMessage 等）与用户交互，核心是一个 Gateway 控制平面 + Pi Agent 运行时的架构。

## 核心功能
1. 通过web 终端 以及社交平台进行对话
2. 可以随时打断对话，询问当前进展或修改目标
3. 支持skill
4. 支持tool
5. 支持24*7在线
6. 在本地运行代码

### 核心功能实现原理

#### 1. 多平台对话

**实现**：Channel Plane 的适配器模式

```
每个平台一个适配器:
- src/telegram/ → grammY SDK
- src/discord/  → discord.js
- src/slack/    → Bolt SDK
- src/web/      → Baileys (WhatsApp Web)
- ui/           → WebChat (直连 Gateway WebSocket)
```

所有适配器将消息转为统一格式后交给 Gateway，响应时再转回平台格式。

#### 2. 随时打断对话

**实现**：Followup Queue + `steer` 模式

```typescript
// src/auto-reply/reply/queue/
// 用户新消息进入队列，如果 mode=steer:
// → 直接注入当前 streaming 的 agent
// → agent 看到新输入，可以中断工具调用，先回应
```

关键：Agent 运行时支持**中途注入消息**，不是等任务完成才处理。

#### 3. Skill 支持

**实现**：`skills/` 目录 + Skill 加载器

```
~/.openclaw/workspace/skills/<skill>/SKILL.md
```

- 每个 Skill 是一个目录，包含 `SKILL.md`（提示词）和可选的工具定义
- Gateway 启动时扫描 `skills/`，注入到 Agent 的系统提示
- Agent 根据用户意图调用对应 Skill

#### 4. Tool 支持

**实现**：Tool Use 协议 + 工具注册

```typescript
// src/agents/tools/
// 每个工具定义: name, description, inputSchema, execute()

// Agent 调用流程:
LLM 返回 tool_use → Gateway 执行 execute() → 结果返回 LLM
```

内置工具：`bash`, `read`, `write`, `browser`, `canvas`, `cron` 等。

#### 5. 24×7 在线

**实现**：Gateway 常驻 + Cron 定时唤醒

```
不是 Agent 持续运行，而是:
Gateway (systemd/launchd 守护进程)
    └── CronService → 定时触发 → 启动 Agent → 执行 → 结束
```

- 任务持久化在 `~/.openclaw/cron/jobs.json`
- Gateway 重启自动恢复调度

#### 6. 本地运行代码

**实现**：`bash` 工具 + 安全沙箱

```typescript
// src/agents/tools/bash-tool.ts
// Agent 生成命令 → Gateway 在本地执行 → 返回 stdout/stderr

// 安全选项:
// agents.defaults.sandbox.mode: "non-main" → 非主会话在 Docker 沙箱执行
```

支持：shell 命令、Python/Node 脚本、编译运行等。

#### 功能实现总结

| 功能 | 实现机制 |
|------|----------|
| 多平台对话 | 适配器模式，统一消息格式 |
| 随时打断 | 消息队列 + steer 注入 |
| Skill | SKILL.md 提示词注入 |
| Tool | Tool Use 协议 + execute() |
| 24×7 | Gateway 守护 + Cron 调度 |
| 本地代码 | bash 工具 + 可选沙箱 |

### 次要功能（锦上添花）
1. 记忆系统

---

## 运行结构 - 四层 Plane 模型

```
┌─────────────────────────────────────────────────────────────────┐
│                     Channel Plane (频道层)                       │
│  WhatsApp │ Telegram │ Slack │ Discord │ Signal │ Web │ ...    │
└─────────────────────────────────────────────────────────────────┘
                              ↓ ↑
┌─────────────────────────────────────────────────────────────────┐
│                     Control Plane (控制层)                       │
│  Gateway: 路由 │ 会话 │ 配置 │ 安全 │ 队列 │ Cron │ WebSocket   │
└─────────────────────────────────────────────────────────────────┘
                              ↓ ↑
┌─────────────────────────────────────────────────────────────────┐
│                     Agent Plane (智能层)                         │
│  Pi Agent: LLM 调用 │ Tool Use │ Streaming │ 上下文管理          │
└─────────────────────────────────────────────────────────────────┘
                              ↓ ↑
┌─────────────────────────────────────────────────────────────────┐
│                     Execution Plane (执行层)                     │
│  Tools │ Skills │ Browser │ Code │ Media │ Memory │ Canvas      │
└─────────────────────────────────────────────────────────────────┘
```

### 1. Channel Plane (频道层)

**职责**：用户触达，消息收发

| 组件 | 说明 |
|------|------|
| 内置频道 | WhatsApp, Telegram, Slack, Discord, Signal, iMessage |
| 扩展频道 | Teams, Matrix, Zalo, BlueBubbles |
| Web 入口 | Control UI, WebChat |
| 原生 App | macOS 菜单栏, iOS/Android 节点 |


### 2. Control Plane (控制层)

**职责**：调度中枢，状态管理

| 组件 | 说明 |
|------|------|
| Gateway | WebSocket 服务，单一控制平面 |
| Router | 消息路由，决定哪个 Agent 处理 |
| Session | 会话管理，上下文隔离 |
| Queue | 多级队列，处理并发消息 |
| Cron | 定时任务调度 |
| Security | 配对验证，白名单 |


### 3. Agent Plane (智能层)

**职责**：LLM 交互，决策推理

| 组件 | 说明 |
|------|------|
| Pi Agent | 基于 `@mariozechner/pi-*` 的运行时 |
| LLM 调用 | Anthropic, OpenAI, Bedrock, Ollama |
| Tool Use | 工具调用协议 |
| Streaming | 实时输出，支持 steer 注入 |
| Context | 上下文窗口管理 |


### 4. Execution Plane (执行层)

**职责**：实际动作，能力扩展

| 组件 | 说明 |
|------|------|
| Tools | 内置工具（文件、网络、系统） |
| Skills | 55+ 技能包（GitHub, Notion, 1Password...） |
| Browser | Playwright 浏览器自动化 |
| Code | 本地代码执行 |
| Media | 图片/音频/视频处理 |
| Memory | 记忆系统（LanceDB 等） |
| Canvas | A2UI 可视化渲染 |


### 数据流示例

```
用户在 Telegram 发消息 "帮我查一下 GitHub 上的 issue"
        │
        ▼
[Channel Plane] Telegram 适配器接收，转为统一格式
        │
        ▼
[Control Plane] Gateway 路由 → 入队 → 分配 Agent
        │
        ▼
[Agent Plane] Pi Agent 调用 Claude，决定使用 GitHub skill
        │
        ▼
[Execution Plane] GitHub skill 执行 API 调用，返回结果
        │
        ▼
[Agent Plane] 组装回复
        │
        ▼
[Control Plane] 通过 Reply Dispatcher 发送
        │
        ▼
[Channel Plane] Telegram 适配器发送消息给用户
```

---

## 异步消息队列机制

### 问题：Agent 处理中，用户发新消息怎么办？

OpenClaw 使用**多级队列**解决：

```
用户消息 → Followup Queue (会话级) → Command Queue (进程级) → Agent 执行
              ↑                           ↑
         每会话一个队列              按 Lane 分组并发
```

### 会话级队列 (Followup Queue)

```typescript
// src/auto-reply/reply/queue/state.ts
FOLLOWUP_QUEUES: Map<string, {
  items: FollowupRun[],    // 排队的消息
  draining: boolean,       // 是否正在消费
  mode: QueueMode,         // 处理模式
  cap: 20                  // 最大容量
}>
```

### 队列模式

| 模式 | 行为 |
|------|------|
| `steer` | **立即注入**当前运行中的 agent（取消待执行的 tool call） |
| `collect` | **默认**，等当前 run 结束后，合并所有排队消息为一个 followup |
| `followup` | 排队等下一轮，不合并 |
| `interrupt` | 中止当前 run，执行最新消息 |

**`steer` 模式**允许用户随时询问进度：新消息直接注入正在 streaming 的 agent。

### 进程级并发控制 (Lanes)

```typescript
// src/process/lanes.ts
Main:     maxConcurrent = 4   // 普通消息
Subagent: maxConcurrent = 8   // 子 agent
Cron:     maxConcurrent = 2   // 定时任务
```

**关键约束**：同一会话同时只有 **1 个** agent run。

### 流程示例

```
T0: 用户发 "帮我分析这个文件"
    → Agent 开始处理，调用工具读文件...

T1: 用户发 "进度如何？"
    → 进入 FollowupQueue
    → 如果 mode=steer: 立即注入 agent，agent 可以回复进度
    → 如果 mode=collect: 等 T0 完成后再处理

T2: Agent 完成 T0
    → 自动 drain 队列，处理 T1 的消息
```

---

## Cron 定时任务系统

### 核心思路

```
不是: Agent 持续运行 24 小时 ❌
而是: 定时唤醒 Agent 执行检查 ✅
```

### 架构

```
Gateway (常驻进程)
    │
    └── CronService (定时器)
            │
            ├── jobs.json (持久化存储)
            │
            └── 到点触发 → 启动 Agent → 执行任务 → 结束
                              ↓
                         可选：发送结果到 Slack/Telegram
```

### 任务持久化

存储位置：`~/.openclaw/cron/jobs.json`

```json
{
  "jobs": [{
    "id": "uuid-xxx",
    "name": "Website monitor",
    "schedule": { "kind": "cron", "expr": "*/5 * * * *" },
    "payload": { "kind": "agentTurn", "message": "检查网站是否正常" },
    "state": {
      "nextRunAtMs": 1707123456000,
      "lastRunAtMs": 1707123156000,
      "lastStatus": "ok"
    }
  }]
}
```

### 两种执行模式

| 模式 | 说明 |
|------|------|
| `main` | 注入主会话，和日常对话混在一起 |
| `isolated` | **推荐** - 独立会话 `cron:<jobId>`，不污染主聊天 |

### 支持的调度方式

```typescript
// 一次性
{ kind: "at", at: "2024-02-05T10:00:00Z" }

// 固定间隔
{ kind: "every", everyMs: 300000 }  // 每 5 分钟

// Cron 表达式
{ kind: "cron", expr: "*/5 * * * *", tz: "Asia/Shanghai" }
```

### 使用示例

```bash
# 每 5 分钟检查网站，结果发到 Slack
openclaw cron add \
  --name "网站监控" \
  --cron "*/5 * * * *" \
  --session isolated \
  --message "检查 example.com 是否正常，如有异常立即报告" \
  --announce \
  --channel slack \
  --to "channel:C1234567890"
```

### 重启恢复

Gateway 重启后：
1. 加载 `jobs.json`
2. 重新计算 `nextRunAtMs`
3. 设置定时器
4. 继续调度（任务不丢失）

---

## 关键文件路径

| 组件 | 路径 |
|------|------|
| 命令队列 | `src/process/command-queue.ts` |
| 队列 Lanes | `src/process/lanes.ts` |
| Followup 队列 | `src/auto-reply/reply/queue/` |
| Cron 服务 | `src/cron/service.ts` |
| Cron 存储 | `src/cron/store.ts` |
| 会话管理 | `src/sessions/` |
| 消息路由 | `src/routing/router.ts` |
| Agent 运行时 | `src/agents/` |

---

## 总结

OpenClaw 的核心设计：

1. **Gateway 控制平面**：统一管理所有频道、会话、配置
2. **多级队列**：处理并发消息，支持 steer/collect 等模式
3. **Cron 定时任务**：持久化调度，支持长期监控任务
4. **插件机制**：通过 plugin-sdk 扩展频道、工具、记忆后端

本质上是一个**多频道统一入口 + LLM Agent + 工具调用**的架构，Gateway 做消息中转和状态管理，Agent 做智能处理。
