// Subagent Spawn Tool: creates and runs background subagent
import { randomUUID } from 'crypto'
import type { Tool, ToolContext } from './types.js'
import { getSubagentRegistry, buildSubagentSystemPrompt, runAnnounceFlow } from '../subagent/index.js'
import { AgentRunner } from '../runner.js'
import { getSessionManager } from '../../sessions/index.js'
import { getAgentManager } from '../manager.js'
import { getProviderManager } from '../../config/provider-manager.js'
import { createLogger } from '../../infra/logger.js'

const log = createLogger('tool:subagent_spawn')

// Track spawned subagents
const pendingSubagents = new Map<string, {
  runId: string
  task: string
  label?: string
  childSessionKey: string
}>()

export const subagentSpawnTool: Tool = {
  name: 'subagent_spawn',
  description: `Spawn a background sub-agent to handle a task independently. The subagent runs in parallel and announces its result back when complete.

WHEN TO USE:
- User requests multiple independent tasks (e.g., "search A, B, C" → spawn 3 subagents)
- User wants parallel/background processing ("后台", "并行", "parallel", "background")
- Long-running tasks that shouldn't block the conversation
- Any task that can be delegated and doesn't need immediate inline response

HOW TO USE:
- Call this tool ONCE per independent task
- For "search topics A, B, C", call subagent_spawn 3 times with different tasks
- Results will be pushed back to the user automatically when each subagent completes

Note: Subagents cannot spawn other subagents (no nesting).`,
  inputSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'The task for the subagent to perform (required)',
      },
      label: {
        type: 'string',
        description: 'Optional label to identify this subagent run',
      },
      cleanup: {
        type: 'string',
        description: 'Whether to delete or keep the session after completion (default: delete)',
      },
    },
    required: ['task'],
  },

  async execute(input: Record<string, unknown>, context?: ToolContext): Promise<string> {
    const task = input.task as string
    const label = input.label as string | undefined
    const cleanup = (input.cleanup as 'delete' | 'keep') || 'delete'

    if (!task?.trim()) {
      return JSON.stringify({ status: 'error', error: 'Task is required' })
    }

    try {
      const registry = getSubagentRegistry()
      const sm = getSessionManager()
      const am = getAgentManager()
      const pm = getProviderManager()

      const runId = randomUUID()
      const childSessionKey = `subagent:${runId}`
      const requesterSessionKey = context?.sessionKey || 'unknown'
      const requesterChannel = context?.channel || 'websocket'

      // Create child session
      sm.createSession(childSessionKey, 'default', label || `Subagent: ${task.slice(0, 30)}...`)

      // Build subagent system prompt
      const extraSystemPrompt = buildSubagentSystemPrompt({
        requesterSessionKey,
        childSessionKey,
        task,
        label,
      })

      // Register the run
      registry.register({
        runId,
        childSessionKey,
        requesterSessionKey,
        task,
        label,
        cleanup,
      })

      pendingSubagents.set(runId, { runId, task, label, childSessionKey })

      // Resolve LLM config from default agent
      const defaultAgent = am.getDefaultAgent()
      let llmConfig = undefined
      if (defaultAgent?.model) {
        const provider = pm.getProviderByModel(defaultAgent.model)
        if (provider) {
          llmConfig = {
            apiKey: provider.apiKey,
            baseUrl: provider.baseUrl,
            model: defaultAgent.model,
            format: provider.format,
          }
        }
      }

      // Create subagent runner
      const runner = new AgentRunner({
        agentConfig: defaultAgent || undefined,
        llmConfig,
        isSubagent: true,
        extraSystemPrompt,
      })
      await runner.loadSkills()

      // Bind to child session
      const childSession = sm.findBySessionKey(childSessionKey)
      if (childSession) {
        runner.bindSession(childSession.sessionId)
      }

      log.info(`Spawned subagent: ${runId} for task: ${task.slice(0, 80)}`)

      // Run in background (fire and forget, with error logging)
      runSubagentInBackground(runner, runId, task, label, childSessionKey, requesterSessionKey, requesterChannel, cleanup)
        .catch((err) => log.error(`[subagent:${runId}] Unhandled error in background run:`, err))

      return JSON.stringify({
        status: 'accepted',
        childSessionKey,
        runId,
        message: `Subagent spawned and running in background. It will work on: "${task.slice(0, 80)}${task.length > 80 ? '...' : ''}"`,
      })
    } catch (err) {
      log.error('Failed to spawn subagent:', err)
      return JSON.stringify({ status: 'error', error: (err as Error).message })
    }
  },
}

/** Run the subagent in the background and announce results when done */
async function runSubagentInBackground(
  runner: AgentRunner,
  runId: string,
  task: string,
  label: string | undefined,
  childSessionKey: string,
  requesterSessionKey: string,
  requesterChannel: string,
  cleanup: 'delete' | 'keep',
): Promise<void> {
  const registry = getSubagentRegistry()
  const startedAt = Date.now()

  log.info(`[subagent:${runId}] Starting background run, will announce to ${requesterChannel}:${requesterSessionKey}`)

  try {
    registry.markStarted(runId)

    // Run the agent with the task as user message
    const result = await runner.run(task, {
      onToolCall: (name) => {
        log.info(`[subagent:${runId}] Tool call: ${name}`)
      },
    })

    const endedAt = Date.now()
    registry.markCompleted(runId, { status: 'ok' })

    log.info(`[subagent:${runId}] Completed in ${((endedAt - startedAt) / 1000).toFixed(1)}s`)

    // Use announce flow to trigger main agent with results
    const didAnnounce = await runAnnounceFlow({
      childSessionKey,
      childRunId: runId,
      requesterSessionKey,
      requesterChannel,
      task,
      label,
      startedAt,
      endedAt,
      outcome: { status: 'ok' },
      cleanup,
    })

    if (didAnnounce) {
      log.info(`[subagent:${runId}] Announce flow triggered for ${requesterSessionKey}`)
    } else {
      log.warn(`[subagent:${runId}] Announce flow failed`)
    }
  } catch (err) {
    const endedAt = Date.now()
    log.error(`[subagent:${runId}] Failed:`, err)
    registry.markCompleted(runId, { status: 'error', error: (err as Error).message })

    // Announce error via announce flow
    await runAnnounceFlow({
      childSessionKey,
      childRunId: runId,
      requesterSessionKey,
      requesterChannel,
      task,
      label,
      startedAt,
      endedAt,
      outcome: { status: 'error', error: (err as Error).message },
      cleanup,
    })
  } finally {
    pendingSubagents.delete(runId)
    registry.finalizeCleanup(runId, true)
  }
}

/** Get pending subagents for listing */
export function getPendingSubagents(): Array<{
  runId: string
  task: string
  label?: string
  childSessionKey: string
}> {
  return [...pendingSubagents.values()]
}

/** Clear a pending subagent after completion */
export function clearPendingSubagent(runId: string): void {
  pendingSubagents.delete(runId)
}
