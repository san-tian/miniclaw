// Subagent Registry: manages subagent lifecycle and persistence
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { SubagentRunRecord, SubagentOutcome } from './types.js'
import { createLogger } from '../../infra/logger.js'

const log = createLogger('subagent-registry')
const DEFAULT_DATA_DIR = join(process.cwd(), 'data', 'subagents')
const ARCHIVE_AFTER_MINUTES = 60

class SubagentRegistry {
  private dataDir: string
  private registryPath: string
  private runs: Map<string, SubagentRunRecord> = new Map()
  private sweeper: NodeJS.Timeout | null = null
  private completionCallbacks: Map<string, (record: SubagentRunRecord) => void> = new Map()

  constructor(dataDir: string = DEFAULT_DATA_DIR) {
    this.dataDir = dataDir
    this.registryPath = join(dataDir, 'registry.json')
    this.ensureDirs()
    this.restore()
  }

  private ensureDirs(): void {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true })
    }
  }

  private persist(): void {
    try {
      const data = Object.fromEntries(this.runs)
      writeFileSync(this.registryPath, JSON.stringify(data, null, 2))
    } catch (err) {
      log.error('Failed to persist registry:', err)
    }
  }

  private restore(): void {
    try {
      if (!existsSync(this.registryPath)) return
      const data = JSON.parse(readFileSync(this.registryPath, 'utf-8'))
      this.runs = new Map(Object.entries(data))
      log.info(`Restored ${this.runs.size} subagent records`)

      // Start sweeper if there are pending archives
      if ([...this.runs.values()].some((r) => r.archiveAtMs)) {
        this.startSweeper()
      }
    } catch (err) {
      log.error('Failed to restore registry:', err)
    }
  }

  private startSweeper(): void {
    if (this.sweeper) return
    this.sweeper = setInterval(() => this.sweep(), 60_000)
    this.sweeper.unref?.()
  }

  private stopSweeper(): void {
    if (!this.sweeper) return
    clearInterval(this.sweeper)
    this.sweeper = null
  }

  private sweep(): void {
    const now = Date.now()
    let mutated = false

    for (const [runId, entry] of this.runs.entries()) {
      if (!entry.archiveAtMs || entry.archiveAtMs > now) continue

      log.info(`Archiving subagent run: ${runId}`)
      this.runs.delete(runId)
      mutated = true
    }

    if (mutated) {
      this.persist()
    }

    if (this.runs.size === 0) {
      this.stopSweeper()
    }
  }

  /** Register a new subagent run */
  register(params: {
    runId: string
    childSessionKey: string
    requesterSessionKey: string
    task: string
    label?: string
    cleanup: 'delete' | 'keep'
    archiveAfterMinutes?: number
  }): void {
    const now = Date.now()
    const archiveMinutes = params.archiveAfterMinutes ?? ARCHIVE_AFTER_MINUTES
    const archiveAtMs = archiveMinutes > 0 ? now + archiveMinutes * 60_000 : undefined

    const record: SubagentRunRecord = {
      runId: params.runId,
      childSessionKey: params.childSessionKey,
      requesterSessionKey: params.requesterSessionKey,
      task: params.task,
      label: params.label,
      cleanup: params.cleanup,
      createdAt: now,
      startedAt: now,
      archiveAtMs,
      cleanupHandled: false,
    }

    this.runs.set(params.runId, record)
    this.persist()

    if (archiveAtMs) {
      this.startSweeper()
    }

    log.info(`Registered subagent run: ${params.runId}`)
  }

  /** Mark subagent as started */
  markStarted(runId: string): void {
    const record = this.runs.get(runId)
    if (!record) return

    record.startedAt = Date.now()
    this.persist()
  }

  /** Mark subagent as completed */
  markCompleted(runId: string, outcome: SubagentOutcome): void {
    const record = this.runs.get(runId)
    if (!record) return

    record.endedAt = Date.now()
    record.outcome = outcome
    this.persist()

    // Trigger completion callback
    const callback = this.completionCallbacks.get(runId)
    if (callback) {
      callback(record)
      this.completionCallbacks.delete(runId)
    }

    log.info(`Subagent completed: ${runId} (${outcome.status})`)
  }

  /** Register completion callback */
  onCompletion(runId: string, callback: (record: SubagentRunRecord) => void): void {
    this.completionCallbacks.set(runId, callback)
  }

  /** Finalize cleanup after announce */
  finalizeCleanup(runId: string, didAnnounce: boolean): void {
    const record = this.runs.get(runId)
    if (!record) return

    if (record.cleanup === 'delete') {
      this.runs.delete(runId)
      this.persist()
      return
    }

    if (!didAnnounce) {
      record.cleanupHandled = false
      this.persist()
      return
    }

    record.cleanupCompletedAt = Date.now()
    this.persist()
  }

  /** Get a subagent record */
  get(runId: string): SubagentRunRecord | undefined {
    return this.runs.get(runId)
  }

  /** List all subagent runs for a requester */
  listByRequester(requesterSessionKey: string): SubagentRunRecord[] {
    return [...this.runs.values()].filter(
      (r) => r.requesterSessionKey === requesterSessionKey
    )
  }

  /** List all active (not completed) subagent runs */
  listActive(): SubagentRunRecord[] {
    return [...this.runs.values()].filter((r) => !r.endedAt)
  }

  /** Delete a subagent record */
  delete(runId: string): boolean {
    const deleted = this.runs.delete(runId)
    if (deleted) {
      this.persist()
    }
    return deleted
  }
}

// Singleton
let instance: SubagentRegistry | null = null

export function getSubagentRegistry(dataDir?: string): SubagentRegistry {
  if (!instance) {
    instance = new SubagentRegistry(dataDir)
  }
  return instance
}
