// CLI: Agent command - Interactive CLI client
import WebSocket from 'ws'
import * as readline from 'readline'
import { env } from '../infra/env.js'
import { createLogger } from '../infra/logger.js'

const log = createLogger('agent-cli')

export async function runAgent(): Promise<void> {
  const url = `ws://localhost:${env.GATEWAY_PORT}`
  log.info(`Connecting to ${url}...`)

  const ws = new WebSocket(url)
  let sessionKey = ''
  let currentLine = ''

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  ws.on('open', () => {
    log.info('Connected to Gateway')
  })

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())

      switch (msg.type) {
        case 'connected':
          sessionKey = msg.sessionKey
          console.log(`\n🔗 Connected (session: ${sessionKey.slice(0, 8)}...)`)
          prompt()
          break

        case 'chunk':
          // Clear current line and print chunk
          if (currentLine === '') {
            process.stdout.write('\n🤖 ')
          }
          process.stdout.write(msg.text)
          currentLine += msg.text
          break

        case 'tool_call':
          console.log(`\n🔧 Tool: ${msg.name}`)
          if (msg.input?.command) {
            console.log(`   $ ${msg.input.command}`)
          }
          break

        case 'tool_result':
          console.log(`   → ${msg.output.slice(0, 100)}${msg.output.length > 100 ? '...' : ''}`)
          break

        case 'reply':
          if (currentLine === '' && msg.text) {
            console.log(`\n🤖 ${msg.text}`)
          }
          currentLine = ''
          console.log('')
          prompt()
          break
      }
    } catch (e) {
      log.error('Failed to parse message:', e)
    }
  })

  ws.on('close', () => {
    console.log('\n❌ Disconnected from Gateway')
    rl.close()
    process.exit(0)
  })

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message)
    process.exit(1)
  })

  function prompt() {
    rl.question('> ', (input) => {
      const text = input.trim()
      if (!text) {
        prompt()
        return
      }

      if (text === '/quit' || text === '/exit') {
        ws.close()
        return
      }

      if (text === '/clear') {
        console.clear()
        prompt()
        return
      }

      ws.send(JSON.stringify({ type: 'message', text }))
    })
  }
}
