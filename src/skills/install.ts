import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { ensureDir, skillsDir } from '../config/paths'

const TMP_DIR = path.join(skillsDir, '.tmp')
const SKILL_FILE = 'SKILL.md'
const MAX_SKILL_BYTES = 5_000_000
const MAX_ARCHIVE_BYTES = 20_000_000
// A skill is SKILL.md plus whatever it references (scripts, templates,
// reference docs). These bound what one install may copy.
const MAX_SKILL_FILES = 1_000
const MAX_SKILL_TOTAL_BYTES = 50_000_000
const MAX_SEARCH_DEPTH = 4
const COMMAND_TIMEOUT_MS = 120_000
const SKIPPED_DIRS = new Set(['.git', 'node_modules'])

export interface SkillInstallResult {
  name: string
  dir: string
  source: string
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) => Promise<void>

export async function installSkill(
  source: string,
  run: CommandRunner = runCommand,
): Promise<SkillInstallResult> {
  const trimmed = source.trim()
  if (!trimmed) throw new Error('Give a skill source: a GitHub URL, an npm package or a local path.')
  await ensureDir(skillsDir)

  if (isGitHubUrl(trimmed)) return installFromGitHub(trimmed, run)
  // A bare folder name like "my-skill" also parses as an npm package name;
  // an existing local path wins so it is never fetched from the registry.
  if (npmSkillName(trimmed) && !existsSync(path.resolve(trimmed))) {
    return installFromNpm(trimmed, run)
  }
  return installFromLocal(trimmed)
}

export async function uninstallSkill(name: string): Promise<string> {
  const dir = safeChildPath(skillsDir, safeSkillName(name))
  const info = await lstat(dir).catch(() => null)
  if (!info) throw new Error(`No installed skill named "${name}" in ${skillsDir}`)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Refusing to remove ${dir}: it is not a plain skill directory.`)
  }
  await rm(dir, { recursive: true, force: true })
  return dir
}

async function installFromGitHub(url: string, run: CommandRunner): Promise<SkillInstallResult> {
  const { owner, repo, subdir, branch } = parseGitHubUrl(url)
  return withTempDir(async (tmp) => {
    const checkout = path.join(tmp, 'r')
    // core.longpaths: on Windows a deep repository under ~/.kitcode/skills/.tmp
    // passes the 260-character limit and the checkout fails half-way.
    const args = ['-c', 'core.longpaths=true', 'clone', '--depth', '1', '--single-branch']
    if (branch) args.push('--branch', branch)
    args.push(`https://github.com/${owner}/${repo}.git`, checkout)
    try {
      // No credential prompt: a private or mistyped repo must fail, not wait
      // forever for a username on a terminal the TUI owns.
      await run('git', args, { cwd: tmp, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    } catch (error) {
      throw new Error(`Could not clone ${owner}/${repo}${branch ? ` (${branch})` : ''}: ${messageOf(error)}`)
    }
    const start = subdir ? safeChildPath(checkout, ...subdir.split('/')) : checkout
    const skillDir = await locateSkillDir(start, url)
    const fallback = skillDir === checkout ? repo : path.basename(skillDir)
    return copyIntoSkills(skillDir, fallback, url)
  })
}

async function installFromNpm(packageName: string, run: CommandRunner): Promise<SkillInstallResult> {
  const parsedName = npmSkillName(packageName)
  if (!parsedName) throw new Error(`Invalid npm package name: ${packageName}`)
  return withTempDir(async (tmp) => {
    try {
      // --pack-destination (not --prefix) decides where the tarball lands.
      await run('npm', ['pack', packageName, '--pack-destination', '.', '--silent'], { cwd: tmp })
    } catch (error) {
      throw new Error(`Could not download npm package "${packageName}": ${messageOf(error)}`)
    }
    const tarball = (await readdir(tmp)).find((file) => file.endsWith('.tgz'))
    if (!tarball) throw new Error(`npm did not produce an archive for "${packageName}"`)
    const archive = path.join(tmp, tarball)
    const info = await lstat(archive)
    if (!info.isFile() || info.size > MAX_ARCHIVE_BYTES) {
      throw new Error(`The npm archive exceeds the ${MAX_ARCHIVE_BYTES / 1_000_000} MB limit.`)
    }
    const extracted = path.join(tmp, 'extracted')
    await mkdir(extracted)
    try {
      // npm archives never hold absolute or parent paths; tar refuses both by
      // default as well, and copyIntoSkills skips anything that is not a plain file.
      // Relative paths: GNU tar (Git for Windows) reads "C:\..." as host "C".
      await run('tar', ['-xzf', tarball, '-C', 'extracted'], { cwd: tmp })
    } catch (error) {
      throw new Error(`Could not extract the npm package (is tar available?): ${messageOf(error)}`)
    }
    const skillDir = await locateSkillDir(path.join(extracted, 'package'), packageName)
    return copyIntoSkills(skillDir, parsedName, packageName)
  })
}

