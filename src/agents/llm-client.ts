// LLM Client: Supports OpenAI and Claude API formats
import { env } from '../infra/env.js'
import { createLogger } from '../infra/logger.js'
import type { ToolCall } from './tools/index.js'

const log = createLogger('llm')

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }[]
}

export interface LLMResponse {
  content: string
  toolCalls: ToolCall[]
  finishReason: string
}

export interface StreamCallbacks {
  onChunk?: (text: string) => void
  onToolCall?: (name: string, input: Record<string, unknown>) => void
}

export interface LLMClientConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
  format?: 'openai' | 'claude'
}

export class LLMClient {
  private apiKey: string
  private baseUrl: string
  private model: string
  private format: 'openai' | 'claude'

  constructor(config?: LLMClientConfig) {
    this.apiKey = config?.apiKey || env.LLM_API_KEY
    this.baseUrl = config?.baseUrl || env.LLM_BASE_URL
    this.model = config?.model || env.LLM_MODEL
    this.format = config?.format || env.LLM_FORMAT
  }

  getModel(): string {
    return this.model
  }

  async chat(
    messages: LLMMessage[],
    tools: object[],
    callbacks?: StreamCallbacks,
    signal?: AbortSignal
  ): Promise<LLMResponse> {
    if (this.format === 'claude') {
      return this.chatClaude(messages, tools, callbacks, signal)
    }
    return this.chatOpenAI(messages, tools, callbacks, signal)
  }

  private async chatOpenAI(
    messages: LLMMessage[],
    tools: object[],
    callbacks?: StreamCallbacks,
    signal?: AbortSignal
  ): Promise<LLMResponse> {
    const url = `${this.baseUrl}/chat/completions`

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
    }

    if (tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }

    log.info(`Calling OpenAI API: ${this.model}`)
    log.info(`Tools count: ${tools.length}, names: ${tools.map((t: any) => t.function?.name).join(', ')}`)

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`OpenAI API error: ${response.status} ${error}`)
    }

    return this.parseOpenAIStream(response, callbacks)
  }

  private async parseOpenAIStream(
    response: Response,
    callbacks?: StreamCallbacks
  ): Promise<LLMResponse> {
    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    let content = ''
    const toolCalls: ToolCall[] = []
    const toolCallBuffers: Map<number, { id: string; name: string; args: string }> = new Map()
    let finishReason = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      const lines = chunk.split('\n').filter((l) => l.startsWith('data: '))

      for (const line of lines) {
        const data = line.slice(6)
        if (data === '[DONE]') continue

        try {
          const parsed = JSON.parse(data)
          const delta = parsed.choices?.[0]?.delta
          const finish = parsed.choices?.[0]?.finish_reason

          if (finish) {
            finishReason = finish
          }

          if (delta?.content) {
            content += delta.content
            callbacks?.onChunk?.(delta.content)
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
              if (!toolCallBuffers.has(idx)) {
                toolCallBuffers.set(idx, { id: tc.id || '', name: '', args: '' })
              }
              const buf = toolCallBuffers.get(idx)!
              if (tc.id) buf.id = tc.id
              if (tc.function?.name) buf.name = tc.function.name
              if (tc.function?.arguments) buf.args += tc.function.arguments
            }
          }
        } catch {
          // Skip invalid JSON
        }
      }
    }

    // Convert tool call buffers to ToolCall objects
    for (const buf of toolCallBuffers.values()) {
      if (buf.name) {
        try {
          const input = JSON.parse(buf.args || '{}')
          toolCalls.push({ id: buf.id, name: buf.name, input })
          callbacks?.onToolCall?.(buf.name, input)
        } catch {
          log.error(`Failed to parse tool call args: ${buf.args}`)
        }
      }
    }

    return { content, toolCalls, finishReason }
  }

  private async chatClaude(
    messages: LLMMessage[],
    tools: object[],
    callbacks?: StreamCallbacks,
    signal?: AbortSignal
  ): Promise<LLMResponse> {
    // Convert OpenAI format to Claude format
    const systemMessage = messages.find((m) => m.role === 'system')
    const nonSystemMessages = messages.filter((m) => m.role !== 'system')

    const claudeMessages = nonSystemMessages.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'user' as const,
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: m.tool_call_id,
              content: m.content,
            },
          ],
        }
      }
      if (m.tool_calls) {
        return {
          role: 'assistant' as const,
          content: m.tool_calls.map((tc) => ({
            type: 'tool_use' as const,
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments),
          })),
        }
      }
      return {
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }
    })

    const claudeTools = tools.map((t: any) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }))

    const url = `${this.baseUrl}/messages`

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 4096,
      messages: claudeMessages,
      stream: true,
    }

    if (systemMessage) {
      body.system = systemMessage.content
    }

    if (claudeTools.length > 0) {
      body.tools = claudeTools
    }

    log.debug(`Calling Claude API: ${this.model}`)

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Claude API error: ${response.status} ${error}`)
    }

    return this.parseClaudeStream(response, callbacks)
  }

  private async parseClaudeStream(
    response: Response,
    callbacks?: StreamCallbacks
  ): Promise<LLMResponse> {
    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    let content = ''
    const toolCalls: ToolCall[] = []
    let currentToolUse: { id: string; name: string; input: string } | null = null
    let finishReason = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      const lines = chunk.split('\n').filter((l) => l.startsWith('data: '))

      for (const line of lines) {
        const data = line.slice(6)
        try {
          const parsed = JSON.parse(data)

          if (parsed.type === 'content_block_start') {
            if (parsed.content_block?.type === 'tool_use') {
              currentToolUse = {
                id: parsed.content_block.id,
                name: parsed.content_block.name,
                input: '',
              }
            }
          }

          if (parsed.type === 'content_block_delta') {
            if (parsed.delta?.type === 'text_delta') {
              content += parsed.delta.text
              callbacks?.onChunk?.(parsed.delta.text)
            }
            if (parsed.delta?.type === 'input_json_delta' && currentToolUse) {
              currentToolUse.input += parsed.delta.partial_json
            }
          }

          if (parsed.type === 'content_block_stop' && currentToolUse) {
            try {
              const input = JSON.parse(currentToolUse.input || '{}')
              toolCalls.push({
                id: currentToolUse.id,
                name: currentToolUse.name,
                input,
              })
              callbacks?.onToolCall?.(currentToolUse.name, input)
            } catch {
              log.error(`Failed to parse tool input: ${currentToolUse.input}`)
            }
            currentToolUse = null
          }

          if (parsed.type === 'message_delta') {
            finishReason = parsed.delta?.stop_reason || ''
          }
        } catch {
          // Skip invalid JSON
        }
      }
    }

    return { content, toolCalls, finishReason }
  }
}
