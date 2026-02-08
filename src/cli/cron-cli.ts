// CLI: Cron command - Manage cron jobs
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { CronService } from '../cron/service.js'
import { createLogger } from '../infra/logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const log = createLogger('cron-cli')

const cronService = new CronService(resolve(__dirname, '../../data/cron.json'))

export async function cronAdd(schedule: string, message: string): Promise<void> {
  await cronService.start()
  const job = await cronService.add(schedule, message)
  console.log(`✅ Added cron job:`)
  console.log(`   ID: ${job.id}`)
  console.log(`   Schedule: ${job.schedule}`)
  console.log(`   Message: ${job.message}`)
  await cronService.stop()
}

export async function cronRemove(id: string): Promise<void> {
  await cronService.start()
  const removed = await cronService.remove(id)
  if (removed) {
    console.log(`✅ Removed cron job: ${id}`)
  } else {
    console.log(`❌ Cron job not found: ${id}`)
  }
  await cronService.stop()
}

export async function cronList(): Promise<void> {
  await cronService.start()
  const jobs = cronService.list()

  if (jobs.length === 0) {
    console.log('No cron jobs configured.')
    await cronService.stop()
    return
  }

  console.log('Cron Jobs:')
  console.log('─'.repeat(60))
  for (const job of jobs) {
    const status = job.enabled ? '✅' : '⏸️'
    const lastRun = job.lastRun ? new Date(job.lastRun).toISOString() : 'never'
    console.log(`${status} ${job.id}  ${job.schedule.padEnd(15)}  ${job.message.slice(0, 30)}`)
    console.log(`   Last run: ${lastRun}`)
  }
  await cronService.stop()
}
