// Web Fetch Tool: Fetch and extract content from URLs
import type { Tool } from './types.js'

const DEFAULT_MAX_CHARS = 50000
const DEFAULT_TIMEOUT_MS = 30000
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

// Simple in-memory cache
const cache = new Map<string, { data: unknown; expiresAt: number }>()
const CACHE_TTL_MS = 15 * 60 * 1000 // 15 minutes

function getCached<T>(key: string): T | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    cache.delete(key)
    return null
  }
  return entry.data as T
}

function setCache(key: string, data: unknown): void {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS })
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/gi, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, ''))
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function htmlToMarkdown(html: string): { text: string; title?: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? normalizeWhitespace(stripTags(titleMatch[1])) : undefined

  let text = html
    // Remove script, style, noscript
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')

  // Convert links
  text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, body) => {
    const label = normalizeWhitespace(stripTags(body))
    if (!label) return href
    return `[${label}](${href})`
  })

  // Convert headings
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, body) => {
    const prefix = '#'.repeat(Math.max(1, Math.min(6, parseInt(level, 10))))
    const label = normalizeWhitespace(stripTags(body))
    return `\n${prefix} ${label}\n`
  })

  // Convert list items
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, body) => {
    const label = normalizeWhitespace(stripTags(body))
    return label ? `\n- ${label}` : ''
  })

  // Convert line breaks and block elements
  text = text
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|table|tr|ul|ol)>/gi, '\n')

  // Strip remaining tags
  text = stripTags(text)
  text = normalizeWhitespace(text)

  return { text, title }
}

function markdownToText(markdown: string): string {
  let text = markdown
  // Remove images
  text = text.replace(/!\[[^\]]*]\([^)]+\)/g, '')
  // Convert links to just text
  text = text.replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
  // Remove code blocks
  text = text.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/```[^\n]*\n?/g, '').replace(/```/g, '')
  )
  // Remove inline code
  text = text.replace(/`([^`]+)`/g, '$1')
  // Remove heading markers
  text = text.replace(/^#{1,6}\s+/gm, '')
  // Remove list markers
  text = text.replace(/^\s*[-*+]\s+/gm, '')
  text = text.replace(/^\s*\d+\.\s+/gm, '')
  return normalizeWhitespace(text)
}

function truncateText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false }
  }
  return { text: value.slice(0, maxChars) + '...', truncated: true }
}

export const webFetchTool: Tool = {
  name: 'web_fetch',
  description: `Fetch and extract readable content from a URL. Converts HTML to markdown or plain text.

Use this tool to:
- Read web pages and articles
- Extract content from documentation
- Get information from websites

PARAMETERS:
- url: The HTTP/HTTPS URL to fetch (required)
- extractMode: "markdown" (default) or "text"
- maxChars: Maximum characters to return (default: 50000)

EXAMPLES:
- Fetch a page: { "url": "https://example.com" }
- Get plain text: { "url": "https://example.com", "extractMode": "text" }
- Limit output: { "url": "https://example.com", "maxChars": 10000 }`,

  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The HTTP/HTTPS URL to fetch',
      },
      extractMode: {
        type: 'string',
        description: 'Extraction mode: "markdown" (default) or "text"',
      },
      maxChars: {
        type: 'string',
        description: 'Maximum characters to return (default: 50000)',
      },
    },
    required: ['url'],
  },

  async execute(input: Record<string, unknown>): Promise<string> {
    const url = input.url as string
    const extractMode = (input.extractMode as string) || 'markdown'
    const maxChars = parseInt(String(input.maxChars || DEFAULT_MAX_CHARS), 10)

    if (!url) {
      return 'Error: url is required'
    }

    // Validate URL
    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      return 'Error: Invalid URL format'
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return 'Error: URL must be http or https'
    }

    // Check cache
    const cacheKey = `fetch:${url}:${extractMode}:${maxChars}`
    const cached = getCached<string>(cacheKey)
    if (cached) {
      return cached
    }

    const start = Date.now()

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

      const response = await fetch(url, {
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: controller.signal,
        redirect: 'follow',
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        return `Error: HTTP ${response.status} ${response.statusText}`
      }

      const contentType = response.headers.get('content-type') || ''
      const body = await response.text()
      const tookMs = Date.now() - start

      let title: string | undefined
      let text: string

      if (contentType.includes('text/html')) {
        const result = htmlToMarkdown(body)
        title = result.title
        text = extractMode === 'text' ? markdownToText(result.text) : result.text
      } else if (contentType.includes('application/json')) {
        try {
          text = JSON.stringify(JSON.parse(body), null, 2)
        } catch {
          text = body
        }
      } else {
        text = body
      }

      const truncated = truncateText(text, maxChars)

      const output = [
        `URL: ${url}`,
        title ? `Title: ${title}` : null,
        `Content-Type: ${contentType.split(';')[0]}`,
        `Length: ${truncated.text.length} chars${truncated.truncated ? ' (truncated)' : ''}`,
        `Fetched in: ${tookMs}ms`,
        '',
        '--- Content ---',
        truncated.text,
      ]
        .filter((line) => line !== null)
        .join('\n')

      setCache(cacheKey, output)
      return output
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        return `Error: Request timed out after ${DEFAULT_TIMEOUT_MS / 1000}s`
      }
      return `Error: ${(err as Error).message}`
    }
  },
}
