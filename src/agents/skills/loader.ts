// Skill Loader: Load skills from skills/<name>/SKILL.md
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import type { Skill } from './types.js'
import { createLogger } from '../../infra/logger.js'

const log = createLogger('skills')

/**
 * Parse YAML frontmatter from markdown content.
 * Returns { frontmatter, body } where frontmatter is the parsed YAML object.
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) {
    return { frontmatter: {}, body: content }
  }

  const yamlStr = match[1]
  const body = match[2]

  // Simple YAML parser for basic key: value pairs
  const frontmatter: Record<string, unknown> = {}
  for (const line of yamlStr.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    let value = line.slice(colonIdx + 1).trim()
    // Remove surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key) frontmatter[key] = value
  }

  return { frontmatter, body }
}

export async function loadSkills(skillsDir: string): Promise<Skill[]> {
  const skills: Skill[] = []

  if (!existsSync(skillsDir)) {
    log.warn(`Skills directory not found: ${skillsDir}`)
    return skills
  }

  try {
    const entries = await readdir(skillsDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const skillPath = join(skillsDir, entry.name, 'SKILL.md')
      if (!existsSync(skillPath)) {
        log.warn(`No SKILL.md found in ${entry.name}`)
        continue
      }

      try {
        const content = await readFile(skillPath, 'utf-8')
        const { frontmatter, body } = parseFrontmatter(content)

        const name = (frontmatter.name as string) || entry.name
        const description = (frontmatter.description as string) || `Skill for ${name}`
        const keywords = (frontmatter.keywords as string) || undefined

        skills.push({
          name,
          description,
          keywords,
          prompt: body.trim(),
          path: skillPath,
        })
        log.info(`Loaded skill: ${name}`)
      } catch (err) {
        log.error(`Failed to load skill ${entry.name}:`, err)
      }
    }
  } catch (err) {
    log.error('Failed to read skills directory:', err)
  }

  return skills
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Build skills prompt in XML format for system prompt injection.
 * Agent should use the `skill` tool to load a skill when the task matches its description.
 */
export function buildSkillsPrompt(skills: Skill[]): string {
  if (skills.length === 0) return ''

  const lines = [
    '',
    '',
    '<available_skills>',
  ]

  for (const skill of skills) {
    lines.push('  <skill>')
    lines.push(`    <name>${escapeXml(skill.name)}</name>`)
    lines.push(`    <description>${escapeXml(skill.description)}</description>`)
    if (skill.keywords) {
      lines.push(`    <keywords>${escapeXml(skill.keywords)}</keywords>`)
    }
    lines.push('  </skill>')
  }

  lines.push('</available_skills>')
  return lines.join('\n')
}

/**
 * Get a skill by name.
 */
export function getSkillByName(skills: Skill[], name: string): Skill | undefined {
  return skills.find((s) => s.name === name)
}
