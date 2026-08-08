import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { chmod, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { ensureDir, skillsDir } from '../config/paths'

const TMP_DIR = path.join(skillsDir, '.tmp')
const MAX_SKILL_BYTES = 5_000_000

export interface SkillInstallResult {
  name: string
  dir: string
  source: string
}

export async function installSkill(source: string): Promise<SkillInstallResult> {
  await ensureDir(skillsDir)

  if (isGitHubUrl(source)) {
    return installFromGitHub(source)
  }

  if (isNpmPackage(source)) {
    return installFromNpm(source)
  }

  return installFromLocal(source)
}

function isGitHubUrl(input: string): boolean {
  try {
    const url = new URL(input)
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'github.com' || url.hostname === 'www.github.com')
    )
  } catch {
    return false
  }
}

function isNpmPackage(input: string): boolean {
  return npmSkillName(input) !== null
}

async function installFromGitHub(url: string): Promise<SkillInstallResult> {
  const { owner, repo, subdir, branch } = parseGitHubUrl(url)
  const name = safeSkillName(subdir ? path.posix.basename(subdir) : repo)
  const skillDir = safeChildPath(skillsDir, name)
  const tmpDir = safeChildPath(TMP_DIR, `${name}-${randomUUID()}`)

  try {
    mkdirSync(tmpDir, { recursive: true })

    const cloneUrl = `https://github.com/${owner}/${repo}.git`
    const gitArgs = ['clone', '--depth', '1']
    if (branch) gitArgs.push('--branch', branch)
    gitArgs.push(cloneUrl, tmpDir)

    execFileSync('git', gitArgs, { stdio: 'ignore' })

    const skillFile = subdir
      ? safeChildPath(tmpDir, ...subdir.split('/'), 'SKILL.md')
      : safeChildPath(tmpDir, 'SKILL.md')
    const body = readSkillFile(skillFile, tmpDir, subdir || repo)
    removeExistingSkillDir(skillDir)
    await writeSkillFile(skillDir, body)

    return { name, dir: skillDir, source: url }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

async function installFromNpm(packageName: string): Promise<SkillInstallResult> {
  const parsedName = npmSkillName(packageName)
  if (!parsedName) throw new Error(`Invalid npm package name: ${packageName}`)
  const name = safeSkillName(parsedName)
  const skillDir = safeChildPath(skillsDir, name)
  const tmpDir = safeChildPath(TMP_DIR, `${name}-${randomUUID()}`)

  try {
    mkdirSync(tmpDir, { recursive: true })

    
    execFileSync('npm', ['pack', packageName, '--prefix', tmpDir], {
      stdio: 'ignore',
    })

    const files = readdirSync(tmpDir)
    const tarball = files.find((f) => f.endsWith('.tgz'))
    if (!tarball) {
      throw new Error(`Could not download npm package "${packageName}"`)
    }

    const tarballPath = path.join(tmpDir, tarball)
    validateTarball(tarballPath)
    const extractDir = path.join(tmpDir, 'extracted')
    mkdirSync(extractDir, { recursive: true })

    try {
      execFileSync('tar', ['-xzf', tarballPath, '-C', extractDir], { stdio: 'ignore' })
    } catch {
      
      const packageDir = path.join(tmpDir, 'node_modules', packageName)
      if (existsSync(packageDir)) {
        const skillFile = path.join(packageDir, 'SKILL.md')
        if (existsSync(skillFile)) {
          const body = readSkillFile(skillFile, packageDir, packageName)
          await writeSkillFile(skillDir, body)
          return { name, dir: skillDir, source: packageName }
        }
      }
      throw new Error('Could not extract the npm package. Is `tar` available?')
    }

    
    const extractedFiles = readdirSync(extractDir)
    const packageRoot = extractedFiles.find((f) => f === 'package')
    if (!packageRoot) throw new Error('Could not find package root in extracted files')

    const skillFile = path.join(extractDir, 'package', 'SKILL.md')
    if (!existsSync(skillFile)) {
      throw new Error(`No SKILL.md found in npm package "${packageName}"`)
    }

    const body = readSkillFile(skillFile, extractDir, packageName)
    await writeSkillFile(skillDir, body)

    return { name, dir: skillDir, source: packageName }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

function npmSkillName(input: string): string | null {
  if (input.includes('\\') || input.startsWith('.')) return null
  const scoped = input.match(/^@[\w.-]+\/([\w.-]+)(?:@[\w.*+-]+)?$/)
  if (scoped) return scoped[1] ?? null
  const unscoped = input.match(/^([\w.-]+)(?:@[\w.*+-]+)?$/)
  return unscoped?.[1] ?? null
}

function validateTarball(file: string): void {
  const info = lstatSync(file, { throwIfNoEntry: false })
  if (!info?.isFile() || info.size > 20_000_000) {
    throw new Error('The npm skill archive is missing or exceeds the 20 MB safety limit.')
  }
  const listing = execFileSync('tar', ['-tzf', file], {
    encoding: 'utf8',
    maxBuffer: 2_000_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const entries = listing.split(/\r?\n/).filter(Boolean)
  if (entries.length === 0 || entries.length > 10_000) {
    throw new Error('The npm skill archive has an invalid number of entries.')
  }
  for (const entry of entries) {
    const normalized = entry.replace(/^\.\//, '')
    if (
      normalized.includes('\\') ||
      path.posix.isAbsolute(normalized) ||
      normalized.split('/').some((segment) => segment === '..')
    ) {
      throw new Error(`Unsafe path in npm skill archive: ${entry}`)
    }
  }
}

async function installFromLocal(srcPath: string): Promise<SkillInstallResult> {
  const resolved = path.resolve(srcPath)

  let skillDir: string
  let skillFile: string

  const directSkill = path.join(resolved, 'SKILL.md')
  if (existsSync(directSkill)) {
    skillDir = resolved
    skillFile = directSkill
  } else if (resolved.endsWith('SKILL.md') && existsSync(resolved)) {
    skillDir = path.dirname(resolved)
    skillFile = resolved
  } else {
    throw new Error(`No SKILL.md found at "${srcPath}"`)
  }

  const name = path.basename(skillDir)
  const destDir = safeChildPath(skillsDir, safeSkillName(name))
  const body = readSkillFile(skillFile, skillDir, srcPath)

  await writeSkillFile(destDir, body)

  return { name, dir: destDir, source: resolved }
}

async function writeSkillFile(dir: string, body: string): Promise<void> {
  assertInside(skillsDir, dir)
  const existingDir = lstatSync(dir, { throwIfNoEntry: false })
  if (existingDir?.isSymbolicLink()) {
    throw new Error(`Refusing to replace symlinked skill directory: ${dir}`)
  }
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, 'SKILL.md')
  const existingFile = lstatSync(file, { throwIfNoEntry: false })
  if (existingFile?.isSymbolicLink()) {
    throw new Error(`Refusing to replace symlinked skill file: ${file}`)
  }
  writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 })
  await chmod(file, 0o600)
}

export function parseGitHubUrl(url: string): {
  owner: string
  repo: string
  subdir?: string
  branch?: string
} {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Cannot parse GitHub URL: ${url}`)
  }
  if (
    parsed.protocol !== 'https:' ||
    (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error('GitHub skills must use an https://github.com URL without credentials.')
  }

  let segments: string[]
  try {
    segments = parsed.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment))
  } catch {
    throw new Error(`Cannot parse GitHub URL: ${url}`)
  }
  if (segments.length < 2) throw new Error(`Cannot parse GitHub URL: ${url}`)

  const owner = safeGitHubSegment(segments[0] as string, 'owner')
  const repo = safeSkillName((segments[1] as string).replace(/\.git$/i, ''))
  if (segments.length === 2) return { owner, repo }
  if (segments[2] !== 'tree' || segments.length < 4) {
    throw new Error(`Unsupported GitHub skill URL: ${url}`)
  }

  const branch = safeGitHubSegment(segments[3] as string, 'branch')
  const subdirSegments = segments.slice(4).map((segment) => safeGitHubSegment(segment, 'path'))
  return {
    owner,
    repo,
    branch,
    subdir: subdirSegments.length > 0 ? subdirSegments.join('/') : undefined,
  }
}

function safeGitHubSegment(value: string, kind: string): string {
  if (
    value === '' ||
    value === '.' ||
    value === '..' ||
    value.length > 255 ||
    /[\0-\x1f\x7f/\\:*?"<>|#%]/.test(value)
  ) {
    throw new Error(`Unsafe GitHub ${kind}: ${value || '(empty)'}`)
  }
  return value
}

function safeSkillName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value === '.' || value === '..') {
    throw new Error(`Unsafe skill name: ${value || '(empty)'}`)
  }
  return value
}

function safeChildPath(root: string, ...segments: string[]): string {
  const target = path.resolve(root, ...segments)
  assertInside(root, target)
  return target
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  ) {
    return
  }
  throw new Error(`Path escapes the skills directory: ${target}`)
}

function readSkillFile(file: string, allowedRoot: string, source: string): string {
  const info = lstatSync(file, { throwIfNoEntry: false })
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new Error(`No regular SKILL.md found in "${source}"`)
  }
  if (info.size > MAX_SKILL_BYTES) {
    throw new Error(`SKILL.md in "${source}" exceeds the ${MAX_SKILL_BYTES / 1_000_000} MB limit`)
  }
  const root = realpathSync(allowedRoot)
  const resolved = realpathSync(file)
  assertInside(root, resolved)
  return readFileSync(resolved, 'utf8')
}

function removeExistingSkillDir(dir: string): void {
  const info = lstatSync(dir, { throwIfNoEntry: false })
  if (!info) return
  if (info.isSymbolicLink()) {
    throw new Error(`Refusing to remove symlinked skill directory: ${dir}`)
  }
  rmSync(dir, { recursive: true, force: true })
}