async function installFromLocal(source: string): Promise<SkillInstallResult> {
  const resolved = path.resolve(source)
  const info = await lstat(resolved).catch(() => null)
  if (!info) throw new Error(`No such file or directory: ${source}`)
  const start = info.isFile() && path.basename(resolved) === SKILL_FILE ? path.dirname(resolved) : resolved
  const skillDir = await locateSkillDir(start, source)
  return copyIntoSkills(skillDir, path.basename(skillDir), resolved)
}

/**
 * The directory holding SKILL.md: the start itself, or the single one found
 * below it. A collection of several skills is listed instead of guessed at.
 */
async function locateSkillDir(start: string, source: string): Promise<string> {
  const info = await lstat(start).catch(() => null)
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`"${source}" does not point to a directory.`)
  }
  if (await isPlainFile(path.join(start, SKILL_FILE))) return start

  const found: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_SEARCH_DEPTH || found.length > 50) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED_DIRS.has(entry.name)) continue
      const child = path.join(dir, entry.name)
      if (await isPlainFile(path.join(child, SKILL_FILE))) found.push(child)
      else await walk(child, depth + 1)
    }
  }
  await walk(start, 1)

  if (found.length === 1) return found[0] as string
  if (found.length === 0) throw new Error(`No ${SKILL_FILE} found in "${source}".`)
  const listed = found
    .slice(0, 20)
    .map((dir) => `  ${path.relative(start, dir).split(path.sep).join('/')}`)
    .join('\n')
  throw new Error(
    `"${source}" contains ${found.length} skills; install one of them by its own path` +
      ` (for GitHub: .../tree/<branch>/<path>):\n${listed}`,
  )
}

/** Copy the whole skill directory, then swap it in place of any older copy. */
async function copyIntoSkills(
  sourceDir: string,
  fallbackName: string,
  source: string,
): Promise<SkillInstallResult> {
  const skillFile = path.join(sourceDir, SKILL_FILE)
  const skillInfo = await lstat(skillFile)
  if (skillInfo.size > MAX_SKILL_BYTES) {
    throw new Error(`${SKILL_FILE} exceeds the ${MAX_SKILL_BYTES / 1_000_000} MB limit.`)
  }
  const name = safeSkillName(frontmatterName(await readFile(skillFile, 'utf8')) ?? fallbackName)
  const destination = safeChildPath(skillsDir, name)
  const existing = await lstat(destination).catch(() => null)
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
    throw new Error(`Refusing to replace ${destination}: it is not a plain skill directory.`)
  }

  await ensureDir(TMP_DIR)
  const staging = safeChildPath(TMP_DIR, `s-${randomUUID().slice(0, 8)}`)
  try {
    await copyTree(sourceDir, staging)
    if (existing) await rm(destination, { recursive: true, force: true })
    await rename(staging, destination)
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  return { name, dir: destination, source }
}

async function copyTree(from: string, to: string): Promise<void> {
  let files = 0
  let bytes = 0
  const visit = async (dir: string, target: string): Promise<void> => {
    await mkdir(target, { recursive: true, mode: 0o700 })
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const source = path.join(dir, entry.name)
      const destination = path.join(target, entry.name)
      // Symlinks are skipped, not followed: a skill must not smuggle in a
      // link to ~/.ssh that the agent later reads as part of the skill.
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await visit(source, destination)
        continue
      }
      if (!entry.isFile()) continue
      const info = await lstat(source)
      files += 1
      bytes += info.size
      if (files > MAX_SKILL_FILES || bytes > MAX_SKILL_TOTAL_BYTES) {
        throw new Error(
          `The skill is too large to install (limit ${MAX_SKILL_FILES} files, ${MAX_SKILL_TOTAL_BYTES / 1_000_000} MB).`,
        )
      }
      await copyFile(source, destination)
      await chmod(destination, (info.mode & 0o111) !== 0 ? 0o700 : 0o600)
    }
  }
  await visit(from, to)
}

