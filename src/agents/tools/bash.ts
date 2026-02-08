// Bash Tool: Execute shell commands
import { spawn } from 'child_process'
import type { Tool } from './types.js'

export const bashTool: Tool = {
  name: 'bash',
  description: 'Execute a shell command and return the output. Use this for running system commands, scripts, or any terminal operations.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute',
      },
    },
    required: ['command'],
  },

  async execute(input: Record<string, unknown>): Promise<string> {
    const command = input.command as string
    if (!command) {
      return 'Error: command is required'
    }

    return new Promise((resolve) => {
      const proc = spawn('bash', ['-c', command], {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data) => {
        stdout += data.toString()
      })

      proc.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout || '(no output)')
        } else {
          resolve(`Exit code: ${code}\nstdout: ${stdout}\nstderr: ${stderr}`)
        }
      })

      proc.on('error', (err) => {
        resolve(`Error: ${err.message}`)
      })
    })
  },
}
