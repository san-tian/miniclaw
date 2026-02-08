// Cron types
export interface CronJob {
  id: string
  schedule: string
  message: string
  enabled: boolean
  createdAt: number
  lastRun?: number
  /** Target channel (telegram, websocket). Defaults to websocket */
  channel?: string
  /** Target recipient (e.g. telegram chat ID) */
  to?: string
  /** Human-readable name for the job */
  name?: string
  /** Description of what this job does */
  description?: string
  /** Agent ID to handle this job's messages */
  agentId?: string
}
