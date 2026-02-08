// Cron Tool: Manage cron jobs via AI
import type { Tool } from './types.js'
import { getCronService } from '../../cron/singleton.js'

const ACTIONS = ['list', 'add', 'remove', 'enable', 'disable', 'get'] as const
type Action = (typeof ACTIONS)[number]

export const cronTool: Tool = {
  name: 'cron',
  description: `Manage cron scheduled tasks. Use this tool to create, list, and manage recurring tasks.

ACTIONS:
- list: List all cron jobs
- add: Create a new cron job (requires schedule and message)
- remove: Delete a cron job (requires jobId)
- enable: Enable a disabled job (requires jobId)
- disable: Disable a job without deleting (requires jobId)
- get: Get details of a specific job (requires jobId)

SCHEDULE FORMAT (cron expression):
- "* * * * *" = every minute
- "*/5 * * * *" = every 5 minutes
- "0 * * * *" = every hour
- "0 9 * * *" = every day at 9:00 AM
- "0 9 * * 1" = every Monday at 9:00 AM
- "0 0 1 * *" = first day of every month
Fields: minute hour day-of-month month day-of-week

NATURAL LANGUAGE MAPPING:
"每分钟" → "* * * * *", "每5分钟" → "*/5 * * * *", "每小时" → "0 * * * *", "每天9点" → "0 9 * * *", "每周一" → "0 9 * * 1"

HOW CRON JOBS WORK:
Each cron job runs in its own isolated session with a fresh agent. The "message" field is the instruction the agent will execute when triggered.

DELIVERY - The cron agent has two send tools:
- telegram_send: Send results to Telegram (default)
- session_send: Send results to a Web UI session

CRITICAL - MESSAGE FIELD RULES:
- The message MUST reflect the user's ACTUAL request. Do NOT copy from examples - write the message based on what the user asked for.
- The message should include a delivery instruction so the cron agent knows how to send results.
- If the user wants Telegram delivery (or doesn't specify), append "用 telegram_send 发送给用户" to the message.
- If the user wants Web UI delivery, append "用 session_send 发送到 web 会话" to the message.

EXAMPLES:
- User: "每5分钟提醒我喝水" → { "action": "add", "schedule": "*/5 * * * *", "message": "提醒用户喝水，用 telegram_send 发送给用户" }
- User: "每天早上8点发一句论语" → { "action": "add", "schedule": "0 8 * * *", "message": "随机选一句《论语》语录，用 telegram_send 发送给用户" }
- User: "每小时检查服务器状态" → { "action": "add", "schedule": "0 * * * *", "message": "检查服务器运行状态，用 telegram_send 发送给用户" }
- List jobs: { "action": "list" }
- Remove job: { "action": "remove", "jobId": "abc123" }`,

  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'The action to perform: list, add, remove, enable, disable, get',
      },
      schedule: {
        type: 'string',
        description: 'Cron expression for scheduling (required for add)',
      },
      message: {
        type: 'string',
        description: 'Instruction for the agent to execute when job triggers. Include telegram_send instructions if results should be sent to Telegram.',
      },
      jobId: {
        type: 'string',
        description: 'Job ID (required for remove, enable, disable, get)',
      },
    },
    required: ['action'],
  },

  async execute(input: Record<string, unknown>): Promise<string> {
    const action = input.action as Action
    const cronService = getCronService()

    if (!cronService) {
      return 'Error: Cron service not available. Make sure Gateway is running.'
    }

    if (!ACTIONS.includes(action)) {
      return `Error: Invalid action "${action}". Valid actions: ${ACTIONS.join(', ')}`
    }

    switch (action) {
      case 'list': {
        const jobs = cronService.list()
        if (jobs.length === 0) {
          return 'No cron jobs configured.'
        }
        const lines = jobs.map((job) => {
          const status = job.enabled ? '✓' : '✗'
          const lastRun = job.lastRun ? new Date(job.lastRun).toISOString() : 'never'
          const target = job.channel ? `${job.channel}:${job.to || 'default'}` : 'websocket'
          return `[${status}] ${job.id}: "${job.schedule}" → "${job.message}" (target: ${target}, last: ${lastRun})`
        })
        return `Cron jobs (${jobs.length}):\n${lines.join('\n')}`
      }

      case 'add': {
        const schedule = input.schedule as string
        const message = input.message as string

        if (!schedule) {
          return 'Error: schedule is required for add action'
        }
        if (!message) {
          return 'Error: message is required for add action'
        }

        try {
          const job = await cronService.add(schedule, message)
          return `Created cron job:\n  ID: ${job.id}\n  Schedule: ${job.schedule}\n  Message: ${job.message}`
        } catch (err) {
          return `Error creating job: ${(err as Error).message}`
        }
      }

      case 'remove': {
        const jobId = input.jobId as string
        if (!jobId) {
          return 'Error: jobId is required for remove action'
        }

        const removed = await cronService.remove(jobId)
        if (removed) {
          return `Removed cron job: ${jobId}`
        }
        return `Error: Job not found: ${jobId}`
      }

      case 'enable': {
        const jobId = input.jobId as string
        if (!jobId) {
          return 'Error: jobId is required for enable action'
        }

        const enabled = await cronService.enable(jobId)
        if (enabled) {
          return `Enabled cron job: ${jobId}`
        }
        return `Error: Job not found: ${jobId}`
      }

      case 'disable': {
        const jobId = input.jobId as string
        if (!jobId) {
          return 'Error: jobId is required for disable action'
        }

        const disabled = await cronService.disable(jobId)
        if (disabled) {
          return `Disabled cron job: ${jobId}`
        }
        return `Error: Job not found: ${jobId}`
      }

      case 'get': {
        const jobId = input.jobId as string
        if (!jobId) {
          return 'Error: jobId is required for get action'
        }

        const jobs = cronService.list()
        const job = jobs.find((j) => j.id === jobId)
        if (!job) {
          return `Error: Job not found: ${jobId}`
        }

        const target = job.channel ? `${job.channel}:${job.to || 'default'}` : 'websocket'
        return `Cron job details:
  ID: ${job.id}
  Schedule: ${job.schedule}
  Message: ${job.message}
  Target: ${target}
  Enabled: ${job.enabled}
  Created: ${new Date(job.createdAt).toISOString()}
  Last run: ${job.lastRun ? new Date(job.lastRun).toISOString() : 'never'}`
      }

      default:
        return `Error: Unknown action: ${action}`
    }
  },
}
