// Infrastructure: Environment configuration
// 从 ~/.mini-claw/config.json 读取配置
import { getConfigManager } from '../config/config-manager.js'

function loadConfig() {
  const cm = getConfigManager()
  if (!cm.exists()) {
    return null
  }
  const cfg = cm.load()
  const provider = cm.getDefaultProvider()
  return {
    apiKey: provider?.apiKey || '',
    baseUrl: provider?.baseUrl || '',
    model: provider?.models[0] || '',
    format: provider?.format || 'openai',
    port: cfg.gateway.port,
    telegram: cfg.telegram?.botToken || '',
    telegramAllowFrom: cfg.telegram?.allowFrom || [],
    composio: cfg.composio?.apiKey || '',
  }
}

const config = loadConfig()

export const env = {
  LLM_API_KEY: config?.apiKey || '',
  LLM_BASE_URL: config?.baseUrl || 'https://api.openai.com/v1',
  LLM_MODEL: config?.model || 'gpt-4o',
  LLM_FORMAT: (config?.format || 'openai') as 'openai' | 'claude',
  GATEWAY_PORT: config?.port || 18789,
  COMPOSIO_API_KEY: config?.composio || '',
  TELEGRAM_BOT_TOKEN: config?.telegram || '',
  TELEGRAM_ALLOW_FROM: config?.telegramAllowFrom || [] as string[],
}

export function validateEnv(): void {
  if (!env.LLM_API_KEY) {
    console.error('Error: No LLM provider configured.')
    console.error('')
    console.error('Run the following to set up:')
    console.error('  mini-claw config init')
    console.error('')
    console.error('Config location: ~/.mini-claw/config.json')
    process.exit(1)
  }
}
