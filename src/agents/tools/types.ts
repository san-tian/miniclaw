// Tool types and interface
export interface ToolContext {
  sessionKey?: string
  channel?: string
  to?: string
  agentId?: string
}

export interface Tool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, { type: string; description: string }>
    required: string[]
  }
  execute(input: Record<string, unknown>, context?: ToolContext): Promise<string>
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResult {
  toolCallId: string
  output: string
}
