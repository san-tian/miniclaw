// Subagent Announce: handles result notification and main agent re-triggering
import { getSessionManager } from '../../sessions/index.js'
import { getGatewayRef } from '../../gateway/gateway-ref.js'
import { createLogger } from '../../infra/logger.js'
import type { SubagentRunRecord } from './types.js'

const log = createLogger('subagent-announce')

// ============ Types ============

export interface AnnounceParams {
  childSessionKey: string
  childRunId: string
  requesterSessionKey: string
  requesterChannel: string
  task: string
  label?: string
  startedAt?: number
  endedAt?: number
  outcome?: { status: string; error?: string }
  cleanup: 'delete' | 'keep'
}

export interface AnnounceResult {
  success: boolean
  method?: 'steered' | 'invoked' | 'collected'
  error?: string
}

// ============ Collect Queue ============
// Aggregates multiple subagent completions into a single trigger message

interface QueuedAnnounce {
  params: AnnounceParams
  findings: string
  enqueuedAt: number
}

interface AnnounceQueue {
  items: QueuedAnnounce[]
  debounceTimer: NodeJS.Timeout | null
  draining: boolean
}

const ANNOUNCE_QUEUES = new Map<string, AnnounceQueue>()
const DEBOUNCE_MS = 2000 // Wait 2s for more results before draining

function getOrCreateQueue(sessionKey: string): AnnounceQueue {
  let queue = ANNOUNCE_QUEUES.get(sessionKey)
  if (!queue) {
    queue = { items: [], debounceTimer: null, draining: false }
    ANNOUNCE_QUEUES.set(sessionKey, queue)
  }
  return queue
}

// ============ Helpers ============

/** Build the subagent system prompt */
export function buildSubagentSystemPrompt(params: {
  requesterSessionKey: string
  childSessionKey: string
  task: string
  label?: string
}): string {
  return `# Subagent Context

You are a **subagent** spawned by the main agent for a specific task.

## Your Role
- You were created to handle: ${params.task}
- Complete this task. That's your entire purpose.
- You are NOT the main agent. Don't try to be.

## Rules
1. **Stay focused** - Do your assigned task, nothing else
2. **Complete the task** - Your final message will be reported to the main agent
3. **Don't initiate** - No heartbeats, no proactive actions
4. **Be ephemeral** - You may be terminated after completion

## Session Context
- Label: ${params.label || '(none)'}
- Requester: ${params.requesterSessionKey}
- Your session: ${params.childSessionKey}
`
}

/** Get the last assistant message from a session */
function getLastAssistantMessage(sessionKey: string): string | null {
  const sm = getSessionManager()
  const session = sm.findBySessionKey(sessionKey)
  if (!session) return null

  const messages = sm.loadTranscript(session.sessionId)
  const assistantMessages = messages.filter((m) => m.role === 'assistant')
  if (assistantMessages.length === 0) return null

  return assistantMessages[assistantMessages.length - 1].content
}

