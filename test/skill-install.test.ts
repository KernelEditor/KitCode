import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

const home = await mkdtemp(join(tmpdir(), 'kitcode-skill-home-'))
process.env.KITCODE_HOME = home
const { installSkill, npmSkillName, parseGitHubUrl, uninstallSkill } = await import('../src/skills/install')
const { discoverSkills } = await import('../src/skills/library')
const skillsDir = join(home, 'skills')

let source: string

beforeEach(async () => {
  source = await mkdtemp(join(tmpdir(), 'kitcode-skill-src-'))
  await rm(skillsDir, { recursive: true, force: true })
})

afterAll(async () => {
  delete process.env.KITCODE_HOME
  await rm(home, { recursive: true, force: true })
})

async function skill(dir: string, frontmatter: string, extra: Record<string, string> = {}) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\nBody.\n`)
  for (const [file, text] of Object.entries(extra)) {
    await mkdir(join(dir, file, '..'), { recursive: true })
    await writeFile(join(dir, file), text)
  }
}

describe('installSkill', () => {
  it('copies the whole skill folder, not only SKILL.md', async () => {
    await skill(join(source, 'pdf'), 'name: pdf-tools\ndescription: "PDF work"', {
      'scripts/fill.py': 'print(1)',
      'reference/forms.md': '# forms',
    })
    const result = await installSkill(join(source, 'pdf'))

    expect(result.name).toBe('pdf-tools')
    expect(await readFile(join(skillsDir, 'pdf-tools', 'scripts', 'fill.py'), 'utf8')).toBe('print(1)')
    expect(existsSync(join(skillsDir, 'pdf-tools', 'reference', 'forms.md'))).toBe(true)
    const [found] = await discoverSkills([skillsDir])
    expect(found).toMatchObject({ name: 'pdf-tools', description: 'PDF work' })
  })

  it('finds the single skill below a repository root', async () => {
    await skill(join(source, 'skills', 'deploy'), 'name: deploy')
    const result = await installSkill(source)
    expect(result.name).toBe('deploy')
  })

  it('lists the skills of a collection instead of guessing', async () => {
    await skill(join(source, 'skills', 'one'), 'name: one')
    await skill(join(source, 'skills', 'two'), 'name: two')
    await expect(installSkill(source)).rejects.toThrow(/contains 2 skills[\s\S]*skills\/one[\s\S]*skills\/two/)
  })

  it('replaces an older install and can remove it', async () => {
    await skill(join(source, 'lint'), 'name: lint', { 'old.txt': 'old' })
    await installSkill(join(source, 'lint'))
    await rm(join(source, 'lint', 'old.txt'))
    await installSkill(join(source, 'lint'))
    expect(existsSync(join(skillsDir, 'lint', 'old.txt'))).toBe(false)

    await uninstallSkill('lint')
    expect(existsSync(join(skillsDir, 'lint'))).toBe(false)
    await expect(uninstallSkill('lint')).rejects.toThrow(/No installed skill/)
    await expect(uninstallSkill('../escape')).rejects.toThrow(/Unsafe skill name/)
  })

  it('clones GitHub without a credential prompt and reports git errors', async () => {
    await skill(join(source, 'skills', 'review'), 'name: review')
    const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = []
    const result = await installSkill(
      'https://github.com/acme/tools/tree/main/skills/review',
      async (command, args, options) => {
        expect(command).toBe('git')
        calls.push({ args, env: options.env })
        await cp(source, args.at(-1) as string, { recursive: true })
      },
    )
    expect(result.name).toBe('review')
    expect(calls[0]?.args).toContain('--branch')
    expect(calls[0]?.env?.GIT_TERMINAL_PROMPT).toBe('0')

    await expect(
      installSkill('https://github.com/acme/private', async () => {
        throw new Error('Repository not found.')
      }),
    ).rejects.toThrow('Could not clone acme/private: Repository not found.')
  })
})

describe('skill sources', () => {
  it('understands a GitHub link to SKILL.md itself', () => {
    expect(parseGitHubUrl('https://github.com/acme/tools/blob/main/skills/review/SKILL.md')).toEqual({
      owner: 'acme',
      repo: 'tools',
      branch: 'main',
      subdir: 'skills/review',
    })
  })

  it('never passes something npm would read as an option', () => {
    expect(npmSkillName('--global')).toBeNull()
    expect(npmSkillName('-g')).toBeNull()
    expect(npmSkillName('@scope/-x')).toBeNull()
    expect(npmSkillName('@scope/pdf-skill@1.2.0')).toBe('pdf-skill')
    expect(() => parseGitHubUrl('https://github.com/acme/tools/tree/--upload-pack=x')).toThrow(/Unsafe/)
  })
})
