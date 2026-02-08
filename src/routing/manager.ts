// Binding Manager: handles routing configuration persistence
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { Binding, BindingStore, BindingMatch, RouteInput, RouteResult, ChannelId } from './types.js'

const DEFAULT_DATA_DIR = join(process.cwd(), 'data', 'routing')

export class BindingManager {
  private dataDir: string
  private storePath: string

  constructor(dataDir: string = DEFAULT_DATA_DIR) {
    this.dataDir = dataDir
    this.storePath = join(dataDir, 'bindings.json')
    this.ensureDirs()
  }

  private ensureDirs(): void {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true })
    }
    if (!existsSync(this.storePath)) {
      const store: BindingStore = { bindings: [] }
      writeFileSync(this.storePath, JSON.stringify(store, null, 2))
    }
  }

  private loadStore(): BindingStore {
    const content = readFileSync(this.storePath, 'utf-8')
    return JSON.parse(content)
  }

  private saveStore(store: BindingStore): void {
    writeFileSync(this.storePath, JSON.stringify(store, null, 2))
  }

  // === Binding CRUD ===

  createBinding(config: {
    agentId: string
    match: BindingMatch
    priority?: number
  }): Binding {
    const store = this.loadStore()
    const now = Date.now()

    const binding: Binding = {
      id: randomUUID().slice(0, 8),
      agentId: config.agentId,
      match: config.match,
      priority: config.priority,
      createdAt: now,
      updatedAt: now,
    }

    store.bindings.push(binding)
    this.saveStore(store)
    return binding
  }

  getBinding(id: string): Binding | null {
    const store = this.loadStore()
    return store.bindings.find(b => b.id === id) || null
  }

  listBindings(): Binding[] {
    const store = this.loadStore()
    return store.bindings.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
  }

  updateBinding(id: string, updates: Partial<Omit<Binding, 'id' | 'createdAt'>>): Binding | null {
    const store = this.loadStore()
    const index = store.bindings.findIndex(b => b.id === id)
    if (index === -1) return null

    store.bindings[index] = {
      ...store.bindings[index],
      ...updates,
      updatedAt: Date.now(),
    }
    this.saveStore(store)
    return store.bindings[index]
  }

  deleteBinding(id: string): boolean {
    const store = this.loadStore()
    const index = store.bindings.findIndex(b => b.id === id)
    if (index === -1) return false

    store.bindings.splice(index, 1)
    this.saveStore(store)
    return true
  }

  // === Routing Logic ===

  /**
   * 根据输入解析应该使用哪个 Agent
   * 优先级：peer > guild > team > account > channel > default
   */
  resolveRoute(input: RouteInput, defaultAgentId: string): RouteResult {
    const bindings = this.listBindings()

    // 过滤出匹配 channel 的绑定
    const channelBindings = bindings.filter(b =>
      b.match.channel === input.channel
    )

    // 1. 尝试 peer 绑定（精确匹配用户/群组）
    if (input.peer) {
      const peerMatch = channelBindings.find(b =>
        b.match.peer?.kind === input.peer?.kind &&
        b.match.peer?.id === input.peer?.id
      )
      if (peerMatch) {
        return { agentId: peerMatch.agentId, matchedBy: 'peer', binding: peerMatch }
      }
    }

    // 2. 尝试 guild 绑定（Discord 服务器）
    if (input.guildId) {
      const guildMatch = channelBindings.find(b => b.match.guildId === input.guildId)
      if (guildMatch) {
        return { agentId: guildMatch.agentId, matchedBy: 'guild', binding: guildMatch }
      }
    }

    // 3. 尝试 team 绑定（Slack 工作区）
    if (input.teamId) {
      const teamMatch = channelBindings.find(b => b.match.teamId === input.teamId)
      if (teamMatch) {
        return { agentId: teamMatch.agentId, matchedBy: 'team', binding: teamMatch }
      }
    }

    // 4. 尝试 account 绑定（特定账户）
    if (input.accountId) {
      const accountMatch = channelBindings.find(b =>
        b.match.accountId === input.accountId &&
        !b.match.peer && !b.match.guildId && !b.match.teamId
      )
      if (accountMatch) {
        return { agentId: accountMatch.agentId, matchedBy: 'account', binding: accountMatch }
      }
    }

    // 5. 尝试 channel 绑定（通配符账户）
    const channelMatch = channelBindings.find(b =>
      (b.match.accountId === '*' || !b.match.accountId) &&
      !b.match.peer && !b.match.guildId && !b.match.teamId
    )
    if (channelMatch) {
      return { agentId: channelMatch.agentId, matchedBy: 'channel', binding: channelMatch }
    }

    // 6. 返回默认 Agent
    return { agentId: defaultAgentId, matchedBy: 'default' }
  }
}

// 单例导出
let instance: BindingManager | null = null

export function getBindingManager(dataDir?: string): BindingManager {
  if (!instance) {
    instance = new BindingManager(dataDir)
  }
  return instance
}
