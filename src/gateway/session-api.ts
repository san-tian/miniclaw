// HTTP API for session and agent management
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http'
import { readFileSync, existsSync } from 'fs'
import { join, extname } from 'path'
import { getSessionManager } from '../sessions/index.js'
import { getAgentManager } from '../agents/manager.js'
import { getProviderManager } from '../config/index.js'
import { getBindingManager } from '../routing/index.js'
import { getCronService } from '../cron/singleton.js'
import { createLogger } from '../infra/logger.js'

const log = createLogger('http-api')

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

export class SessionAPI {
  private server?: Server
  private port: number

  constructor(port: number) {
    this.port = port
  }

  /** 获取 HTTP Server 实例，供 WebSocket 共享 */
  getServer(): Server | undefined {
    return this.server
  }

  async start(): Promise<Server> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => this.handleRequest(req, res))
      this.server.listen(this.port, '0.0.0.0', () => {
        log.info(`HTTP server listening on port ${this.port}`)
        resolve(this.server!)
      })
    })
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server?.close(() => resolve())
    })
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url || '/', `http://localhost:${this.port}`)
    const path = url.pathname

    try {
      // ========== Provider API ==========

      // GET /api/providers - 列出所有 provider
      if (req.method === 'GET' && path === '/api/providers') {
        const pm = getProviderManager()
        const providers = pm.listProviders().map(p => ({
          ...p,
          apiKey: p.apiKey ? '***' + p.apiKey.slice(-4) : '' // 隐藏 API key
        }))
        const defaultProviderId = pm.getDefaultProvider()?.id
        this.json(res, { providers, defaultProviderId })
        return
      }

      // GET /api/providers/:id - 获取 provider 详情
      const providerMatch = path.match(/^\/api\/providers\/([^/]+)$/)
      if (req.method === 'GET' && providerMatch) {
        const id = providerMatch[1]
        const pm = getProviderManager()
        const provider = pm.getProvider(id)
        if (!provider) {
          this.json(res, { error: 'Provider not found' }, 404)
          return
        }
        this.json(res, { provider: { ...provider, apiKey: '***' + provider.apiKey.slice(-4) } })
        return
      }

      // POST /api/providers - 创建新 provider
      if (req.method === 'POST' && path === '/api/providers') {
        const body = await this.parseBody(req)
        if (!body.name || !body.baseUrl || !body.apiKey) {
          this.json(res, { error: 'name, baseUrl and apiKey are required' }, 400)
          return
        }
        const pm = getProviderManager()
        const provider = pm.createProvider({
          name: body.name,
          baseUrl: body.baseUrl,
          apiKey: body.apiKey,
          format: body.format || 'openai',
          models: body.models || [],
        })
        this.json(res, { provider: { ...provider, apiKey: '***' + provider.apiKey.slice(-4) } }, 201)
        return
      }

      // PUT /api/providers/:id - 更新 provider
      if (req.method === 'PUT' && providerMatch) {
        const id = providerMatch[1]
        const body = await this.parseBody(req)
        const pm = getProviderManager()
        const provider = pm.updateProvider(id, body)
        if (!provider) {
          this.json(res, { error: 'Provider not found' }, 404)
          return
        }
        this.json(res, { provider: { ...provider, apiKey: '***' + provider.apiKey.slice(-4) } })
        return
      }

      // DELETE /api/providers/:id - 删除 provider
      if (req.method === 'DELETE' && providerMatch) {
        const id = providerMatch[1]
        const pm = getProviderManager()
        const deleted = pm.deleteProvider(id)
        if (!deleted) {
          this.json(res, { error: 'Provider not found or cannot delete default' }, 404)
          return
        }
        this.json(res, { success: true })
        return
      }

      // POST /api/providers/:id/set-default - 设置默认 provider
      const setDefaultProviderMatch = path.match(/^\/api\/providers\/([^/]+)\/set-default$/)
      if (req.method === 'POST' && setDefaultProviderMatch) {
        const id = setDefaultProviderMatch[1]
        const pm = getProviderManager()
        const success = pm.setDefaultProvider(id)
        if (!success) {
          this.json(res, { error: 'Provider not found' }, 404)
          return
        }
        this.json(res, { success: true })
        return
      }

      // GET /api/models - 获取所有可用模型
      if (req.method === 'GET' && path === '/api/models') {
        const pm = getProviderManager()
        const models = pm.getAllModels()
        this.json(res, { models })
        return
      }

      // ========== Agent API ==========

      // GET /api/agents/defaults/system-prompt - 获取默认 system prompt
      if (req.method === 'GET' && path === '/api/agents/defaults/system-prompt') {
        const defaultPrompt = `You are Mini-Claw, a helpful AI assistant with access to tools.

You can:
- Execute shell commands using the 'bash' tool
- Read files using the 'read' tool
- Write files using the 'write' tool
- Manage scheduled tasks using the 'cron' tool
- Fetch web pages using the 'web_fetch' tool

When asked to perform tasks, use the appropriate tools. Be concise and helpful.

For scheduling tasks, use the 'cron' tool. You can convert natural language time expressions to cron expressions:
- "every minute" → "* * * * *"
- "every 5 minutes" → "*/5 * * * *"
- "every hour" → "0 * * * *"
- "every day at 9am" → "0 9 * * *"
- "every Monday at 9am" → "0 9 * * 1"
- "every month on the 1st" → "0 0 1 * *"

For web content, use 'web_fetch' to read the content of specific URLs.

If the user sends a new message while you're working, acknowledge it and adjust your response accordingly.`
        this.json(res, { defaultPrompt })
        return
      }

      // GET /api/agents - 列出所有 agent
      if (req.method === 'GET' && path === '/api/agents') {
        const am = getAgentManager()
        const agents = am.listAgents()
        const defaultAgentId = am.getDefaultAgent()?.agentId
        this.json(res, { agents, defaultAgentId })
        return
      }

      // GET /api/agents/:id - 获取 agent 详情
      const agentMatch = path.match(/^\/api\/agents\/([^/]+)$/)
      if (req.method === 'GET' && agentMatch) {
        const agentId = agentMatch[1]
        const am = getAgentManager()
        const agent = am.getAgent(agentId)
        if (!agent) {
          this.json(res, { error: 'Agent not found' }, 404)
          return
        }
        this.json(res, { agent })
        return
      }

      // POST /api/agents - 创建新 agent
      if (req.method === 'POST' && path === '/api/agents') {
        const body = await this.parseBody(req)
        if (!body.name || !body.model) {
          this.json(res, { error: 'name and model are required' }, 400)
          return
        }
        const am = getAgentManager()
        const agent = am.createAgent({
          name: body.name,
          model: body.model,
          description: body.description,
          baseUrl: body.baseUrl,
          systemPrompt: body.systemPrompt,
        })
        this.json(res, { agent }, 201)
        return
      }

      // PUT /api/agents/:id - 更新 agent
      if (req.method === 'PUT' && agentMatch) {
        const agentId = agentMatch[1]
        const body = await this.parseBody(req)
        const am = getAgentManager()
        const agent = am.updateAgent(agentId, body)
        if (!agent) {
          this.json(res, { error: 'Agent not found' }, 404)
          return
        }
        this.json(res, { agent })
        return
      }

      // DELETE /api/agents/:id - 删除 agent
      if (req.method === 'DELETE' && agentMatch) {
        const agentId = agentMatch[1]
        const am = getAgentManager()
        const deleted = am.deleteAgent(agentId)
        if (!deleted) {
          this.json(res, { error: 'Agent not found or cannot delete default' }, 404)
          return
        }
        this.json(res, { success: true })
        return
      }

      // POST /api/agents/:id/set-default - 设置默认 agent
      const setDefaultMatch = path.match(/^\/api\/agents\/([^/]+)\/set-default$/)
      if (req.method === 'POST' && setDefaultMatch) {
        const agentId = setDefaultMatch[1]
        const am = getAgentManager()
        const success = am.setDefaultAgent(agentId)
        if (!success) {
          this.json(res, { error: 'Agent not found' }, 404)
          return
        }
        this.json(res, { success: true })
        return
      }

      // ========== Session API ==========

      // GET /api/sessions - 列出所有会话
      if (req.method === 'GET' && path === '/api/sessions') {
        const sm = getSessionManager()
        const agentId = url.searchParams.get('agentId') || undefined
        const channel = url.searchParams.get('channel') || undefined
        const sessions = sm.listSessions(agentId, channel)
        this.json(res, { sessions })
        return
      }

      // GET /api/sessions/:id - 获取会话详情
      const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/)
      if (req.method === 'GET' && sessionMatch) {
        const sessionId = sessionMatch[1]
        const sm = getSessionManager()
        const session = sm.getSession(sessionId)
        if (!session) {
          this.json(res, { error: 'Session not found' }, 404)
          return
        }
        this.json(res, { session })
        return
      }

      // GET /api/sessions/:id/messages - 获取会话消息
      const messagesMatch = path.match(/^\/api\/sessions\/([^/]+)\/messages$/)
      if (req.method === 'GET' && messagesMatch) {
        const sessionId = messagesMatch[1]
        const sm = getSessionManager()
        const session = sm.getSession(sessionId)
        if (!session) {
          this.json(res, { error: 'Session not found' }, 404)
          return
        }
        const messages = sm.loadTranscript(sessionId)
        this.json(res, { session, messages })
        return
      }

      // POST /api/sessions - 创建新会话
      if (req.method === 'POST' && path === '/api/sessions') {
        const body = await this.parseBody(req)
        const sm = getSessionManager()
        const am = getAgentManager()
        const agentId = body.agentId || am.getDefaultAgent()?.agentId || 'default'
        const session = sm.createSession(
          body.sessionKey || `web:${Date.now()}`,
          agentId,
          body.title
        )
        this.json(res, { session }, 201)
        return
      }

      // DELETE /api/sessions/:id - 删除会话
      if (req.method === 'DELETE' && sessionMatch) {
        const sessionId = sessionMatch[1]
        const sm = getSessionManager()
        const deleted = sm.deleteSession(sessionId)
        if (!deleted) {
          this.json(res, { error: 'Session not found' }, 404)
          return
        }
        this.json(res, { success: true })
        return
      }

      // ========== Binding (Routing) API ==========

      // GET /api/bindings - 列出所有绑定
      if (req.method === 'GET' && path === '/api/bindings') {
        const bm = getBindingManager()
        const bindings = bm.listBindings()
        this.json(res, { bindings })
        return
      }

      // GET /api/bindings/:id - 获取绑定详情
      const bindingMatch = path.match(/^\/api\/bindings\/([^/]+)$/)
      if (req.method === 'GET' && bindingMatch) {
        const id = bindingMatch[1]
        const bm = getBindingManager()
        const binding = bm.getBinding(id)
        if (!binding) {
          this.json(res, { error: 'Binding not found' }, 404)
          return
        }
        this.json(res, { binding })
        return
      }

      // POST /api/bindings - 创建新绑定
      if (req.method === 'POST' && path === '/api/bindings') {
        const body = await this.parseBody(req)
        if (!body.agentId || !body.match?.channel) {
          this.json(res, { error: 'agentId and match.channel are required' }, 400)
          return
        }
        const bm = getBindingManager()
        const binding = bm.createBinding({
          agentId: body.agentId,
          match: body.match,
          priority: body.priority,
        })
        this.json(res, { binding }, 201)
        return
      }

      // PUT /api/bindings/:id - 更新绑定
      if (req.method === 'PUT' && bindingMatch) {
        const id = bindingMatch[1]
        const body = await this.parseBody(req)
        const bm = getBindingManager()
        const binding = bm.updateBinding(id, body)
        if (!binding) {
          this.json(res, { error: 'Binding not found' }, 404)
          return
        }
        this.json(res, { binding })
        return
      }

      // DELETE /api/bindings/:id - 删除绑定
      if (req.method === 'DELETE' && bindingMatch) {
        const id = bindingMatch[1]
        const bm = getBindingManager()
        const deleted = bm.deleteBinding(id)
        if (!deleted) {
          this.json(res, { error: 'Binding not found' }, 404)
          return
        }
        this.json(res, { success: true })
        return
      }

      // POST /api/bindings/resolve - 测试路由解析
      if (req.method === 'POST' && path === '/api/bindings/resolve') {
        const body = await this.parseBody(req)
        if (!body.channel) {
          this.json(res, { error: 'channel is required' }, 400)
          return
        }
        const bm = getBindingManager()
        const am = getAgentManager()
        const defaultAgentId = am.getDefaultAgent()?.agentId || 'default'
        const result = bm.resolveRoute(body, defaultAgentId)
        this.json(res, { result })
        return
      }

      // ========== Cron API ==========

      // GET /api/cron - 列出所有 cron jobs
      if (req.method === 'GET' && path === '/api/cron') {
        const cron = getCronService()
        if (!cron) {
          this.json(res, { error: 'Cron service not available' }, 503)
          return
        }
        const jobs = cron.list()
        this.json(res, { jobs })
        return
      }

      // POST /api/cron - 创建新 cron job
      if (req.method === 'POST' && path === '/api/cron') {
        const body = await this.parseBody(req)
        if (!body.schedule || !body.message) {
          this.json(res, { error: 'schedule and message are required' }, 400)
          return
        }
        const cron = getCronService()
        if (!cron) {
          this.json(res, { error: 'Cron service not available' }, 503)
          return
        }
        try {
          const job = await cron.add(body.schedule, body.message, {
            channel: body.channel,
            to: body.to,
            name: body.name,
            description: body.description,
            agentId: body.agentId,
          })
          this.json(res, { job }, 201)
        } catch (err) {
          this.json(res, { error: `Invalid cron expression: ${(err as Error).message}` }, 400)
        }
        return
      }

      // Cron job by ID routes
      const cronMatch = path.match(/^\/api\/cron\/([^/]+)$/)
      const cronActionMatch = path.match(/^\/api\/cron\/([^/]+)\/(enable|disable)$/)
      const cronDuplicateMatch = path.match(/^\/api\/cron\/([^/]+)\/duplicate$/)

      // POST /api/cron/:id/enable or /api/cron/:id/disable
      if (req.method === 'POST' && cronActionMatch) {
        const [, id, action] = cronActionMatch
        const cron = getCronService()
        if (!cron) {
          this.json(res, { error: 'Cron service not available' }, 503)
          return
        }
        const ok = action === 'enable' ? await cron.enable(id) : await cron.disable(id)
        if (!ok) {
          this.json(res, { error: 'Job not found' }, 404)
          return
        }
        this.json(res, { success: true })
        return
      }

      // POST /api/cron/:id/duplicate - duplicate a cron job
      if (req.method === 'POST' && cronDuplicateMatch) {
        const id = cronDuplicateMatch[1]
        const cron = getCronService()
        if (!cron) {
          this.json(res, { error: 'Cron service not available' }, 503)
          return
        }
        const job = await cron.duplicate(id)
        if (!job) {
          this.json(res, { error: 'Job not found' }, 404)
          return
        }
        this.json(res, { job }, 201)
        return
      }

      // GET /api/cron/:id - get single cron job
      if (req.method === 'GET' && cronMatch) {
        const id = cronMatch[1]
        const cron = getCronService()
        if (!cron) {
          this.json(res, { error: 'Cron service not available' }, 503)
          return
        }
        const job = cron.get(id)
        if (!job) {
          this.json(res, { error: 'Job not found' }, 404)
          return
        }
        this.json(res, { job })
        return
      }

      // PUT /api/cron/:id - update cron job
      if (req.method === 'PUT' && cronMatch) {
        const id = cronMatch[1]
        const body = await this.parseBody(req)
        const cron = getCronService()
        if (!cron) {
          this.json(res, { error: 'Cron service not available' }, 503)
          return
        }
        const job = await cron.update(id, body)
        if (!job) {
          this.json(res, { error: 'Job not found' }, 404)
          return
        }
        this.json(res, { job })
        return
      }

      // DELETE /api/cron/:id - 删除 cron job
      if (req.method === 'DELETE' && cronMatch) {
        const id = cronMatch[1]
        const cron = getCronService()
        if (!cron) {
          this.json(res, { error: 'Cron service not available' }, 503)
          return
        }
        const removed = await cron.remove(id)
        if (!removed) {
          this.json(res, { error: 'Job not found' }, 404)
          return
        }
        this.json(res, { success: true })
        return
      }

      // ========== Static files ==========
      if (req.method === 'GET' && !path.startsWith('/api/')) {
        if (this.serveStatic(res, path)) {
          return
        }
      }

      // 404
      this.json(res, { error: 'Not found' }, 404)
    } catch (err) {
      log.error('API error:', err)
      this.json(res, { error: (err as Error).message }, 500)
    }
  }

  private serveStatic(res: ServerResponse, filePath: string): boolean {
    const publicDir = join(process.cwd(), 'public')
    const fullPath = join(publicDir, filePath === '/' ? 'index.html' : filePath)

    if (!existsSync(fullPath)) {
      return false
    }

    try {
      const content = readFileSync(fullPath)
      const ext = extname(fullPath)
      const contentType = MIME_TYPES[ext] || 'application/octet-stream'
      const headers: Record<string, string> = { 'Content-Type': contentType }
      // Prevent caching for HTML so dev changes are picked up immediately
      if (ext === '.html') {
        headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
      }
      res.writeHead(200, headers)
      res.end(content)
      return true
    } catch {
      return false
    }
  }

  private json(res: ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  private async parseBody(req: IncomingMessage): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {})
        } catch {
          resolve({})
        }
      })
      req.on('error', reject)
    })
  }
}
