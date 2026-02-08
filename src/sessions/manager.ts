// Session Manager: handles session persistence
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import type { SessionEntry, SessionStore, TranscriptMessage } from './types.js'

const DEFAULT_DATA_DIR = join(process.cwd(), 'data', 'sessions')

export class SessionManager {
  private dataDir: string
  private storePath: string
  private transcriptsDir: string

  constructor(dataDir: string = DEFAULT_DATA_DIR) {
    this.dataDir = dataDir
    this.storePath = join(dataDir, 'sessions.json')
    this.transcriptsDir = join(dataDir, 'transcripts')
    this.ensureDirs()
  }

  private ensureDirs(): void {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true })
    }
    if (!existsSync(this.transcriptsDir)) {
      mkdirSync(this.transcriptsDir, { recursive: true })
    }
    if (!existsSync(this.storePath)) {
      writeFileSync(this.storePath, JSON.stringify({ sessions: {} }, null, 2))
    }
  }

  private loadStore(): SessionStore {
    const content = readFileSync(this.storePath, 'utf-8')
    return JSON.parse(content)
  }

  private saveStore(store: SessionStore): void {
    writeFileSync(this.storePath, JSON.stringify(store, null, 2))
  }

  // === 会话 CRUD ===

  /** 创建新会话 */
  createSession(sessionKey: string, agentId: string, title?: string, channel?: string): SessionEntry {
    const store = this.loadStore()
    const sessionId = randomUUID()
    const now = Date.now()

    // 从 sessionKey 推断 channel（如果未提供）
    const inferredChannel = channel || this.inferChannel(sessionKey)

    const entry: SessionEntry = {
      sessionId,
      sessionKey,
      agentId,
      title: title || `Session ${Object.keys(store.sessions).length + 1}`,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      channel: inferredChannel,
    }

    store.sessions[sessionId] = entry
    this.saveStore(store)
    return entry
  }

  /** 从 sessionKey 推断 channel */
  private inferChannel(sessionKey: string): string {
    if (sessionKey.startsWith('telegram:')) return 'telegram'
    if (sessionKey.startsWith('web:')) return 'web'
    if (sessionKey.startsWith('cron:')) return 'cron'
    if (sessionKey.startsWith('discord:')) return 'discord'
    if (sessionKey.startsWith('slack:')) return 'slack'
    return 'websocket'
  }

  /** 获取会话 */
  getSession(sessionId: string): SessionEntry | null {
    const store = this.loadStore()
    return store.sessions[sessionId] || null
  }

  /** 通过 sessionKey 查找会话 */
  findBySessionKey(sessionKey: string): SessionEntry | null {
    const store = this.loadStore()
    return Object.values(store.sessions).find((s) => s.sessionKey === sessionKey) || null
  }

  /** 获取或创建会话 */
  getOrCreate(sessionKey: string, agentId: string, channel?: string): SessionEntry {
    const existing = this.findBySessionKey(sessionKey)
    if (existing) return existing
    return this.createSession(sessionKey, agentId, undefined, channel)
  }

  /** 列出所有会话 */
  listSessions(agentId?: string, channel?: string): SessionEntry[] {
    const store = this.loadStore()
    let sessions = Object.values(store.sessions).map(s => {
      // 为旧会话推断 channel
      const inferredChannel = s.channel || this.inferChannel(s.sessionKey)
      // 获取第一条用户消息
      const firstUserMsg = this.getFirstUserMessage(s.sessionId)
      // 使用 openclaw 风格的标题派生逻辑
      const derivedTitle = this.deriveSessionTitle(s, firstUserMsg)
      return {
        ...s,
        channel: inferredChannel,
        title: derivedTitle,
      }
    })
    if (agentId) {
      sessions = sessions.filter((s) => s.agentId === agentId)
    }
    if (channel) {
      sessions = sessions.filter((s) => s.channel === channel)
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 获取第一条用户消息 */
  private getFirstUserMessage(sessionId: string): string | null {
    const messages = this.loadTranscript(sessionId)
    const firstUserMsg = messages.find(m => m.role === 'user')
    return firstUserMsg?.content || null
  }

  /**
   * 派生会话标题（与 openclaw 逻辑一致）
   * 优先级：displayName > subject > firstUserMessage > sessionId
   */
  private deriveSessionTitle(entry: SessionEntry, firstUserMessage: string | null): string {
    const DERIVED_TITLE_MAX_LEN = 60

    // 1. 优先使用 displayName
    if (entry.displayName?.trim()) {
      return entry.displayName.trim()
    }

    // 2. 其次使用 subject
    if (entry.subject?.trim()) {
      return entry.subject.trim()
    }

    // 3. 使用第一条用户消息
    if (firstUserMessage?.trim()) {
      const normalized = firstUserMessage.replace(/\s+/g, ' ').trim()
      return this.truncateTitle(normalized, DERIVED_TITLE_MAX_LEN)
    }

    // 4. 回退到 sessionId + 日期
    return this.formatSessionIdPrefix(entry.sessionId, entry.updatedAt)
  }

  /** 截断标题，在单词边界处截断 */
  private truncateTitle(text: string, maxLen: number): string {
    if (text.length <= maxLen) {
      return text
    }
    const cut = text.slice(0, maxLen - 1)
    const lastSpace = cut.lastIndexOf(' ')
    if (lastSpace > maxLen * 0.6) {
      return cut.slice(0, lastSpace) + '…'
    }
    return cut + '…'
  }

  /** 格式化 sessionId 前缀 + 日期 */
  private formatSessionIdPrefix(sessionId: string, updatedAt?: number): string {
    const prefix = sessionId.slice(0, 8)
    if (updatedAt && updatedAt > 0) {
      const d = new Date(updatedAt)
      const date = d.toISOString().slice(0, 10)
      return `${prefix} (${date})`
    }
    return prefix
  }

  /** 更新会话 */
  updateSession(sessionId: string, updates: Partial<SessionEntry>): SessionEntry | null {
    const store = this.loadStore()
    const session = store.sessions[sessionId]
    if (!session) return null

    Object.assign(session, updates, { updatedAt: Date.now() })
    this.saveStore(store)
    return session
  }

  /** 删除会话 */
  deleteSession(sessionId: string): boolean {
    const store = this.loadStore()
    if (!store.sessions[sessionId]) return false

    delete store.sessions[sessionId]
    this.saveStore(store)

    // 删除转录文件
    const transcriptPath = join(this.transcriptsDir, `${sessionId}.jsonl`)
    if (existsSync(transcriptPath)) {
      const { unlinkSync } = require('fs')
      unlinkSync(transcriptPath)
    }
    return true
  }

  // === 转录（对话历史）管理 ===

  private getTranscriptPath(sessionId: string): string {
    return join(this.transcriptsDir, `${sessionId}.jsonl`)
  }

  /** 追加消息到转录 */
  appendMessage(sessionId: string, message: TranscriptMessage): void {
    const path = this.getTranscriptPath(sessionId)
    const line = JSON.stringify(message) + '\n'
    appendFileSync(path, line)

    // 更新会话元数据
    const store = this.loadStore()
    const session = store.sessions[sessionId]
    if (session) {
      session.messageCount++
      session.updatedAt = Date.now()
      // 用首条用户消息作为标题
      if (message.role === 'user' && session.messageCount === 1) {
        session.title = message.content.slice(0, 50) + (message.content.length > 50 ? '...' : '')
      }
      this.saveStore(store)
    }
  }

  /** 读取会话的所有消息 */
  loadTranscript(sessionId: string): TranscriptMessage[] {
    const path = this.getTranscriptPath(sessionId)
    if (!existsSync(path)) return []

    const content = readFileSync(path, 'utf-8')
    const messages: TranscriptMessage[] = []
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        messages.push(JSON.parse(line))
      } catch {
        // skip corrupted lines
      }
    }
    return messages
  }

  /** 将转录转换为 LLM 消息格式 */
  toMessages(sessionId: string): Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: any[] }> {
    return this.loadTranscript(sessionId).map((msg) => ({
      role: msg.role,
      content: msg.content,
      ...(msg.tool_call_id && { tool_call_id: msg.tool_call_id }),
      ...(msg.tool_calls && { tool_calls: msg.tool_calls }),
    }))
  }
}

// 单例导出
let instance: SessionManager | null = null

export function getSessionManager(dataDir?: string): SessionManager {
  if (!instance) {
    instance = new SessionManager(dataDir)
  }
  return instance
}
