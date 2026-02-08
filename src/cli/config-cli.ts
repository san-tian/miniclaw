// CLI commands for configuration management
import { getConfigManager, getConfigPath, getConfigDir } from '../config/config-manager.js'
import * as readline from 'readline'

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim())
    })
  })
}

export async function configInit(): Promise<void> {
  const cm = getConfigManager()

  console.log('\n🦀 Mini-Claw Configuration Setup\n')
  console.log(`Config location: ${getConfigPath()}\n`)

  if (cm.exists()) {
    const overwrite = await question('Config already exists. Overwrite? (y/N): ')
    if (overwrite.toLowerCase() !== 'y') {
      console.log('Aborted.')
      rl.close()
      return
    }
  }

  console.log('Let\'s set up your first LLM provider.\n')

  // Provider name
  const name = await question('Provider name (e.g., OpenAI, Claude, Local): ') || 'Default Provider'

  // Base URL
  console.log('\nCommon base URLs:')
  console.log('  1. OpenAI:     https://api.openai.com/v1')
  console.log('  2. Claude:     https://api.anthropic.com')
  console.log('  3. Local:      http://localhost:11434/v1')
  const baseUrl = await question('\nBase URL: ') || 'https://api.openai.com/v1'

  // API Key
  const apiKey = await question('API Key: ')
  if (!apiKey) {
    console.error('\nError: API Key is required.')
    rl.close()
    process.exit(1)
  }

  // Format
  const formatChoice = await question('Format (1=OpenAI, 2=Claude) [1]: ') || '1'
  const format = formatChoice === '2' ? 'claude' : 'openai'

  // Models
  const defaultModels = format === 'claude' ? 'claude-sonnet-4-20250514' : 'gpt-4o'
  const modelsInput = await question(`Models (comma-separated) [${defaultModels}]: `) || defaultModels
  const models = modelsInput.split(',').map(m => m.trim()).filter(m => m)

  // Gateway port
  const portInput = await question('Gateway port [18789]: ') || '18789'
  const port = parseInt(portInput, 10)

  // Create config
  const config = cm.init({
    provider: { name, baseUrl, apiKey, format, models }
  })
  config.gateway.port = port
  cm.save(config)

  console.log('\n✅ Configuration saved!')
  console.log(`   Location: ${getConfigPath()}`)
  console.log(`   Provider: ${name}`)
  console.log(`   Models:   ${models.join(', ')}`)
  console.log('\nRun `mini-claw gateway` to start the server.')

  rl.close()
}

export function configShow(): void {
  const cm = getConfigManager()

  if (!cm.exists()) {
    console.log('\nNo configuration found.')
    console.log(`Run 'mini-claw config init' to create one.`)
    console.log(`Expected location: ${getConfigPath()}`)
    return
  }

  const config = cm.load()

  console.log('\n🦀 Mini-Claw Configuration\n')
  console.log(`Location: ${getConfigPath()}`)
  console.log('─'.repeat(50))

  console.log('\n[Gateway]')
  console.log(`  Port: ${config.gateway.port}`)
  console.log(`  Host: ${config.gateway.host}`)

  console.log('\n[Providers]')
  const providers = cm.getProviders()
  if (providers.length === 0) {
    console.log('  No providers configured.')
  } else {
    for (const p of providers) {
      const defaultMark = p.isDefault ? ' (default)' : ''
      console.log(`  ${p.name}${defaultMark}`)
      console.log(`    ID:      ${p.id}`)
      console.log(`    URL:     ${p.baseUrl}`)
      console.log(`    Format:  ${p.format}`)
      console.log(`    Models:  ${p.models.join(', ')}`)
      console.log(`    API Key: ***${p.apiKey.slice(-4)}`)
      console.log('')
    }
  }

  if (config.telegram?.botToken) {
    console.log('[Telegram]')
    console.log(`  Bot Token: ***${config.telegram.botToken.slice(-4)}`)
  }
}

export function configPath(): void {
  console.log(getConfigPath())
}

export function configDir(): void {
  console.log(getConfigDir())
}
