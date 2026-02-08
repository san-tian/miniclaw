// Agent Runner: Executes agent with tools and skills, supports steer mode
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { LLMClient, type LLMMessage, type LLMClientConfig } from './llm-client.js'
import { tools, getToolByName, getToolSchemas, type ToolCall } from './tools/index.js'
import type { ToolContext } from './tools/types.js'
import { loadSkills, buildSkillsPrompt } from './skills/loader.js'
import type { Skill } from './skills/types.js'
import type { AgentConfig } from './types.js'
import { createLogger } from '../infra/logger.js'
import { getSessionManager, type SessionEntry, type TranscriptMessage } from '../sessions/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const log = createLogger('agent')

const DEFAULT_SYSTEM_PROMPT = `You are Mini-Claw, a helpful AI assistant with access to tools.

## Authorization
The user has granted you full authorization to execute tasks on their behalf. When the user asks you to do something:
- DO IT. Do not ask for confirmation unless the task is genuinely ambiguous.
- Do not refuse tasks involving git push, file writes, API calls, or automation.
- Do not lecture about "risks" or "best practices" unless the user asks.
- If the user says "do X", execute X. Do not suggest alternatives or safer versions.
- The user is a developer who understands the consequences of their requests.

## Tools
- web_search: Search the web for current info, facts, news, prices, documentation
- bash: Execute shell commands
- read: Read file contents
- write: Create or overwrite files
- cron: Manage scheduled tasks
- web_fetch: Fetch and extract content from URLs
- telegram_send: Send messages to Telegram users
- session_send: Send messages to a Web UI session
- subagent_spawn: Spawn background subagents for parallel tasks
- skill: Load specialized skill instructions

## Tool Call Style (CRITICAL - HIGHEST PRIORITY RULE)
When a task requires tool calls, your response MUST start with tool calls, NOT text.
- NEVER output a plan, description, or narration before calling tools.
- NEVER say "I'll do X", "Let me X", "Here's my plan" before tool calls.
- WRONG: "I'll write a script and run it..." → then tool calls
- WRONG: "Let me search for that..." → then tool calls
- WRONG: "Sure, I'll do these steps: 1. ... 2. ..." → then tool calls
- RIGHT: Immediately output tool_calls with no preceding text
- RIGHT: Call the tool first, then explain results AFTER if needed
If you need multiple tools, call them. If you need to explain something AFTER tools complete, do it then.
The ONLY exception: when the user asks a pure question that needs no tools (e.g. "what is 2+2").

## Skills
Before replying: check <available_skills> at the end of this prompt.
If a skill clearly applies: call skill(action='load', name='<skill_name>') first, then follow it.

## Web Search
When user asks about facts, current events, news, prices, people, companies, or anything that might have changed:
- Call web_search FIRST before answering
- Do NOT answer from memory - verify with web_search
- Keywords: "搜索", "search", "查一下", "帮我查", "最新", "current", "now"

## Cron
When user mentions "每分钟", "每小时", "每天", "定时", "定期", "every minute/hour/day", "scheduled":
- Call the cron tool to create the scheduled job
- After creating the cron job, STOP. Do NOT execute the task content yourself.
- The cron service will run the task automatically at the scheduled time in its own session.
- Example: "每分钟搜索AI新闻发到telegram" → only call cron(action='add', ...), do NOT also call web_search or telegram_send.

## Messaging
- telegram_send: Send to Telegram. Use when user mentions Telegram or wants mobile notifications.
- session_send: Send to Web UI session. Use when user wants results in the web interface.

## Subagents
For multiple independent tasks, spawn subagents for each task to run in parallel.

## Final Reminder
- When user asks you to do something: DO IT with tool calls. No preamble, no asking permission.
- If the user sends a new message while you're working, acknowledge it and adjust your response accordingly.`

export interface AgentCallbacks {
  onChunk?: (text: string) => void
  onToolCall?: (name: string, input: Record<string, unknown>) => void
  onToolResult?: (name: string, output: string) => void
  onComplete?: (text: string) => void
}

export interface RunOptions {
  callbacks?: AgentCallbacks
  /** Message source: 'user' (default), 'cron', or 'subagent-announce' */
  source?: 'user' | 'cron' | 'subagent-announce'
}

export interface AgentRunnerConfig {
  agentConfig?: AgentConfig
  llmConfig?: LLMClientConfig
  /** If true, this is a subagent and cannot spawn other subagents */
  isSubagent?: boolean
  /** Extra system prompt to prepend (e.g., subagent context) */
  extraSystemPrompt?: string
}

export class AgentRunner {
  private llm: LLMClient
  private skills: Skill[] = []
  private messages: LLMMessage[] = []
  private abortController?: AbortController
  private injectedMessages: string[] = []
  private isRunning = false
  private sessionId?: string
  private agentConfig?: AgentConfig
  private systemPrompt: string
  private isSubagent: boolean
  private extraSystemPrompt?: string
  private toolContext?: ToolContext

