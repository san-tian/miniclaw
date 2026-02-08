// Cron Store: Persist cron jobs to disk
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'
import type { CronJob } from './types.js'
import { createLogger } from '../infra/logger.js'

const log = createLogger('cron-store')

export class CronStore {
  private path: string
  private jobs: CronJob[] = []

  constructor(path: string) {
    this.path = path
  }

  async load(): Promise<CronJob[]> {
    if (!existsSync(this.path)) {
      log.info('No cron store found, starting fresh')
      return []
    }

    try {
      const content = await readFile(this.path, 'utf-8')
      this.jobs = JSON.parse(content)
      log.info(`Loaded ${this.jobs.length} cron jobs`)
      return this.jobs
    } catch (err) {
      log.error('Failed to load cron store:', err)
      return []
    }
  }

  async save(): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true })
      await writeFile(this.path, JSON.stringify(this.jobs, null, 2))
      log.debug('Cron store saved')
    } catch (err) {
      log.error('Failed to save cron store:', err)
    }
  }

  getAll(): CronJob[] {
    return [...this.jobs]
  }

  get(id: string): CronJob | undefined {
    return this.jobs.find((j) => j.id === id)
  }

  async add(job: CronJob): Promise<void> {
    this.jobs.push(job)
    await this.save()
  }

  async remove(id: string): Promise<boolean> {
    const idx = this.jobs.findIndex((j) => j.id === id)
    if (idx === -1) return false
    this.jobs.splice(idx, 1)
    await this.save()
    return true
  }

  async update(id: string, updates: Partial<CronJob>): Promise<boolean> {
    const job = this.jobs.find((j) => j.id === id)
    if (!job) return false
    Object.assign(job, updates)
    await this.save()
    return true
  }
}
