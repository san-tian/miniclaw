# LLM API 适配器模式：统一多 Provider 对话历史

本文档介绍如何设计一个支持多 LLM Provider（如 OpenAI、Claude）的对话系统，使用统一的内部格式存储对话历史，并在发送请求时进行格式转换。

## 问题背景

不同的 LLM API 有不同的消息格式：

**OpenAI 格式：**
```json
{
  "messages": [
    { "role": "system", "content": "You are helpful." },
    { "role": "user", "content": "Hello" },
    { "role": "assistant", "content": "Hi!", "tool_calls": [...] },
    { "role": "tool", "tool_call_id": "xxx", "content": "result" }
  ],
  "tools": [{ "type": "function", "function": { "name": "...", "parameters": {...} } }]
}
```

**Claude 格式：**
```json
{
  "system": "You are helpful.",
  "messages": [
    { "role": "user", "content": "Hello" },
    { "role": "assistant", "content": [{ "type": "tool_use", "id": "xxx", "name": "...", "input": {...} }] },
    { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "xxx", "content": "result" }] }
  ],
  "tools": [{ "name": "...", "description": "...", "input_schema": {...} }]
}
```

## 解决方案：适配器模式

```
┌─────────────────────────────────────────────────────────┐
│                    统一内部格式                          │
│              (选择 OpenAI 格式作为标准)                   │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                     LLMClient                           │
│                                                         │
│  chat(messages, tools) {                                │
│    if (format === 'claude') return chatClaude(...)      │
│    return chatOpenAI(...)                               │
│  }                                                      │
└─────────────────────────────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
┌─────────────────────┐    ┌─────────────────────┐
│   OpenAI API        │    │   Claude API        │
│   (直接发送)         │    │   (格式转换后发送)   │
└─────────────────────┘    └─────────────────────┘
```

## 实现步骤

### 1. 定义统一的消息类型

```typescript
// 使用 OpenAI 格式作为内部标准
interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string  // tool 消息需要
  tool_calls?: {         // assistant 调用工具时需要
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }[]
}

interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: object  // JSON Schema
  }
}
```

### 2. 实现 LLMClient 类

```typescript
class LLMClient {
  private format: 'openai' | 'claude'
  private apiKey: string
  private baseUrl: string
  private model: string

  async chat(messages: LLMMessage[], tools: ToolSchema[]): Promise<LLMResponse> {
    if (this.format === 'claude') {
      return this.chatClaude(messages, tools)
    }
    return this.chatOpenAI(messages, tools)
  }

  // OpenAI: 直接使用内部格式
  private async chatOpenAI(messages: LLMMessage[], tools: ToolSchema[]) {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? 'auto' : undefined,
      }),
    })
    return this.parseOpenAIResponse(response)
  }

  // Claude: 需要格式转换
  private async chatClaude(messages: LLMMessage[], tools: ToolSchema[]) {
    // 1. 提取 system 消息
    const systemMessage = messages.find(m => m.role === 'system')
    const nonSystemMessages = messages.filter(m => m.role !== 'system')

    // 2. 转换消息格式
    const claudeMessages = nonSystemMessages.map(m => this.convertToClaudeMessage(m))

    // 3. 转换工具格式
    const claudeTools = tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }))

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        system: systemMessage?.content,
        messages: claudeMessages,
        tools: claudeTools.length > 0 ? claudeTools : undefined,
      }),
    })
    return this.parseClaudeResponse(response)
  }
}
```

### 3. 消息格式转换函数

```typescript
private convertToClaudeMessage(m: LLMMessage): ClaudeMessage {
  // tool 结果消息 -> Claude 的 tool_result
  if (m.role === 'tool') {
    return {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: m.content,
      }],
    }
  }

  // assistant 的工具调用 -> Claude 的 tool_use
  if (m.tool_calls && m.tool_calls.length > 0) {
    return {
      role: 'assistant',
      content: m.tool_calls.map(tc => ({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      })),
    }
  }

  // 普通消息直接转换
  return {
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }
}
```

### 4. 响应解析与统一

两个 API 的响应也需要统一：

```typescript
interface LLMResponse {
  content: string
  toolCalls: ToolCall[]
  finishReason: string
}

interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}
```

**OpenAI 响应解析：**
```typescript
// OpenAI 返回
{
  "choices": [{
    "message": {
      "content": "Hello!",
      "tool_calls": [{
        "id": "call_123",
        "function": { "name": "bash", "arguments": "{\"cmd\":\"ls\"}" }
      }]
    }
  }]
}

// 转换为统一格式
{
  content: "Hello!",
  toolCalls: [{ id: "call_123", name: "bash", input: { cmd: "ls" } }]
}
```

**Claude 响应解析：**
```typescript
// Claude 返回
{
  "content": [
    { "type": "text", "text": "Hello!" },
    { "type": "tool_use", "id": "tu_123", "name": "bash", "input": { "cmd": "ls" } }
  ]
}

// 转换为统一格式
{
  content: "Hello!",
  toolCalls: [{ id: "tu_123", name: "bash", input: { cmd: "ls" } }]
}
```

## 格式对照表

| 概念 | OpenAI 格式 | Claude 格式 |
|-----|------------|-------------|
| System Prompt | `messages[0].role = 'system'` | `body.system` |
| 工具调用 | `assistant.tool_calls[].function` | `assistant.content[].type = 'tool_use'` |
| 工具结果 | `role: 'tool', tool_call_id` | `role: 'user', content[].type = 'tool_result'` |
| 工具定义 | `tools[].function.parameters` | `tools[].input_schema` |
| 认证头 | `Authorization: Bearer xxx` | `x-api-key: xxx` |
| API 端点 | `/chat/completions` | `/messages` |

## 存储对话历史

使用统一的内部格式存储，无需关心具体 Provider：

```typescript
interface TranscriptMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  timestamp: number
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

// 存储到文件
function saveTranscript(sessionId: string, messages: TranscriptMessage[]) {
  const path = `data/sessions/${sessionId}/transcript.json`
  writeFileSync(path, JSON.stringify(messages, null, 2))
}

// 加载并发送（自动适配 Provider）
async function continueSession(sessionId: string, userMessage: string) {
  const messages = loadTranscript(sessionId)
  messages.push({ role: 'user', content: userMessage, timestamp: Date.now() })

  const client = new LLMClient({ format: 'claude' })  // 或 'openai'
  const response = await client.chat(messages, tools)

  // 响应已经是统一格式，直接存储
  messages.push({
    role: 'assistant',
    content: response.content,
    tool_calls: response.toolCalls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.input) }
    })),
    timestamp: Date.now()
  })

  saveTranscript(sessionId, messages)
}
```

## 优势

1. **存储统一** - 对话历史格式一致，便于管理和迁移
2. **切换方便** - 只需修改 `format` 配置即可切换 Provider
3. **扩展简单** - 添加新 Provider 只需实现转换函数
4. **历史兼容** - 旧对话可以用新 Provider 继续

## 参考实现

完整实现参考 mini-claw 项目：
- `src/agents/llm-client.ts` - LLM 客户端与适配器
- `src/sessions/types.ts` - 统一的消息类型定义
- `src/sessions/manager.ts` - 对话历史管理
