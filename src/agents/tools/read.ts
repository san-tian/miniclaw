// Read Tool: Read file contents
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import type { Tool } from './types.js'

export const readTool: Tool = {
  name: 'read',
  description: 'Read the contents of a file. Returns the file content as text.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path to the file to read',
      },
    },
    required: ['path'],
  },

  async execute(input: Record<string, unknown>): Promise<string> {
    const path = input.path as string
    if (!path) {
      return 'Error: path is required'
    }

    if (!existsSync(path)) {
      return `Error: File not found: ${path}`
    }

    try {
      const content = await readFile(path, 'utf-8')
      return content || '(empty file)'
    } catch (err) {
      return `Error reading file: ${(err as Error).message}`
    }
  },
}
