// Composio Tools Integration: Web Search, GitHub
import { ComposioToolSet } from 'composio-core'
import type { Tool } from './types.js'
import { createLogger } from '../../infra/logger.js'
import { env } from '../../infra/env.js'

const log = createLogger('composio')

let composioToolSet: ComposioToolSet | null = null

function getComposioToolSet(): ComposioToolSet {
  if (!composioToolSet) {
    const apiKey = env.COMPOSIO_API_KEY
    if (!apiKey) {
      throw new Error('COMPOSIO_API_KEY is required for Composio tools')
    }
    composioToolSet = new ComposioToolSet({ apiKey, entityId: 'default' })
  }
  return composioToolSet
}

// ========== Web Search Tool (Google via Composio) ==========
export const webSearchTool: Tool = {
  name: 'web_search',
  description: `Search the web using Google to get real-time, up-to-date information.

WHEN TO USE THIS TOOL (use proactively):
- Questions about current events, news, or recent developments
- Questions about specific facts, statistics, or data you're unsure about
- Questions about prices, availability, or real-time information
- Questions about people, companies, products, or places
- Questions about technical documentation, APIs, or software versions
- When the user asks "what is", "who is", "how to", "where can I find"
- When you need to verify or supplement your knowledge
- When the user explicitly asks to search or look something up
- When the topic might have changed since your training data

IMPORTANT: Prefer searching over guessing. If you're not 100% certain about factual information, search first.

AFTER SEARCHING:
- If the search result snippets contain enough information to answer the question, use them directly.
- If the snippets are insufficient or you need more details, use the 'web_fetch' tool to read the full content of the most relevant URL(s).
- For technical documentation, tutorials, or detailed articles, always consider fetching the full page.

PARAMETERS:
- query: The search query (required) - be specific and include relevant keywords
- num_results: Number of results to return (default: 5, max: 10)`,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query - be specific and include relevant keywords' },
      num_results: { type: 'string', description: 'Number of results (default: 5)' },
    },
    required: ['query'],
  },
  async execute(input) {
    const { query, num_results = '5' } = input as { query: string; num_results?: string }
    const numResults = Math.min(10, Math.max(1, parseInt(num_results, 10) || 5))

    try {
      const toolSet = getComposioToolSet()
      const result = await toolSet.executeAction({
        actionName: 'COMPOSIO_SEARCH_SEARCH',
        params: { query, num_results: numResults },
      })

      // Format the results for better readability
      if (result && typeof result === 'object' && 'data' in result) {
        const data = result.data as { results?: Array<{ title?: string; url?: string; snippet?: string }> }
        if (data.results && Array.isArray(data.results)) {
          const formatted = data.results.map((r, i) =>
            `${i + 1}. ${r.title || 'No title'}\n   URL: ${r.url || 'No URL'}\n   ${r.snippet || ''}`
          ).join('\n\n')
          return `Search results for "${query}":\n\n${formatted}`
        }
      }

      return JSON.stringify(result, null, 2)
    } catch (error) {
      log.error('Web search failed:', error)
      return `Search failed: ${(error as Error).message}`
    }
  },
}

// Export all Composio tools
export const composioTools: Tool[] = [
  webSearchTool,
]

// Get Composio tools (async for future dynamic loading)
export async function getComposioTools(): Promise<Tool[]> {
  return composioTools
}

// Check if Composio is configured
export function isComposioConfigured(): boolean {
  return !!env.COMPOSIO_API_KEY
}
