// Gateway Server: Control plane that manages channels, agents, and cron
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { ChannelRegistry } from '../channels/registry.js'
import { WebSocketChannel } from '../channels/websocket.js'
import { createTelegramChannel } from '../channels/telegram.js'
import { CronChannel } from '../channels/cron.js'
import { FollowupQueue } from '../queue/followup-queue.js'
import { CronService } from '../cron/service.js'
import { setCronService } from '../cron/singleton.js'
import { AgentRunner } from '../agents/runner.js'
import { getAgentManager } from '../agents/manager.js'
import { getSessionManager } from '../sessions/index.js'
import { getProviderManager } from '../config/provider-manager.js'
import { getBindingManager } from '../routing/index.js'
import { SessionAPI } from './session-api.js'
import { initTools } from '../agents/tools/index.js'
import type { Message } from '../channels/types.js'
import { env } from '../infra/env.js'
import { createLogger } from '../infra/logger.js'
import { setGatewayRef } from './gateway-ref.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const log = createLogger('gateway')

export class Gateway {
  private channels: ChannelRegistry
  private queue: FollowupQueue
  private cron: CronService
  private agents: Map<string, AgentRunner> = new Map()
  private wsChannel: WebSocketChannel
  private sessionApi: SessionAPI

  constructor() {
    this.channels = new ChannelRegistry()
    this.queue = new FollowupQueue()
    this.cron = new CronService(resolve(__dirname, '../../data/cron.json'))
    this.sessionApi = new SessionAPI(env.GATEWAY_PORT) // HTTP + WebSocket 共享同一端口

    // Set cron service singleton for tool access
    setCronService(this.cron)

    // Initialize channels
    this.wsChannel = new WebSocketChannel(env.GATEWAY_PORT)
    this.channels.register(this.wsChannel)

    // Register Cron channel for isolated cron job execution
    this.channels.register(new CronChannel())

    // Register Telegram channel if token is configured
    if (env.TELEGRAM_BOT_TOKEN) {
      const telegramChannel = createTelegramChannel({
        token: env.TELEGRAM_BOT_TOKEN,
        allowFrom: env.TELEGRAM_ALLOW_FROM,
      })
      this.channels.register(telegramChannel)
    }

    // Set up message handling
    this.channels.onMessage((msg) => this.handleMessage(msg))

    // Set up steer mode callback
    this.queue.onSteer((sessionKey, queuedMsg) => {
      const agent = this.agents.get(sessionKey)
      if (agent?.isActive()) {
        agent.inject(queuedMsg.text)
      } else {
        // No active agent, process as new message
        this.processMessage({
          id: queuedMsg.id,
          channel: queuedMsg.channel as 'websocket' | 'telegram',
          from: sessionKey,
          text: queuedMsg.text,
          timestamp: queuedMsg.timestamp,
          sessionKey,
        })
      }
    })

    // Set up cron handler
    this.cron.onTrigger(async (job) => {
      log.info(`Cron job triggered: ${job.message}`)
      await this.runCronJob(job)
    })
  }

  private async handleMessage(msg: Message): Promise<void> {
    const agent = this.agents.get(msg.sessionKey)

    if (agent?.isActive()) {
      // Agent is running, use queue (steer mode will inject)
      this.queue.enqueue(msg)
    } else {
      // No active agent, process directly
      await this.processMessage(msg)
    }
  }

