---
name: subagent
description: "Spawn parallel background subagents to handle multiple independent tasks concurrently. Each subagent works autonomously and delivers results back to the user."
keywords: "subagent, parallel, background, concurrent, 并行, 后台, 多任务, 同时, batch, spawn, 子任务, 分别, 各自, 一起, 帮我查, 分头"
---

# Subagent Parallel Execution Skill

You have the `subagent_spawn` tool to run multiple tasks in parallel using background subagents.

## When to Spawn Subagents

Spawn subagents when the user's request contains **multiple independent tasks** that can run concurrently. Look for patterns like:

- Explicit lists: "搜索 A、B、C" / "search for X, Y, and Z"
- Parallel intent: "同时/并行/分别/一起/分头" / "in parallel / at the same time / concurrently"
- Background intent: "后台处理" / "run in background"
- Batch operations: "帮我查一下这几个..." / "look up these things..."
- Multiple independent questions in one message

**Do NOT** use subagents for:
- A single task (just do it directly)
- Tasks that depend on each other's results (run sequentially instead)

## How to Execute

1. **Decompose** the user's request into independent sub-tasks.
2. **Call `subagent_spawn` once per sub-task** — do this in a single turn, calling the tool multiple times.
3. **Give each subagent a clear, self-contained task description** including all context it needs.
4. **Use the `label` parameter** to identify each subagent (e.g., "Search: topic A").
5. **Confirm to the user** that N subagents have been dispatched and results will arrive shortly.

### Task Description Best Practices

Each subagent runs independently with no shared context. Write task descriptions that are:
- **Self-contained**: Include all necessary context, URLs, keywords, constraints
- **Specific**: "Search for the latest price of Bitcoin and summarize in 2 sentences" not just "Bitcoin"
- **Action-oriented**: Tell the subagent exactly what to do and what output to produce

### Example

User: "帮我分别搜索一下 Rust、Go、Zig 三个语言的最新版本和主要特性"

You should call `subagent_spawn` 3 times:
```
subagent_spawn(task="Search for the latest version of Rust programming language and summarize its main features in a concise paragraph.", label="Search: Rust")
subagent_spawn(task="Search for the latest version of Go programming language and summarize its main features in a concise paragraph.", label="Search: Go")
subagent_spawn(task="Search for the latest version of Zig programming language and summarize its main features in a concise paragraph.", label="Search: Zig")
```

Then reply: "已派出 3 个子任务分别搜索 Rust、Go、Zig 的信息，结果会自动推送给你。"

## Result Delivery

Subagent results are **automatically announced** back to the session that spawned them. You do NOT need to manually send results — the system handles delivery via the originating channel (Telegram or Web UI).

## Important Notes

- Subagents **cannot** spawn other subagents (no nesting).
- Each subagent has its own session and tool access (web_search, bash, read, write, etc.).
- If a subagent fails, the error is also announced back automatically.
- Don't wait for subagent results — they arrive asynchronously. Move on or tell the user to wait.
