// Infrastructure: Logger
const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

function timestamp(): string {
  return new Date().toISOString().slice(11, 23)
}

function formatPrefix(level: LogLevel, component: string): string {
  const levelColors: Record<LogLevel, string> = {
    debug: colors.dim,
    info: colors.cyan,
    warn: colors.yellow,
    error: colors.red,
  }
  return `${colors.dim}${timestamp()}${colors.reset} ${levelColors[level]}[${component}]${colors.reset}`
}

export function createLogger(component: string) {
  return {
    debug: (...args: unknown[]) => console.log(formatPrefix('debug', component), ...args),
    info: (...args: unknown[]) => console.log(formatPrefix('info', component), ...args),
    warn: (...args: unknown[]) => console.warn(formatPrefix('warn', component), ...args),
    error: (...args: unknown[]) => console.error(formatPrefix('error', component), ...args),
  }
}

export const log = createLogger('mini-claw')
