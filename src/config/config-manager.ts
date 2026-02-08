// Config Manager: handles ~/.mini-claw/config.json
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { ProviderConfig, ProviderStore } from './types.js'

// 配置文件路径: ~/.mini-claw/config.json
const CONFIG_DIR = process.env.MINI_CLAW_CONFIG_DIR || join(homedir(), '.mini-claw')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

export interface MiniClawConfig {
  // 元信息
  meta: {
    version: string
    createdAt: number
    updatedAt: number
  }
  // Gateway 配置
  gateway: {
    port: number
    host: string
  }
  // Providers 配置（包含 API keys）
  providers: ProviderStore
  // 其他可选配置
  telegram?: {
    botToken: string
    allowFrom?: string[]
  }
  composio?: {
    apiKey: string
  }
}

const DEFAULT_CONFIG: MiniClawConfig = {
  meta: {
    version: '1.0.0',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  gateway: {
    port: 18789,
    host: '0.0.0.0',
  },
  providers: {
    providers: {},
    defaultProviderId: undefined,
  },
}

export class ConfigManager {
  private configPath: string
  private configDir: string

  constructor(configDir: string = CONFIG_DIR) {
    this.configDir = configDir
    this.configPath = join(configDir, 'config.json')
  }

  /** 获取配置目录路径 */
  getConfigDir(): string {
    return this.configDir
  }

  /** 获取配置文件路径 */
  getConfigPath(): string {
    return this.configPath
  }

  /** 确保配置目录存在 */
  private ensureDir(): void {
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true })
    }
  }

  /** 检查配置文件是否存在 */
  exists(): boolean {
    return existsSync(this.configPath)
  }

  /** 加载配置 */
  load(): MiniClawConfig {
    this.ensureDir()
    if (!this.exists()) {
      return { ...DEFAULT_CONFIG }
    }
    try {
      const content = readFileSync(this.configPath, 'utf-8')
      const config = JSON.parse(content) as MiniClawConfig
      // 合并默认值（处理新增字段）
      return this.mergeWithDefaults(config)
    } catch (e) {
      console.error('Failed to load config:', e)
      return { ...DEFAULT_CONFIG }
    }
  }

  /** 保存配置 */
  save(config: MiniClawConfig): void {
    this.ensureDir()
    config.meta.updatedAt = Date.now()
    writeFileSync(this.configPath, JSON.stringify(config, null, 2))
  }

  /** 初始化配置（首次运行） */
  init(options?: {
    provider?: {
      name: string
      baseUrl: string
      apiKey: string
      format: 'openai' | 'claude'
      models: string[]
    }
  }): MiniClawConfig {
    const config = { ...DEFAULT_CONFIG }
    config.meta.createdAt = Date.now()
    config.meta.updatedAt = Date.now()

    if (options?.provider) {
      const provider: ProviderConfig = {
        id: 'default',
        name: options.provider.name,
        baseUrl: options.provider.baseUrl,
        apiKey: options.provider.apiKey,
        format: options.provider.format,
        models: options.provider.models,
        isDefault: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      config.providers.providers['default'] = provider
      config.providers.defaultProviderId = 'default'
    }

    this.save(config)
    return config
  }

  /** 合并默认值 */
  private mergeWithDefaults(config: Partial<MiniClawConfig>): MiniClawConfig {
    return {
      meta: { ...DEFAULT_CONFIG.meta, ...config.meta },
      gateway: { ...DEFAULT_CONFIG.gateway, ...config.gateway },
      providers: config.providers || DEFAULT_CONFIG.providers,
      telegram: config.telegram,
      composio: config.composio,
    }
  }

  // === Provider 操作 ===

  /** 获取所有 providers */
  getProviders(): ProviderConfig[] {
    const config = this.load()
    return Object.values(config.providers.providers)
      .map(p => ({
        ...p,
        isDefault: p.id === config.providers.defaultProviderId
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 获取默认 provider */
  getDefaultProvider(): ProviderConfig | null {
    const config = this.load()
    const id = config.providers.defaultProviderId
    if (!id) return null
    const provider = config.providers.providers[id]
    return provider ? { ...provider, isDefault: true } : null
  }

  /** 添加 provider */
  addProvider(provider: Omit<ProviderConfig, 'createdAt' | 'updatedAt'>): ProviderConfig {
    const config = this.load()
    const now = Date.now()
    const newProvider: ProviderConfig = {
      ...provider,
      createdAt: now,
      updatedAt: now,
    }
    config.providers.providers[provider.id] = newProvider

    // 如果是第一个 provider，设为默认
    if (Object.keys(config.providers.providers).length === 1) {
      config.providers.defaultProviderId = provider.id
      newProvider.isDefault = true
    }

    this.save(config)
    return newProvider
  }

  /** 更新 provider */
  updateProvider(id: string, updates: Partial<ProviderConfig>): ProviderConfig | null {
    const config = this.load()
    const provider = config.providers.providers[id]
    if (!provider) return null

    Object.assign(provider, updates, { updatedAt: Date.now() })
    this.save(config)
    return provider
  }

  /** 删除 provider */
  deleteProvider(id: string): boolean {
    const config = this.load()
    if (!config.providers.providers[id]) return false
    if (config.providers.defaultProviderId === id) return false

    delete config.providers.providers[id]
    this.save(config)
    return true
  }

  /** 设置默认 provider */
  setDefaultProvider(id: string): boolean {
    const config = this.load()
    if (!config.providers.providers[id]) return false
    config.providers.defaultProviderId = id
    this.save(config)
    return true
  }
}

// 单例
let instance: ConfigManager | null = null

export function getConfigManager(): ConfigManager {
  if (!instance) {
    instance = new ConfigManager()
  }
  return instance
}

/** 获取配置目录路径 */
export function getConfigDir(): string {
  return CONFIG_DIR
}

/** 获取配置文件路径 */
export function getConfigPath(): string {
  return CONFIG_PATH
}
