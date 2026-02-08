// Agent Manager: handles agent configuration persistence
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { AgentConfig, AgentStore } from './types.js'

const DEFAULT_DATA_DIR = join(process.cwd(), 'data', 'agents')

export class AgentManager {
  private dataDir: string
  private storePath: string

  constructor(dataDir: string = DEFAULT_DATA_DIR) {
    this.dataDir = dataDir
    this.storePath = join(dataDir, 'agents.json')
    this.ensureDirs()
  }

  private ensureDirs(): void {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true })
    }
    if (!existsSync(this.storePath)) {
      // 创建默认 agent
      const defaultAgent: AgentConfig = {
        agentId: 'default',
        name: 'Default Agent',
        description: 'The default assistant',
        model: process.env.LLM_MODEL || 'gpt-4o',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      const store: AgentStore = {
        agents: { default: defaultAgent },
        defaultAgentId: 'default',
      }
      writeFileSync(this.storePath, JSON.stringify(store, null, 2))
    }
  }

  private loadStore(): AgentStore {
    const content = readFileSync(this.storePath, 'utf-8')
    return JSON.parse(content)
  }

  private saveStore(store: AgentStore): void {
    writeFileSync(this.storePath, JSON.stringify(store, null, 2))
  }

  // === Agent CRUD ===

  /** 创建新 agent */
  createAgent(config: {
    name: string
    model: string
    description?: string
    baseUrl?: string
    systemPrompt?: string
  }): AgentConfig {
    const store = this.loadStore()
    const agentId = randomUUID().slice(0, 8)
    const now = Date.now()

    const agent: AgentConfig = {
      agentId,
      name: config.name,
      description: config.description,
      model: config.model,
      baseUrl: config.baseUrl,
      systemPrompt: config.systemPrompt,
      createdAt: now,
      updatedAt: now,
    }

    store.agents[agentId] = agent
    this.saveStore(store)
    return agent
  }

  /** 获取 agent */
  getAgent(agentId: string): AgentConfig | null {
    const store = this.loadStore()
    return store.agents[agentId] || null
  }

  /** 获取默认 agent */
  getDefaultAgent(): AgentConfig | null {
    const store = this.loadStore()
    if (!store.defaultAgentId) return null
    return store.agents[store.defaultAgentId] || null
  }

  /** 设置默认 agent */
  setDefaultAgent(agentId: string): boolean {
    const store = this.loadStore()
    if (!store.agents[agentId]) return false
    store.defaultAgentId = agentId
    this.saveStore(store)
    return true
  }

  /** 列出所有 agent */
  listAgents(): AgentConfig[] {
    const store = this.loadStore()
    return Object.values(store.agents).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 更新 agent */
  updateAgent(agentId: string, updates: Partial<Omit<AgentConfig, 'agentId' | 'createdAt'>>): AgentConfig | null {
    const store = this.loadStore()
    const agent = store.agents[agentId]
    if (!agent) return null

    Object.assign(agent, updates, { updatedAt: Date.now() })
    this.saveStore(store)
    return agent
  }

  /** 删除 agent */
  deleteAgent(agentId: string): boolean {
    const store = this.loadStore()
    if (!store.agents[agentId]) return false
    // 不能删除当前默认 agent（必须先切换默认）
    if (store.defaultAgentId === agentId) return false

    delete store.agents[agentId]
    this.saveStore(store)
    return true
  }
}

// 单例导出
let instance: AgentManager | null = null

export function getAgentManager(dataDir?: string): AgentManager {
  if (!instance) {
    instance = new AgentManager(dataDir)
  }
  return instance
}