  private async processMessage(msg: Message): Promise<void> {
    log.info(`Processing message from ${msg.channel}: ${msg.text.slice(0, 50)}...`)

    const sm = getSessionManager()
    const am = getAgentManager()
    const pm = getProviderManager()
    const bm = getBindingManager()

    // 使用路由系统确定 agent
    const defaultAgentId = am.getDefaultAgent()?.agentId || 'default'
    const routeResult = bm.resolveRoute(
      {
        channel: msg.channel as any,
        // 可以从 msg 中提取更多路由信息
        // peer: msg.peer,
        // guildId: msg.guildId,
        // teamId: msg.teamId,
        // accountId: msg.accountId,
      },
      defaultAgentId
    )

    // 优先使用消息中指定的 agentId，否则使用路由结果
    const agentId = msg.agentId || routeResult.agentId
    const agentConfig = am.getAgent(agentId)

    log.info(`Routed to agent: ${agentId} (matched by: ${routeResult.matchedBy})`)

    // 使用 sessionId 或 sessionKey 来标识运行中的 agent
    const runnerKey = msg.sessionId || msg.sessionKey

    // Get or create agent runner for this session
    let agent = this.agents.get(runnerKey)

    // If agent is cached but its session was deleted (e.g. via web UI), discard it
    if (agent) {
      const cachedSessionId = agent.getSessionId()
      if (cachedSessionId && !sm.getSession(cachedSessionId)) {
        log.info(`Session ${cachedSessionId} was deleted, discarding cached agent for ${runnerKey}`)
        this.agents.delete(runnerKey)
        agent = undefined
      }
    }

    if (!agent) {
      // 根据 agent 的 model 查找对应的 provider
      let llmConfig = undefined
      if (agentConfig?.model) {
        const provider = pm.getProviderByModel(agentConfig.model)
        if (provider) {
          llmConfig = {
            apiKey: provider.apiKey,
            baseUrl: provider.baseUrl,
            model: agentConfig.model,
            format: provider.format,
          }
          log.info(`Using provider ${provider.name} for model ${agentConfig.model}`)
        }
      }

      agent = new AgentRunner({ agentConfig: agentConfig || undefined, llmConfig })
      await agent.loadSkills()

      // 绑定或创建会话
      if (msg.sessionId) {
        // 恢复已有会话
        const existingSession = sm.getSession(msg.sessionId)
        if (existingSession) {
          agent.bindSession(existingSession.sessionId)
          log.info(`Resumed session: ${msg.sessionId}`)
        }
      } else {
        // 创建新会话，传入 channel 信息
        const session = sm.getOrCreate(msg.sessionKey, agentId, msg.channel)
        agent.bindSession(session.sessionId)
      }

      this.agents.set(runnerKey, agent)
    }

    // Set tool context so tools know the current session/channel
    // Extract "to" from sessionKey (e.g. "telegram:7488297577" → "7488297577")
    const to = msg.from !== 'cron' ? msg.sessionKey.split(':').slice(1).join(':') : undefined
    agent.setToolContext({
      sessionKey: msg.sessionKey,
      channel: msg.channel,
      to,
      agentId,
    })

    // 发送 typing 状态（如果 channel 支持）
    const channel = this.channels.get(msg.channel)
    if (channel?.sendTyping) {
      await channel.sendTyping(msg.sessionKey)
    }

    // 收集 tool 调用信息
    const toolCalls: Array<{ name: string; input?: Record<string, unknown> }> = []
    const isCron = msg.from === 'cron'
    const isSubagentAnnounce = msg.from === 'subagent-announce'

    try {
      await agent.run(msg.text, {
        source: isCron ? 'cron' : isSubagentAnnounce ? 'subagent-announce' : 'user',
        callbacks: {
          onChunk: (text) => {
            if (msg.channel === 'websocket') {
              (this.wsChannel as any).sendChunk(msg.sessionKey, text)
            }
          },
          onToolCall: (name, input) => {
            log.info(`Tool call: ${name}`)
            toolCalls.push({ name, input })
            if (msg.channel === 'websocket') {
              (this.wsChannel as any).sendToolCall(msg.sessionKey, name, input)
            }
          },
          onToolResult: (name, output) => {
            log.info(`Tool result: ${name} (${output.length} bytes)`)
            if (msg.channel === 'websocket') {
              (this.wsChannel as any).sendToolResult(msg.sessionKey, name, output)
            }
          },
          onComplete: (text) => {
            // Suppress NO_REPLY responses (used by subagent announce when no user-facing output needed)
            if (text.trim() === 'NO_REPLY' || text.trim() === '(done)') return
            this.channels.send(msg.channel, msg.sessionKey, { text, toolCalls })
          },
        },
      })
    } catch (err) {
      log.error('Agent error:', err)
      await this.channels.send(msg.channel, msg.sessionKey, {
        text: `Error: ${(err as Error).message}`,
      })
    }
  }

  /** Send a message to a session via its channel (used by subagents to announce results) */
  async sendToSession(sessionKey: string, channel: string, text: string): Promise<void> {
    log.info(`sendToSession: channel=${channel}, sessionKey=${sessionKey}, text=${text.slice(0, 80)}...`)

    // Persist the message to the session transcript so it survives page refresh
    const sm = getSessionManager()
    const session = sm.findBySessionKey(sessionKey)
    if (session) {
      sm.appendMessage(session.sessionId, {
        role: 'assistant',
        content: text,
        timestamp: Date.now(),
      })
    }

    await this.channels.send(channel, sessionKey, { text })
  }

