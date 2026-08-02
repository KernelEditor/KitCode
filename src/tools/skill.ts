import type { SkillMeta } from '../skills/library'
import { loadSkill } from '../skills/library'
import { brief } from './summary'
import type { Tool } from './types'

const MAX_BODY_CHARS = 64_000

interface SkillInput {
  name: string
}

export function createSkillTool(skills: SkillMeta[]): Tool {
  const byName = new Map(skills.map((skill) => [skill.name, skill]))

  return {
    name: 'skill',
    description:
      'Load the full instructions for one of the skills listed in the system prompt, then follow them. Call this before starting a task that a skill covers.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Name of the skill to load' } },
      required: ['name'],
      additionalProperties: false,
    },
    defaultPermission: 'allow',
    summarize(input) {
      return `skill(${brief((input as SkillInput).name)})`
    },
    async execute(input) {
      const name = String((input as SkillInput).name ?? '').trim()
      const meta = byName.get(name)
      if (!meta) return { content: unknownSkill(name, [...byName.keys()]), isError: true }

      let body: string
      try {
        body = (await loadSkill(meta)).body
      } catch (error) {
        return { content: `Could not read skill ${name} from ${meta.file}: ${error}`, isError: true }
      }

      const content =
        body.length > MAX_BODY_CHARS
          ? `${body.slice(0, MAX_BODY_CHARS)}\n\n... truncated: skill ${name} is ${body.length} characters, only the first ${MAX_BODY_CHARS} are shown. Read ${meta.file} directly for the rest.`
          : body
      return { content, display: { kind: 'text', text: `skill ${name}` } }
    },
  }
}

function unknownSkill(name: string, available: string[]): string {
  if (available.length === 0) return `No skills are installed, so "${name}" cannot be loaded.`
  return `No skill named "${name}". Available skills: ${available.join(', ')}.`
}
