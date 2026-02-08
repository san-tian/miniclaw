// Provider Manager: handles provider/model configuration
// 现在使用 ConfigManager 作为后端存储
import type { ProviderConfig } from './types.js'
import { getConfigManager } from './config-manager.js'
import { randomUUID } from 'crypto'

export class ProviderManager {
  private cm = getConfigManager()

  // === Provider CRUD ===

  createProvider(config: {
    name: string
    baseUrl: string
    apiKey: string
    format: 'openai' | 'claude'
    models: string[]
  }): ProviderConfig {
    const id = randomUUID().slice(0, 8)
    return this.cm.addProvider({
      id,
      name: config.name,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      format: config.format,
      models: config.models,
    })
  }

  getProvider(id: string): ProviderConfig | null {
    const providers = this.cm.getProviders()
    return providers.find(p => p.id === id) || null
  }

  getDefaultProvider(): ProviderConfig | null {
    return this.cm.getDefaultProvider()
  }

  setDefaultProvider(id: string): boolean {
    return this.cm.setDefaultProvider(id)
  }

  listProviders(): ProviderConfig[] {
    return this.cm.getProviders()
  }

  updateProvider(id: string, updates: Partial<Omit<ProviderConfig, 'id' | 'createdAt'>>): ProviderConfig | null {
    return this.cm.updateProvider(id, updates)
  }

  deleteProvider(id: string): boolean {
    return this.cm.deleteProvider(id)
  }

  // 获取所有可用模型（从所有 provider 汇总）
  getAllModels(): Array<{ providerId: string; providerName: string; model: string }> {
    const providers = this.listProviders()
    const models: Array<{ providerId: string; providerName: string; model: string }> = []

    for (const p of providers) {
      for (const model of p.models) {
        models.push({
          providerId: p.id,
          providerName: p.name,
          model,
        })
      }
    }
    return models
  }

  // 根据模型名称查找对应的 provider
  getProviderByModel(modelName: string): ProviderConfig | null {
    const providers = this.listProviders()
    for (const p of providers) {
      if (p.models.includes(modelName)) {
        return p
      }
    }
    return null
  }
}

// 单例导出
let instance: ProviderManager | null = null

export function getProviderManager(): ProviderManager {
  if (!instance) {
    instance = new ProviderManager()
  }
  return instance
}