  /** Trigger the main agent with a message (e.g., subagent results).
   *  If agent is active → inject (steer). If idle → invoke fresh via processMessage. */
  async triggerAgent(sessionKey: string, channel: string, message: string): Promise<'steered' | 'invoked' | 'failed'> {
    log.info(`triggerAgent: sessionKey=${sessionKey}, channel=${channel}, msg=${message.slice(0, 80)}...`)

    const agent = this.agents.get(sessionKey)

    if (agent?.isActive()) {
      // Agent is running - steer the message in
      agent.inject(message)
      log.info(`triggerAgent: steered into active agent for ${sessionKey}`)
      return 'steered'
    }

    // Agent is idle - invoke fresh via processMessage
    try {
      const to = sessionKey.split(':').slice(1).join(':')
      await this.processMessage({
        id: `trigger-${Date.now()}`,
        channel: channel as 'websocket' | 'telegram',
        from: 'subagent-announce',
        text: message,
        timestamp: Date.now(),
        sessionKey,
      })
      log.info(`triggerAgent: invoked fresh agent for ${sessionKey}`)
      return 'invoked'
    } catch (err) {
      log.error(`triggerAgent: failed for ${sessionKey}:`, err)
      return 'failed'
    }
  }

  /** Run a cron job with a fresh, dedicated agent */
  private async runCronJob(job: import('../cron/types.js').CronJob): Promise<void> {
    const am = getAgentManager()
    const pm = getProviderManager()
    const sm = getSessionManager()

    const agentId = job.agentId || am.getDefaultAgent()?.agentId || 'default'
    const agentConfig = am.getAgent(agentId)

    let llmConfig = undefined
    if (agentConfig?.model) {
      const provider = pm.getProviderByModel(agentConfig.model)
      if (provider) {
        llmConfig = {
          apiKey: provider.apiKey,
          baseUrl: provider.baseUrl,
          model: agentConfig.model,
          format: provider.format,
        }
      }
    }

    // Build delivery instruction based on job config
    const deliveryChannel = job.channel || 'telegram'
    let deliveryInstruction: string
    if (deliveryChannel === 'telegram') {
      deliveryInstruction = 'Use the telegram_send tool to deliver results to the user.'
    } else {
      deliveryInstruction = 'Use the session_send tool to deliver results to the user\'s web session.'
    }

    const cronSystemPrompt = `You are a cron task executor. Your ONLY job is to execute the scheduled task and deliver the result.

RULES:
1. Execute the task using the appropriate tools (web_search, web_fetch, bash, etc.).
2. After getting results, you MUST deliver them. ${deliveryInstruction}
3. Be concise. Summarize findings in a clear, readable format.
4. Do NOT ask questions. Do NOT wait for user input. Just execute and deliver.
5. NEVER end your turn without having called a send tool to deliver results.`

    const runner = new AgentRunner({
      agentConfig: agentConfig || undefined,
      llmConfig,
      extraSystemPrompt: cronSystemPrompt,
    })
    await runner.loadSkills()

    // Create session for cron job so it appears in web UI
    const sessionKey = `cron:${job.id}`
    const sessionTitle = job.name || `Cron: ${job.message.slice(0, 40)}${job.message.length > 40 ? '...' : ''}`
    const session = sm.createSession(sessionKey, agentId, sessionTitle, 'cron')
    runner.bindSession(session.sessionId)
    log.info(`Created cron session: ${session.sessionId} for job ${job.id}`)

    runner.setToolContext({
      sessionKey,
      channel: deliveryChannel,
      to: job.to,
      agentId,
    })

    try {
      await runner.run(job.message, {
        source: 'cron',
        callbacks: {
          onToolCall: (name) => log.info(`[cron:${job.id}] Tool call: ${name}`),
          onToolResult: (name, output) => log.info(`[cron:${job.id}] Tool result: ${name} (${output.length} bytes)`),
        },
      })
      log.info(`[cron:${job.id}] Completed`)
    } catch (err) {
      log.error(`[cron:${job.id}] Failed:`, err)
    }
  }

  async start(): Promise<void> {
    log.info('Starting Gateway...')

    // Set gateway ref so tools can send messages back
    setGatewayRef({
      sendToSession: (sessionKey, channel, text) => this.sendToSession(sessionKey, channel, text),
      triggerAgent: (sessionKey, channel, message) => this.triggerAgent(sessionKey, channel, message),
    })

    // 初始化工具（包括 Composio 工具）
    await initTools()

    // 先启动 HTTP 服务器
    const httpServer = await this.sessionApi.start()

    // 让 WebSocket 共享 HTTP 服务器
    this.wsChannel.setHttpServer(httpServer)

    // 启动所有 channels
    await this.channels.startAll()
    await this.cron.start()

    log.info(`Gateway started on port ${env.GATEWAY_PORT}`)
  }

  async stop(): Promise<void> {
    log.info('Stopping Gateway...')
    await this.cron.stop()
    await this.sessionApi.stop()
    await this.channels.stopAll()
    log.info('Gateway stopped')
  }

  getCronService(): CronService {
    return this.cron
  }

  getQueue(): FollowupQueue {
    return this.queue
  }
}
