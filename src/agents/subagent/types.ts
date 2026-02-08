// Subagent types for mini-claw

export interface SubagentRunRecord {
  runId: string
  childSessionKey: string
  requesterSessionKey: string
  task: string
  label?: string
  cleanup: 'delete' | 'keep'
  createdAt: number
  startedAt?: number
  endedAt?: number
  outcome?: SubagentOutcome
  archiveAtMs?: number
  cleanupCompletedAt?: number
  cleanupHandled?: boolean
}

export interface SubagentOutcome {
  status: 'ok' | 'error' | 'timeout'
  error?: string
}

export interface SubagentSpawnParams {
  task: string
  label?: string
  model?: string
  runTimeoutSeconds?: number
  cleanup?: 'delete' | 'keep'
}

export interface SubagentSpawnResult {
  status: 'accepted' | 'forbidden' | 'error'
  childSessionKey?: string
  runId?: string
  error?: string
}

export interface SubagentConfig {
  archiveAfterMinutes?: number
  maxConcurrent?: number
  model?: string
}
