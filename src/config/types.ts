// Config types
export interface Config {
  llm: {
    apiKey: string
    baseUrl: string
    model: string
    format: 'openai' | 'claude'
  }
  gateway: {
    port: number
  }
}

// Provider/Model configuration
export interface ProviderConfig {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  format: 'openai' | 'claude'
  models: string[] // 可用模型列表
  isDefault?: boolean
  createdAt: number
  updatedAt: number
}

export interface ProviderStore {
  providers: Record<string, ProviderConfig>
  defaultProviderId?: string
}
