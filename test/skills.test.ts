import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { discoverSkills, formatSkillCatalogue, loadSkill } from '../src/skills/library'
import { createSkillTool } from '../src/tools/skill'
import type { ToolContext } from '../src/tools/types'

const isWindows = process.platform === 'win32'

const io = vi.hoisted(() => ({ bytes: 0 }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async readFile(...args: Parameters<typeof actual.readFile>) {
      const data = await actual.readFile(...args)
      io.bytes += data.length
      return data
    },
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args)
      const read = handle.read.bind(handle)
      return Object.assign(handle, {
        async read(buffer: Buffer, offset: number, length: number, position: number) {
          const result = await read(buffer, offset, length, position)
          io.bytes += result.bytesRead
          return result
        },
      })
    },
  }
})

let root: string
let projectRoot: string
let globalRoot: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kitcode-skills-'))
  projectRoot = join(root, 'project')
  globalRoot = join(root, 'global')
  await mkdir(projectRoot, { recursive: true })
  await mkdir(globalRoot, { recursive: true })
  io.bytes = 0
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeSkill(skillsRoot: string, dir: string, text: string): Promise<string> {
  const target = join(skillsRoot, dir)
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'SKILL.md'), text)
  return target
}

function context(): ToolContext {
  return { cwd: root, signal: new AbortController().signal, confirm: async () => true }
}

const pdfForms = ['---', 'name: pdf-forms', 'description: Fill and flatten PDF forms', '---', '', 'Run pdftk.', ''].join(
  '\n',
)

describe('discoverSkills', () => {
  it('finds a skill in each root', async () => {
    await writeSkill(projectRoot, 'pdf-forms', pdfForms)
    await writeSkill(globalRoot, 'excel', '---\nname: excel\ndescription: Edit spreadsheets\n---\n\nUse openpyxl.\n')

    const skills = await discoverSkills([projectRoot, globalRoot])
    expect(skills.map((skill) => skill.name)).toEqual(['excel', 'pdf-forms'])
    expect(skills.map((skill) => skill.description)).toEqual(['Edit spreadsheets', 'Fill and flatten PDF forms'])
  })

  it('lets an earlier root shadow a later one', async () => {
    const local = await writeSkill(projectRoot, 'pdf-forms', '---\nname: pdf-forms\ndescription: local\n---\n\nlocal\n')
    const global = await writeSkill(
      globalRoot,
      'pdf-forms',
      '---\nname: pdf-forms\ndescription: global\n---\n\nglobal\n',
    )

    const skills = await discoverSkills([projectRoot, globalRoot])
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ description: 'local', dir: local })
    expect((await loadSkill(skills[0])).body).toBe('local')

    const reversed = await discoverSkills([globalRoot, projectRoot])
    expect(reversed[0]).toMatchObject({ description: 'global', dir: global })
  })

  it('skips a directory without SKILL.md and a loose file', async () => {
    await mkdir(join(projectRoot, 'notes'), { recursive: true })
    await writeFile(join(projectRoot, 'notes', 'readme.md'), 'nothing here')
    await writeFile(join(projectRoot, 'loose.md'), 'nothing here either')
    await writeSkill(projectRoot, 'pdf-forms', pdfForms)

    expect((await discoverSkills([projectRoot])).map((skill) => skill.name)).toEqual(['pdf-forms'])
  })

  it('treats a missing root as empty without hiding later roots', async () => {
    await writeSkill(globalRoot, 'excel', '---\nname: excel\n---\n\nUse openpyxl.\n')

    expect(await discoverSkills([join(root, 'nope')])).toEqual([])
    expect((await discoverSkills([join(root, 'nope'), globalRoot])).map((skill) => skill.name)).toEqual(['excel'])
  })

  it('falls back to the directory name and an empty description', async () => {
    await writeSkill(projectRoot, 'bare', 'Just a body, no frontmatter.\n')

    const [skill] = await discoverSkills([projectRoot])
    expect(skill).toMatchObject({ name: 'bare', description: '' })
    expect((await loadSkill(skill)).body).toBe('Just a body, no frontmatter.')
  })

  it('does not read the body during discovery', async () => {
    const marker = 'MARKER_THAT_MUST_NOT_BE_LOADED'
    await writeSkill(projectRoot, 'huge', `---\nname: huge\ndescription: big\n---\n\n${marker}\n${'x'.repeat(4_000_000)}\n`)

    io.bytes = 0
    const skills = await discoverSkills([projectRoot])
    const discoveryBytes = io.bytes

    expect(discoveryBytes).toBeLessThan(16_384)
    expect(Object.keys(skills[0]).sort()).toEqual(['description', 'dir', 'file', 'name'])
    expect(JSON.stringify(skills)).not.toContain(marker)
    expect((await loadSkill(skills[0])).body).toContain(marker)
    expect(io.bytes).toBeGreaterThan(4_000_000)
  })

  it('rejects a symlinked skill directory that escapes its root', async () => {
    if (isWindows) return 
    const real = await writeSkill(globalRoot, 'excel', '---\nname: excel\ndescription: Edit spreadsheets\n---\n\nUse openpyxl.\n')
    await symlink(real, join(projectRoot, 'excel-link'))

    const skills = await discoverSkills([projectRoot])
    expect(skills).toEqual([])
  })

  it('rejects a SKILL.md symlink to a sensitive file', async () => {
    if (isWindows) return
    const secret = join(root, '.env')
    const skillDir = join(projectRoot, 'leak')
    await writeFile(secret, 'API_KEY=TOP_SECRET_CONTENT')
    await mkdir(skillDir, { recursive: true })
    await symlink(secret, join(skillDir, 'SKILL.md'))

    expect(await discoverSkills([projectRoot])).toEqual([])
  })

  it('survives a SKILL.md that is a directory and a symlink loop', async () => {
    if (isWindows) return 
    await mkdir(join(projectRoot, 'weird', 'SKILL.md'), { recursive: true })
    await symlink(join(projectRoot, 'loop'), join(projectRoot, 'loop'))
    await writeSkill(projectRoot, 'pdf-forms', pdfForms)

    expect((await discoverSkills([projectRoot])).map((skill) => skill.name)).toEqual(['pdf-forms'])
  })
})

