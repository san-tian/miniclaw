// Skill Tool: List and load skills
import type { Tool } from './types.js'
import { loadSkills, getSkillByName } from '../skills/loader.js'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const skillsDir = resolve(__dirname, '../../../skills')

export const skillTool: Tool = {
  name: 'skill',
  description:
    "Load specialized skill instructions for specific tasks. " +
    "IMPORTANT: When the user's request matches a skill in <available_skills> (e.g., GitHub/gh/issue/PR tasks match 'github' skill), " +
    "you MUST call this tool with action='load' and the skill name BEFORE doing anything else. " +
    "Use action='list' to see all available skills.",
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: "'load' to load a skill's instructions (use this first!), 'list' to see all skills",
      },
      name: {
        type: 'string',
        description: "The skill name to load (required when action='load')",
      },
    },
    required: ['action'],
  },

  async execute(input: Record<string, unknown>): Promise<string> {
    const action = input.action as string
    const skills = await loadSkills(skillsDir)

    if (action === 'list') {
      if (skills.length === 0) {
        return 'No skills available.'
      }
      const lines = skills.map((s) => `- **${s.name}**: ${s.description}`)
      return `Available skills (${skills.length}):\n\n${lines.join('\n')}`
    }

    if (action === 'load') {
      const name = input.name as string
      if (!name) {
        return "Error: 'name' is required when action='load'"
      }
      const skill = getSkillByName(skills, name)
      if (!skill) {
        const available = skills.map((s) => s.name).join(', ')
        return `Error: Skill '${name}' not found. Available skills: ${available}`
      }
      return `# Skill: ${skill.name}\n\n${skill.prompt}`
    }

    return `Error: Unknown action '${action}'. Use 'list' or 'load'.`
  },
}
