// Gateway Reference: allows tools to send messages back through the gateway
import { createLogger } from '../infra/logger.js'

const log = createLogger('gateway-ref')

export interface GatewayRef {
  /** Send a message to a session via its channel (display only, no agent re-trigger) */
  sendToSession(sessionKey: string, channel: string, text: string): Promise<void>
  /** Trigger the main agent with a message - steer if active, or invoke fresh if idle */
  triggerAgent(sessionKey: string, channel: string, message: string): Promise<'steered' | 'invoked' | 'failed'>
}

let ref: GatewayRef | null = null

export function setGatewayRef(gateway: GatewayRef): void {
  ref = gateway
}

export function getGatewayRef(): GatewayRef | null {
  return ref
}
