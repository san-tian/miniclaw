// Write Tool: Write content to a file
import { writeFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import type { Tool } from './types.js'

export const writeTool: Tool = {
  name: 'write',
  description: 'Write content to a file. Creates the file if it does not exist, or overwrites if it does.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path to the file to write',
      },
      content: {
        type: 'string',
        description: 'The content to write to the file',
      },
    },
    required: ['path', 'content'],
  },

  async execute(input: Record<string, unknown>): Promise<string> {
    const path = input.path as string
    const content = input.content as string

    if (!path) {
      return 'Error: path is required'
    }
    if (content === undefined) {
      return 'Error: content is required'
    }

    try {
      // Ensure directory exists
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, 'utf-8')
      return `Successfully wrote ${content.length} bytes to ${path}`
    } catch (err) {
      return `Error writing file: ${(err as Error).message}`
    }
  },
}
