// Agent types for mini-claw

export interface AgentConfig {
  agentId: string
  name: string
  description?: string
  model: string // 模型名称，如 gpt-4o, claude-3-opus
  baseUrl?: string // 可选的自定义 API 地址
  systemPrompt?: string // 可选的自定义系统提示
  createdAt: number
  updatedAt: number
}

export interface AgentStore {
  agents: Record<string, AgentConfig>
  defaultAgentId?: string
}