/** Format duration in human readable form */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return `${minutes}m${remainingSeconds}s`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h${remainingMinutes}m`
}

/** Build the raw announce message (for display only) */
export function buildAnnounceMessage(params: AnnounceParams): string {
  const lastReply = getLastAssistantMessage(params.childSessionKey)
  const duration = params.endedAt && params.startedAt
    ? formatDuration(params.endedAt - params.startedAt)
    : 'unknown'

  const statusEmoji = params.outcome?.status === 'ok' ? '✅' : '❌'
  const labelText = params.label ? ` "${params.label}"` : ''

  let message = `${statusEmoji} Background task${labelText} completed.\n\n`

  if (params.outcome?.status === 'error') {
    message += `**Error:** ${params.outcome.error || 'Unknown error'}\n\n`
  }

  if (lastReply) {
    message += `**Findings:**\n${lastReply}\n\n`
  }

  message += `**Duration:** ${duration}\n`
  message += `**Task:** ${params.task}`

  return message
}

/** Build the trigger message for main agent (with summarize instructions) */
function buildTriggerMessage(params: AnnounceParams, findings: string): string {
  const duration = params.endedAt && params.startedAt
    ? formatDuration(params.endedAt - params.startedAt)
    : 'unknown'

  const statusLabel =
    params.outcome?.status === 'ok'
      ? 'completed successfully'
      : params.outcome?.status === 'error'
        ? `failed: ${params.outcome.error || 'unknown error'}`
        : 'finished with unknown status'

  const taskLabel = params.label || params.task.slice(0, 50)

  return [
    `A background task "${taskLabel}" just ${statusLabel}.`,
    '',
    'Findings:',
    findings || '(no output)',
    '',
    `Duration: ${duration}`,
    '',
    'Summarize this naturally for the user. Keep it brief (1-2 sentences).',
    'Flow it into the conversation naturally.',
    'Do not mention technical details like duration or that this was a background task.',
    'You can respond with NO_REPLY if no announcement is needed.',
  ].join('\n')
}

/** Build a collected trigger message for multiple subagent results */
function buildCollectedTriggerMessage(items: QueuedAnnounce[]): string {
  const blocks: string[] = [
    `[${items.length} background tasks completed]`,
    '',
    'Below are the results from multiple parallel tasks. Summarize them together for the user.',
    'Keep it concise and natural. Do not list them mechanically.',
    '',
  ]

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const taskLabel = item.params.label || item.params.task.slice(0, 50)
    const statusLabel = item.params.outcome?.status === 'ok' ? 'completed' : 'failed'
    blocks.push(`--- Task ${i + 1}: "${taskLabel}" (${statusLabel}) ---`)
    blocks.push(item.findings || '(no output)')
    blocks.push('')
  }

  blocks.push('Summarize all findings together in a natural, conversational way.')
  blocks.push('If user asked for a comparison table, create one.')

  return blocks.join('\n')
}

// ============ Main Announce Flow ============

/** Enqueue an announce and schedule drain */
function enqueueAnnounce(params: AnnounceParams, findings: string): void {
  const queue = getOrCreateQueue(params.requesterSessionKey)

  queue.items.push({
    params,
    findings,
    enqueuedAt: Date.now(),
  })

  log.info(`Enqueued announce for ${params.requesterSessionKey}, queue size: ${queue.items.length}`)

  // Reset debounce timer
  if (queue.debounceTimer) {
    clearTimeout(queue.debounceTimer)
  }

  queue.debounceTimer = setTimeout(() => {
    drainQueue(params.requesterSessionKey, params.requesterChannel)
  }, DEBOUNCE_MS)
}

/** Drain the queue - send collected or individual messages */
async function drainQueue(sessionKey: string, channel: string): Promise<void> {
  const queue = ANNOUNCE_QUEUES.get(sessionKey)
  if (!queue || queue.draining || queue.items.length === 0) return

  queue.draining = true
  queue.debounceTimer = null

  try {
    const gatewayRef = getGatewayRef()
    if (!gatewayRef) {
      log.error('No gateway ref, cannot drain announce queue')
      return
    }

    if (queue.items.length === 1) {
      // Single item - send individual trigger
      const item = queue.items.shift()!
      const triggerMsg = buildTriggerMessage(item.params, item.findings)
      const result = await gatewayRef.triggerAgent(sessionKey, channel, triggerMsg)
      log.info(`Announce drain: single item, result=${result}`)
    } else {
      // Multiple items - collect into one message
      const items = queue.items.splice(0, queue.items.length)
      const collectedMsg = buildCollectedTriggerMessage(items)
      const result = await gatewayRef.triggerAgent(sessionKey, channel, collectedMsg)
      log.info(`Announce drain: collected ${items.length} items, result=${result}`)
    }
  } catch (err) {
    log.error('Failed to drain announce queue:', err)
  } finally {
    queue.draining = false
    if (queue.items.length === 0) {
      ANNOUNCE_QUEUES.delete(sessionKey)
    }
  }
}

/** Run the announce flow - enqueues for collection, then triggers main agent */
export async function runAnnounceFlow(params: AnnounceParams): Promise<boolean> {
  try {
    const findings = getLastAssistantMessage(params.childSessionKey) || ''
    log.info(`Running announce flow for ${params.childRunId} → ${params.requesterSessionKey}`)

    // Enqueue for potential collection with other concurrent subagents
    enqueueAnnounce(params, findings)

    return true
  } catch (err) {
    log.error('Failed to run announce flow:', err)
    return false
  }
}
