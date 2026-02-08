// Cron Service Singleton: Global access to CronService
import { CronService } from './service.js'

let instance: CronService | null = null

export function setCronService(service: CronService): void {
  instance = service
}

export function getCronService(): CronService | null {
  return instance
}
