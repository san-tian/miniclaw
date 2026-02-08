// Tool Registry: Export all tools
import type { Tool } from './types.js'
import { bashTool } from './bash.js'
import { readTool } from './read.js'
import { writeTool } from './write.js'
import { cronTool } from './cron.js'
import { webFetchTool } from './web-fetch.js'
import { subagentSpawnTool } from './subagent-spawn.js'
import { telegramSendTool } from './telegram-send.js'
import { sessionSendTool } from './session-send.js'
import { skillTool } from './skill.js'
import { getComposioTools } from './composio.js'
import { env } from '../../infra/env.js'

// Built-in tools
const builtinTools: Tool[] = [bashTool, readTool, writeTool, cronTool, webFetchTool, subagentSpawnTool, telegramSendTool, sessionSendTool, skillTool]

// Tools that subagents cannot use (prevent nesting)
const SUBAGENT_DENIED_TOOLS = new Set(['subagent_spawn'])

// Composio tools (loaded dynamically)
let composioTools: Tool[] = []

export async function initTools(): Promise<void> {
  if (env.COMPOSIO_API_KEY) {
    try {
      composioTools = await getComposioTools()
      console.log(`Loaded ${composioTools.length} Composio tools`)
    } catch (e) {
      console.warn('Failed to load Composio tools:', e)
    }
  }
}

export const tools: Tool[] = builtinTools

export function getAllTools(options?: { isSubagent?: boolean }): Tool[] {
  let allTools = [...builtinTools, ...composioTools]

  // Filter out denied tools for subagents
  if (options?.isSubagent) {
    allTools = allTools.filter((t) => !SUBAGENT_DENIED_TOOLS.has(t.name))
  }

  return allTools
}

export function getToolByName(name: string): Tool | undefined {
  return getAllTools().find((t) => t.name === name)
}

export function getToolSchemas(options?: { isSubagent?: boolean }) {
  return getAllTools(options).map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }))
}

export { type Tool, type ToolCall, type ToolResult } from './types.js'