function frontmatterName(text: string): string | undefined {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return undefined
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') return undefined
    const match = /^name\s*:\s*(.+)$/.exec(line)
    if (match) {
      const value = (match[1] as string).trim().replace(/^(["'])(.*)\1$/, '$2').trim()
      // Only a name that is also a safe directory name is used as one.
      return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ? value : undefined
    }
  }
  return undefined
}

async function withTempDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  await ensureDir(TMP_DIR)
  // Short on purpose: every character here is one less for the repository's own paths.
  const dir = safeChildPath(TMP_DIR, randomUUID().slice(0, 8))
  await mkdir(dir, { mode: 0o700 })
  try {
    return await work(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<void> {
  // npm is a .cmd shim on Windows, which only runs through a shell. Every
  // argument here is a validated name, a flag, or a path we created.
  const viaShell = process.platform === 'win32' && command === 'npm'
  const file = viaShell ? [command, ...args.map(quoteForCmd)].join(' ') : command
  return new Promise((resolve, reject) => {
    execFile(
      file,
      viaShell ? [] : args,
      {
        cwd: options.cwd,
        env: options.env,
        shell: viaShell,
        timeout: COMMAND_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4_000_000,
      },
      (error, _stdout, stderr) => {
        if (!error) return resolve()
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return reject(new Error(`${command} is not installed or not on PATH`))
        if ((error as { killed?: boolean }).killed) {
          return reject(new Error(`${command} timed out after ${COMMAND_TIMEOUT_MS / 1000}s`))
        }
        const detail = String(stderr ?? '')
          .trim()
          .split(/\r?\n/)
          .filter((line) => line.trim() !== '' && !/^Cloning into /.test(line))
          .slice(-3)
          .join(' ')
        reject(new Error(detail || error.message))
      },
    )
  })
}

function quoteForCmd(value: string): string {
  return /^[\w@./:=+-]+$/.test(value) ? value : `"${value.replace(/"/g, '""')}"`
}

function isGitHubUrl(input: string): boolean {
  try {
    const url = new URL(input)
    return url.protocol === 'https:' && (url.hostname === 'github.com' || url.hostname === 'www.github.com')
  } catch {
    return false
  }
}

export function npmSkillName(input: string): string | null {
  if (input.includes('\\') || input.startsWith('.')) return null
  // A leading dash would reach npm as an option instead of a package name.
  const scoped = input.match(/^@[\w][\w.-]*\/([\w][\w.-]*)(?:@[\w.*+-]+)?$/)
  if (scoped) return scoped[1] ?? null
  const unscoped = input.match(/^([\w][\w.-]*)(?:@[\w.*+-]+)?$/)
  return unscoped?.[1] ?? null
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
  // .../tree/<branch>/<dir> for a folder, .../blob/<branch>/<dir>/SKILL.md
  // for the file itself, as copied from the GitHub page.
  if ((segments[2] !== 'tree' && segments[2] !== 'blob') || segments.length < 4) {
    throw new Error(`Unsupported GitHub skill URL: ${url}`)
  }

  const branch = safeGitHubSegment(segments[3] as string, 'branch')
  const pathSegments = segments.slice(4)
  if (segments[2] === 'blob' && pathSegments.at(-1) === SKILL_FILE) pathSegments.pop()
  const subdirSegments = pathSegments.map((segment) => safeGitHubSegment(segment, 'path'))
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
    value.startsWith('-') ||
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
  const relative = path.relative(path.resolve(root), target)
  if (relative !== '' && (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`))) {
    throw new Error(`Path escapes the skills directory: ${target}`)
  }
  return target
}

async function isPlainFile(file: string): Promise<boolean> {
  const info = await lstat(file).catch(() => null)
  return Boolean(info?.isFile() && !info.isSymbolicLink())
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
