# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
# Install dependencies
pnpm install

# Start Gateway server (required for all operations)
pnpm gateway

# Start interactive CLI agent (connects to Gateway)
pnpm agent

# Manage cron jobs
pnpm cron list
pnpm cron add "*/1 * * * *" "message"
pnpm cron remove <job-id>

# Send mock Telegram message
pnpm telegram "message"

# Manage agents
pnpm agents list
pnpm agents create --name "MyAgent" --model "gpt-4o"

# Manage sessions
pnpm sessions list
pnpm sessions show <session-id>

# Configuration
pnpm config init
pnpm config show
```

Runtime: **Bun** (not Node.js). Use `bun run src/cli/program.ts <command>` for direct execution.

## Architecture Overview

Mini-Claw is a multi-platform AI agent framework with a hub-and-spoke architecture:

```
Gateway (central control plane)
    ├── Channels (WebSocket, Telegram) → receive messages
    ├── FollowupQueue → steer mode (inject messages into running agents)
    ├── AgentRunner → execute LLM calls + tools
    ├── CronService → scheduled tasks
    └── SessionAPI → HTTP API for web UI
```

### Core Components

| Component | Location | Purpose |
|-----------|----------|---------|
| Gateway | `src/gateway/server.ts` | Central message router, manages agent lifecycle |
| AgentRunner | `src/agents/runner.ts` | Executes LLM calls with tool loop (max 10 iterations) |
| LLMClient | `src/agents/llm-client.ts` | Dual-format support: OpenAI and Claude APIs |
| FollowupQueue | `src/queue/followup-queue.ts` | Steer mode: inject messages into running agents |
| SessionManager | `src/sessions/manager.ts` | Persistent session storage (JSON + JSONL transcripts) |
| ProviderManager | `src/config/provider-manager.ts` | LLM provider configuration |
| BindingManager | `src/routing/manager.ts` | Route messages to agents by channel/peer/guild |

### Message Flow

1. Channel receives message → Gateway.handleMessage()
2. If agent running: queue message (steer mode injects immediately)
3. If agent idle: Gateway.processMessage() → resolve route → get/create AgentRunner
4. AgentRunner.run() → LLM call → tool execution loop → response callbacks
5. Response sent back via channel

### Configuration System

Config file: `~/.mini-claw/config.json`

- **Providers**: LLM API configurations (apiKey, baseUrl, format, models)
- **Agents**: Agent configurations (model, systemPrompt)
- **Gateway**: Port settings
- **Telegram/Composio**: Optional integrations

Web UI changes sync to local file immediately. Local file changes visible on web refresh (no restart needed for providers/agents).

### Key Patterns

- **Singleton**: SessionManager, AgentManager, ProviderManager, BindingManager (use `get*()` functions)
- **Model-to-Provider resolution**: When agent uses a model, `ProviderManager.getProviderByModel()` finds the correct provider's apiKey/format
- **Tool execution**: Tools in `src/agents/tools/` implement `Tool` interface with `execute()` method

### Data Storage

```
~/.mini-claw/config.json     # Main configuration
data/
├── cron.json                # Cron jobs
├── agents/agents.json       # Agent configs
├── sessions/
│   ├── sessions.json        # Session metadata
│   └── transcripts/*.jsonl  # Message history
└── routing/bindings.json    # Channel-to-agent bindings
```

## Adding New Components

**New Tool**: Create file in `src/agents/tools/`, export object implementing `Tool` interface, add to `tools` array in `index.ts`

**New Channel**: Implement `Channel` interface, register in Gateway constructor via `ChannelRegistry`

**New Skill**: Create `skills/<name>/SKILL.md` - automatically loaded and appended to system prompt
