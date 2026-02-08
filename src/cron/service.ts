// Cron Service: Schedule and execute cron jobs
import { CronJob as CronJobRunner } from 'cron'
import { v4 as uuid } from 'uuid'
import { CronStore } from './store.js'
import type { CronJob } from './types.js'
import { createLogger } from '../infra/logger.js'

const log = createLogger('cron')

export type CronHandler = (job: CronJob) => Promise<void>

export class CronService {
  private store: CronStore
  private runners: Map<string, CronJobRunner> = new Map()
  private handler?: CronHandler

  constructor(storePath: string) {
    this.store = new CronStore(storePath)
  }

  onTrigger(handler: CronHandler): void {
    this.handler = handler
  }

  async start(): Promise<void> {
    const jobs = await this.store.load()
    for (const job of jobs) {
      if (job.enabled) {
        this.scheduleJob(job)
      }
    }
    log.info(`Cron service started with ${jobs.length} jobs`)
  }

  async stop(): Promise<void> {
    for (const runner of this.runners.values()) {
      runner.stop()
    }
    this.runners.clear()
    log.info('Cron service stopped')
  }

  private scheduleJob(job: CronJob): void {
    try {
      const runner = new CronJobRunner(
        job.schedule,
        async () => {
          log.info(`Cron triggered: ${job.id} - ${job.message.slice(0, 50)}`)
          await this.store.update(job.id, { lastRun: Date.now() })
          await this.handler?.(job)
        },
        null,
        true // start immediately
      )
      this.runners.set(job.id, runner)
      log.info(`Scheduled job: ${job.id} (${job.schedule})`)
    } catch (err) {
      log.error(`Failed to schedule job ${job.id}:`, err)
    }
  }

  async add(schedule: string, message: string, opts?: { channel?: string; to?: string; name?: string; description?: string; agentId?: string }): Promise<CronJob> {
    const job: CronJob = {
      id: uuid().slice(0, 8),
      schedule,
      message,
      enabled: true,
      createdAt: Date.now(),
      channel: opts?.channel,
      to: opts?.to,
      name: opts?.name,
      description: opts?.description,
      agentId: opts?.agentId,
    }

    await this.store.add(job)
    this.scheduleJob(job)
    log.info(`Added cron job: ${job.id} (target: ${job.channel || 'websocket'}:${job.to || 'default'})`)
    return job
  }

  async remove(id: string): Promise<boolean> {
    const runner = this.runners.get(id)
    if (runner) {
      runner.stop()
      this.runners.delete(id)
    }
    const removed = await this.store.remove(id)
    if (removed) {
      log.info(`Removed cron job: ${id}`)
    }
    return removed
  }

  list(): CronJob[] {
    return this.store.getAll()
  }

  get(id: string): CronJob | undefined {
    return this.store.get(id)
  }

  async update(id: string, updates: Partial<Omit<CronJob, 'id' | 'createdAt'>>): Promise<CronJob | null> {
    const job = this.store.get(id)
    if (!job) return null

    // If schedule changed, reschedule
    const needsReschedule = updates.schedule && updates.schedule !== job.schedule

    const ok = await this.store.update(id, updates)
    if (!ok) return null

    const updated = this.store.get(id)!

    if (needsReschedule || updates.enabled !== undefined) {
      // Stop existing runner
      const runner = this.runners.get(id)
      if (runner) {
        runner.stop()
        this.runners.delete(id)
      }
      // Reschedule if enabled
      if (updated.enabled) {
        this.scheduleJob(updated)
      }
    }

    log.info(`Updated cron job: ${id}`)
    return updated
  }

  async duplicate(id: string): Promise<CronJob | null> {
    const job = this.store.get(id)
    if (!job) return null

    return this.add(job.schedule, job.message, {
      channel: job.channel,
      to: job.to,
      name: job.name ? `${job.name} (Copy)` : undefined,
      description: job.description,
      agentId: job.agentId,
    })
  }

  async enable(id: string): Promise<boolean> {
    const job = this.store.get(id)
    if (!job) return false

    await this.store.update(id, { enabled: true })
    if (!this.runners.has(id)) {
      this.scheduleJob(job)
    }
    return true
  }

  async disable(id: string): Promise<boolean> {
    const runner = this.runners.get(id)
    if (runner) {
      runner.stop()
      this.runners.delete(id)
    }
    return this.store.update(id, { enabled: false })
  }
}