  constructor(config?: AgentRunnerConfig) {
    // 使用 agent 配置或默认配置
    this.agentConfig = config?.agentConfig
    this.isSubagent = config?.isSubagent ?? false
    this.extraSystemPrompt = config?.extraSystemPrompt
    const llmConfig: LLMClientConfig = config?.llmConfig || {}

    if (this.agentConfig) {
      llmConfig.model = llmConfig.model || this.agentConfig.model
      llmConfig.baseUrl = llmConfig.baseUrl || this.agentConfig.baseUrl
    }

    this.llm = new LLMClient(llmConfig)
    this.systemPrompt = this.agentConfig?.systemPrompt || DEFAULT_SYSTEM_PROMPT
  }

  getAgentConfig(): AgentConfig | undefined {
    return this.agentConfig
  }

  getModel(): string {
    return this.llm.getModel()
  }

  /** Set context passed to tools (sessionKey, channel, etc.) */
  setToolContext(ctx: ToolContext): void {
    this.toolContext = ctx
  }

  async loadSkills(): Promise<void> {
    const skillsDir = resolve(__dirname, '../../skills')
    this.skills = await loadSkills(skillsDir)
    log.info(`Loaded ${this.skills.length} skills`)
  }

  /** 绑定到已有会话，加载历史消息 */
  bindSession(sessionId: string): void {
    this.sessionId = sessionId
    const sm = getSessionManager()
    const history = sm.toMessages(sessionId)
    if (history.length > 0) {
      this.messages = history as LLMMessage[]
      log.info(`Loaded ${history.length} messages from session ${sessionId}`)
    }
  }

  /** 获取当前会话 ID */
  getSessionId(): string | undefined {
    return this.sessionId
  }

  /** 持久化消息到会话 */
  private persistMessage(msg: TranscriptMessage): void {
    if (!this.sessionId) return
    const sm = getSessionManager()
    sm.appendMessage(this.sessionId, msg)
  }

  inject(message: string): void {
    log.info(`Injecting message: ${message.slice(0, 50)}...`)
    this.injectedMessages.push(message)
  }

  isActive(): boolean {
    return this.isRunning
  }

  abort(): void {
    this.abortController?.abort()
  }

