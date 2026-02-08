// CLI: Telegram mock command - Send messages via mock Telegram
import WebSocket from 'ws'
import { env } from '../infra/env.js'
import { createLogger } from '../infra/logger.js'

const log = createLogger('telegram-cli')

export async function sendTelegramMessage(message: string): Promise<void> {
  // Connect to gateway and send message as if from Telegram
  const url = `ws://localhost:${env.GATEWAY_PORT}`

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let done = false

    ws.on('open', () => {
      log.info('Connected to Gateway')
      // Send message with telegram channel indicator
      ws.send(JSON.stringify({
        type: 'message',
        text: `[From Telegram] ${message}`,
      }))
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'reply') {
          console.log(`\n📱 Telegram Reply:\n${msg.text}\n`)
          done = true
          ws.close()
        } else if (msg.type === 'chunk') {
          process.stdout.write(msg.text)
        } else if (msg.type === 'tool_call') {
          console.log(`\n🔧 Tool: ${msg.name}`)
        }
      } catch (e) {
        // ignore
      }
    })

    ws.on('close', () => {
      if (done) {
        resolve()
      } else {
        reject(new Error('Connection closed before reply'))
      }
    })

    ws.on('error', (err) => {
      reject(err)
    })

    // Timeout after 60 seconds
    setTimeout(() => {
      if (!done) {
        ws.close()
        reject(new Error('Timeout waiting for reply'))
      }
    }, 60000)
  })
}
