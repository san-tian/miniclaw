// WebSocket Channel
import { WebSocketServer, WebSocket } from 'ws'
import { v4 as uuid } from 'uuid'
import type { Server } from 'http'
import type { Channel, Message, Reply } from './types.js'
import { createLogger } from '../infra/logger.js'

const log = createLogger('websocket')

export class WebSocketChannel implements Channel {
  name = 'websocket'
  private wss?: WebSocketServer
  private clients: Map<string, WebSocket> = new Map()
  private messageHandler?: (msg: Message) => void
  private port: number
  private httpServer?: Server

  constructor(port: number) {
    this.port = port
  }

  /** 设置共享的 HTTP Server */
  setHttpServer(server: Server): void {
    this.httpServer = server
  }

  onMessage(handler: (msg: Message) => void): void {
    this.messageHandler = handler
  }

  async send(sessionKey: string, reply: Reply): Promise<void> {
    log.info(`send: sessionKey=${sessionKey}, text=${(reply.text || '').slice(0, 80)}, activeClients=[${[...this.clients.keys()].join(', ')}]`)
    const client = this.clients.get(sessionKey)
    if (client && client.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify({ type: 'reply', ...reply })
      log.info(`send: delivering ${payload.length} bytes to client`)
      client.send(payload)
    } else if (sessionKey === 'broadcast') {
      for (const c of this.clients.values()) {
        if (c.readyState === WebSocket.OPEN) {
          c.send(JSON.stringify({ type: 'reply', ...reply }))
        }
      }
    } else {
      log.warn(`send: no client found for sessionKey=${sessionKey}, active clients: [${[...this.clients.keys()].join(', ')}]`)
    }
  }

  async sendChunk(sessionKey: string, chunk: string): Promise<void> {
    const client = this.clients.get(sessionKey)
    if (client && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'chunk', text: chunk }))
    }
  }

  async sendToolCall(sessionKey: string, toolName: string, input: Record<string, unknown>): Promise<void> {
    const client = this.clients.get(sessionKey)
    if (client && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'tool_call', name: toolName, input }))
    }
  }

  async sendToolResult(sessionKey: string, toolName: string, output: string): Promise<void> {
    const client = this.clients.get(sessionKey)
    if (client && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'tool_result', name: toolName, output: output.slice(0, 500) }))
    }
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      // 如果有共享的 HTTP Server，使用它；否则独立监听端口
      if (this.httpServer) {
        this.wss = new WebSocketServer({ server: this.httpServer })
        log.info(`WebSocket attached to HTTP server`)
      } else {
        this.wss = new WebSocketServer({ port: this.port })
      }

      this.wss.on('connection', (ws) => {
        const clientId = uuid()
        const subscribedKeys = new Set<string>()  // Track all sessionKeys this client is subscribed to
        let sessionKey = clientId // 默认使用 clientId 作为 sessionKey
        subscribedKeys.add(sessionKey)
        this.clients.set(sessionKey, ws)
        log.info(`Client connected: ${clientId}`)

        ws.send(JSON.stringify({ type: 'connected', clientId, sessionKey }))

        ws.on('message', (data) => {
          try {
            const parsed = JSON.parse(data.toString())

            // 支持切换会话
            if (parsed.type === 'switch_session' && parsed.sessionKey) {
              // Keep old sessionKey mappings so async messages (subagent results) can still reach this client
              sessionKey = parsed.sessionKey
              subscribedKeys.add(sessionKey)
              this.clients.set(sessionKey, ws)
              log.info(`Client ${clientId} switched to session: ${sessionKey} (subscribed: ${subscribedKeys.size} keys)`)
              ws.send(JSON.stringify({ type: 'session_switched', sessionKey }))
              return
            }

            // 处理消息
            if (parsed.type === 'message' && parsed.text) {
              const msg: Message = {
                id: uuid(),
                channel: 'websocket',
                from: clientId,
                text: parsed.text,
                timestamp: Date.now(),
                sessionKey,
                // 可选：指定 sessionId 和 agentId
                sessionId: parsed.sessionId,
                agentId: parsed.agentId,
              }
              this.messageHandler?.(msg)
            }
          } catch (e) {
            log.error('Failed to parse message:', e)
          }
        })

        ws.on('close', () => {
          // Clean up all sessionKey mappings for this client
          for (const key of subscribedKeys) {
            this.clients.delete(key)
          }
          log.info(`Client disconnected: ${clientId} (cleaned ${subscribedKeys.size} keys)`)
        })
      })

      // 如果使用共享 HTTP Server，直接 resolve
      if (this.httpServer) {
        resolve()
      } else {
        this.wss.on('listening', () => {
          log.info(`WebSocket server listening on port ${this.port}`)
          resolve()
        })
      }
    })
  }

  async stop(): Promise<void> {
    this.wss?.close()
    this.clients.clear()
  }
}