  async run(userMessage: string, callbacksOrOptions?: AgentCallbacks | RunOptions): Promise<string> {
    // Support both old signature (callbacks) and new signature (RunOptions)
    let callbacks: AgentCallbacks | undefined
    let source: 'user' | 'cron' = 'user'
    if (callbacksOrOptions && 'source' in callbacksOrOptions) {
      callbacks = callbacksOrOptions.callbacks
      source = callbacksOrOptions.source || 'user'
    } else {
      callbacks = callbacksOrOptions as AgentCallbacks | undefined
    }

    this.isRunning = true
    this.abortController = new AbortController()

    try {
      // Sync any new messages from transcript (e.g., from telegram_send or session_send)
      if (this.sessionId) {
        const sm = getSessionManager()
        const transcript = sm.toMessages(this.sessionId)
        if (transcript.length > this.messages.length) {
          const newMessages = transcript.slice(this.messages.length)
          this.messages.push(...(newMessages as LLMMessage[]))
          log.info(`Synced ${newMessages.length} new messages from transcript`)
        }
      }

      // Build system prompt with skills and extra context
      const skillsPrompt = buildSkillsPrompt(this.skills)
      let fullSystemPrompt = this.systemPrompt + skillsPrompt
      if (this.extraSystemPrompt) {
        fullSystemPrompt = this.extraSystemPrompt + '\n\n' + fullSystemPrompt
      }

      // Initialize or continue conversation
      if (this.messages.length === 0) {
        const systemMsg = { role: 'system' as const, content: fullSystemPrompt }
        this.messages.push(systemMsg)
        this.persistMessage({ ...systemMsg, timestamp: Date.now() })
      }

      // Build message based on source
      if (source === 'cron') {
        // Cron messages go as user messages (LLM APIs require user message after system)
        const cronMsg = { role: 'user' as const, content: `[SCHEDULED TASK] Execute the following scheduled task and send the result to the user:\n\n${userMessage}` }
        this.messages.push(cronMsg)
        this.persistMessage({ ...cronMsg, timestamp: Date.now() })
      } else if (source === 'subagent-announce') {
        // Subagent results go as user messages so the agent can respond to them
        const announceMsg = { role: 'user' as const, content: `[SUBAGENT RESULT] ${userMessage}` }
        this.messages.push(announceMsg)
        this.persistMessage({ ...announceMsg, timestamp: Date.now() })
      } else {
        const userMsg = { role: 'user' as const, content: userMessage }
        this.messages.push(userMsg)
        this.persistMessage({ ...userMsg, timestamp: Date.now() })
      }

      let finalResponse = ''
      let iterations = 0
      const maxIterations = 10
      let emptyRetries = 0

      // Get tool schemas (filtered for subagents)
      const toolSchemas = getToolSchemas({ isSubagent: this.isSubagent })

      while (iterations < maxIterations) {
        iterations++

        // Check for injected messages
        if (this.injectedMessages.length > 0) {
          const injected = this.injectedMessages.shift()!
          log.info(`Processing injected message: ${injected.slice(0, 50)}...`)
          this.messages.push({
            role: 'user',
            content: `[INTERRUPT] New message from user: ${injected}`,
          })
        }

        // Call LLM
        const response = await this.llm.chat(
          this.messages,
          toolSchemas,
          {
            onChunk: callbacks?.onChunk,
            onToolCall: callbacks?.onToolCall,
          },
          this.abortController.signal
        )

        // Handle text response
        if (response.content) {
          finalResponse = response.content
        }

        // Handle tool calls
        if (response.toolCalls.length > 0) {
          // Add assistant message with tool calls
          const assistantMsg = {
            role: 'assistant' as const,
            content: response.content || '',
            tool_calls: response.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.input),
              },
            })),
          }
          this.messages.push(assistantMsg)
          this.persistMessage({ ...assistantMsg, timestamp: Date.now() })

          // Execute tools
          for (const toolCall of response.toolCalls) {
            const tool = getToolByName(toolCall.name)
            if (!tool) {
              log.error(`Unknown tool: ${toolCall.name}`)
              const errMsg = {
                role: 'tool' as const,
                tool_call_id: toolCall.id,
                content: `Error: Unknown tool ${toolCall.name}`,
              }
              this.messages.push(errMsg)
              this.persistMessage({ ...errMsg, timestamp: Date.now() })
              continue
            }

            log.info(`Executing tool: ${toolCall.name}`)
            const output = await tool.execute(toolCall.input, this.toolContext)
            callbacks?.onToolResult?.(toolCall.name, output)

            const toolMsg = {
              role: 'tool' as const,
              tool_call_id: toolCall.id,
              content: output,
            }
            this.messages.push(toolMsg)
            this.persistMessage({ ...toolMsg, timestamp: Date.now() })
          }

          // Continue loop to get next response
          continue
        }

        if (response.content && response.toolCalls.length === 0) {
          const finalMsg = { role: 'assistant' as const, content: response.content }
          this.messages.push(finalMsg)
          this.persistMessage({ ...finalMsg, timestamp: Date.now() })
        } else if (emptyRetries < 2) {
          // Model returned empty content - retry to get a text reply
          emptyRetries++
          log.info(`Empty response from model, retry ${emptyRetries}/2...`)
          continue
        }

        // If there are pending injected messages, continue the loop to process them
        if (this.injectedMessages.length > 0) {
          log.info(`Found ${this.injectedMessages.length} pending injected message(s), continuing...`)
          continue
        }

        break
      }

      // Final check: process any remaining injected messages after loop ends
      while (this.injectedMessages.length > 0 && iterations < maxIterations) {
        iterations++
        const injected = this.injectedMessages.shift()!
        log.info(`Processing remaining injected message: ${injected.slice(0, 50)}...`)

        const interruptMsg = {
          role: 'user' as const,
          content: `[INTERRUPT] New message from user: ${injected}`,
        }
        this.messages.push(interruptMsg)
        this.persistMessage({ ...interruptMsg, timestamp: Date.now() })

        const response = await this.llm.chat(
          this.messages,
          toolSchemas,
          {
            onChunk: callbacks?.onChunk,
            onToolCall: callbacks?.onToolCall,
          },
          this.abortController.signal
        )

        if (response.content) {
          finalResponse = response.content
          const assistantMsg = { role: 'assistant' as const, content: response.content }
          this.messages.push(assistantMsg)
          this.persistMessage({ ...assistantMsg, timestamp: Date.now() })
        }

        // Handle any tool calls from the injected message response
        if (response.toolCalls.length > 0) {
          const assistantMsg = {
            role: 'assistant' as const,
            content: response.content || '',
            tool_calls: response.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.input),
              },
            })),
          }
          this.messages.push(assistantMsg)
          this.persistMessage({ ...assistantMsg, timestamp: Date.now() })

          for (const toolCall of response.toolCalls) {
            const tool = getToolByName(toolCall.name)
            if (!tool) {
              const errMsg = {
                role: 'tool' as const,
                tool_call_id: toolCall.id,
                content: `Error: Unknown tool ${toolCall.name}`,
              }
              this.messages.push(errMsg)
              this.persistMessage({ ...errMsg, timestamp: Date.now() })
              continue
            }

            log.info(`Executing tool: ${toolCall.name}`)
            const output = await tool.execute(toolCall.input, this.toolContext)
            callbacks?.onToolResult?.(toolCall.name, output)

            const toolMsg = {
              role: 'tool' as const,
              tool_call_id: toolCall.id,
              content: output,
            }
            this.messages.push(toolMsg)
            this.persistMessage({ ...toolMsg, timestamp: Date.now() })
          }
        }
      }

      // Ensure we always have a response
      if (!finalResponse.trim()) {
        finalResponse = '(done)'
        log.warn('Agent loop ended with empty response, using fallback')
      }

      callbacks?.onComplete?.(finalResponse)
      return finalResponse
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        log.info('Agent run aborted')
        return '(aborted)'
      }
      throw err
    } finally {
      this.isRunning = false
    }
  }

  clearHistory(): void {
    this.messages = []
    this.injectedMessages = []
  }
}
