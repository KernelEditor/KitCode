import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { chmod, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { ensureDir, skillsDir } from '../config/paths'

const TMP_DIR = path.join(skillsDir, '.tmp')

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
  return /^https?:\/\/(www\.)?github\.com\/[\w.-]+\/[\w.-]+/.test(input)
}

function isNpmPackage(input: string): boolean {
  if (input.includes('/') || input.includes('\\') || input.startsWith('.')) return false
  return /^(@[\w.-]+\/)?[\w.-]+(@[\w.*+-]+)?$/.test(input)
}

async function installFromGitHub(url: string): Promise<SkillInstallResult> {
  const { owner, repo, subdir, branch } = parseGitHubUrl(url)
  const name = subdir || repo
  const skillDir = path.join(skillsDir, name)
  const tmpDir = path.join(TMP_DIR, `${name}-${Date.now()}`)

  try {
    rmSync(skillDir, { recursive: true, force: true })
    mkdirSync(tmpDir, { recursive: true })

    const cloneUrl = `https://github.com/${owner}/${repo}.git`
    const gitArgs = ['clone', '--depth', '1']
    if (branch) gitArgs.push('--branch', branch)
    gitArgs.push(cloneUrl, tmpDir)

    execFileSync('git', gitArgs, { stdio: 'ignore' })

    const skillFile = subdir ? path.join(tmpDir, subdir, 'SKILL.md') : path.join(tmpDir, 'SKILL.md')
    if (!existsSync(skillFile)) {
      throw new Error(`No SKILL.md found in "${subdir || repo}"`)
    }

    const body = readFileSync(skillFile, 'utf8')
    await writeSkillFile(skillDir, body)

    return { name, dir: skillDir, source: url }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

async function installFromNpm(packageName: string): Promise<SkillInstallResult> {
  const name = packageName.replace(/^@/, '').replace(/\/[^/]*$/, '').replace(/@[^@]*$/, '')
  const skillDir = path.join(skillsDir, name)
  const tmpDir = path.join(TMP_DIR, `${name}-${Date.now()}`)

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
    const extractDir = path.join(tmpDir, 'extracted')
    mkdirSync(extractDir, { recursive: true })

    try {
      execFileSync('tar', ['-xzf', tarballPath, '-C', extractDir], { stdio: 'ignore' })
    } catch {
      
      const packageDir = path.join(tmpDir, 'node_modules', packageName)
      if (existsSync(packageDir)) {
        const skillFile = path.join(packageDir, 'SKILL.md')
        if (existsSync(skillFile)) {
          const body = readFileSync(skillFile, 'utf8')
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

    const body = readFileSync(skillFile, 'utf8')
    await writeSkillFile(skillDir, body)

    return { name, dir: skillDir, source: packageName }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
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
  const destDir = path.join(skillsDir, name)
  const body = readFileSync(skillFile, 'utf8')

  await writeSkillFile(destDir, body)

  return { name, dir: destDir, source: resolved }
}

async function writeSkillFile(dir: string, body: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, 'SKILL.md')
  writeFileSync(file, body)
  await chmod(file, 0o600)
}

function parseGitHubUrl(url: string): { owner: string; repo: string; subdir?: string; branch?: string } {
  
  
  
  const match = url.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.+)))?/,
  )
  if (!match) {
    const simple = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)/)
    if (simple) {
      return { owner: simple[1], repo: simple[2] }
    }
    throw new Error(`Cannot parse GitHub URL: ${url}`)
  }
  return { owner: match[1], repo: match[2], branch: match[3], subdir: match[4] }
}