describe('frontmatter', () => {
  it('handles CRLF, a body rule of its own and no trailing newline', async () => {
    await writeSkill(
      projectRoot,
      'crlf',
      '---\r\nname: crlf\r\ndescription: CRLF frontmatter\r\n---\r\n\r\nStep one\r\n---\r\nStep two',
    )

    const [skill] = await discoverSkills([projectRoot])
    expect(skill).toMatchObject({ name: 'crlf', description: 'CRLF frontmatter' })
    const { body } = await loadSkill(skill)
    expect(body).toContain('Step one')
    expect(body).toContain('---')
    expect(body).toContain('Step two')
  })

  it('handles a leading byte order mark', async () => {
    await writeSkill(projectRoot, 'bom', '﻿---\nname: bom\ndescription: after a BOM\n---\n\nBOM body')

    const [skill] = await discoverSkills([projectRoot])
    expect(skill).toMatchObject({ name: 'bom', description: 'after a BOM' })
    expect((await loadSkill(skill)).body).toBe('BOM body')
  })
})

describe('formatSkillCatalogue', () => {
  it('is empty without skills and one line per skill otherwise', async () => {
    expect(formatSkillCatalogue([])).toBe('')

    await writeSkill(projectRoot, 'pdf-forms', pdfForms)
    const catalogue = formatSkillCatalogue(await discoverSkills([projectRoot]))
    expect(catalogue).toContain('- pdf-forms — Fill and flatten PDF forms')
    expect(catalogue).not.toContain('pdftk')
  })
})

describe('skill tool', () => {
  it('returns the body of a known skill', async () => {
    await writeSkill(projectRoot, 'pdf-forms', pdfForms)
    const tool = createSkillTool(await discoverSkills([projectRoot]))

    const result = await tool.execute({ name: 'pdf-forms' }, context())
    expect(result.isError).toBeUndefined()
    expect(result.content).toBe('Run pdftk.')
    expect(tool.summarize({ name: 'pdf-forms' })).toBe('skill(pdf-forms)')
  })

  it('reports an unknown name with the available ones', async () => {
    await writeSkill(projectRoot, 'pdf-forms', pdfForms)
    const tool = createSkillTool(await discoverSkills([projectRoot]))

    const result = await tool.execute({ name: 'excel' }, context())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('pdf-forms')
  })

  it('cannot be steered into reading a file outside the skill list', async () => {
    const secret = join(root, 'secret.md')
    await writeFile(secret, 'TOP_SECRET_CONTENT')
    await writeSkill(projectRoot, 'pdf-forms', pdfForms)
    const tool = createSkillTool(await discoverSkills([projectRoot]))

    const names = ['../../../../etc/passwd', '/etc/passwd', secret, '../secret.md', 'pdf-forms/../../secret.md']
    for (const name of names) {
      const result = await tool.execute({ name }, context())
      expect(result.isError).toBe(true)
      expect(result.content).not.toContain('TOP_SECRET_CONTENT')
      expect(result.content).not.toContain('root:')
    }
  })

  it('stays sane with no skills installed', async () => {
    const tool = createSkillTool([])
    const result = await tool.execute({ name: 'pdf-forms' }, context())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('No skills are installed')
  })

  it('truncates a very long body', async () => {
    await writeSkill(projectRoot, 'long', `---\nname: long\n---\n\n${'y'.repeat(200_000)}\n`)
    const tool = createSkillTool(await discoverSkills([projectRoot]))

    const result = await tool.execute({ name: 'long' }, context())
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('truncated')
    expect(result.content.length).toBeLessThan(70_000)
  })
})
