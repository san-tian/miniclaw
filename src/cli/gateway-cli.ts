// CLI: Gateway command
import { Gateway } from '../gateway/server.js'
import { validateEnv } from '../infra/env.js'
import { createLogger } from '../infra/logger.js'

const log = createLogger('cli')

export async function runGateway(): Promise<void> {
  validateEnv()

  const gateway = new Gateway()
  let isShuttingDown = false

  // Handle shutdown
  const shutdown = async () => {
    if (isShuttingDown) {
      log.info('Force exit...')
      process.exit(1)
    }
    isShuttingDown = true
    log.info('Shutting down...')

    // Set a timeout to force exit if graceful shutdown takes too long
    const forceExitTimeout = setTimeout(() => {
      log.warn('Graceful shutdown timed out, forcing exit...')
      process.exit(1)
    }, 5000)

    try {
      await gateway.stop()
      clearTimeout(forceExitTimeout)
      process.exit(0)
    } catch (err) {
      log.error('Error during shutdown:', err)
      clearTimeout(forceExitTimeout)
      process.exit(1)
    }
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await gateway.start()

  log.info('Gateway is running. Press Ctrl+C to stop.')
}
