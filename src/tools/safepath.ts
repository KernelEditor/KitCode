import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export type SafePath = { ok: true; path: string; relative: string } | { ok: false; reason: string }

function canonicalize(target: string): string {
  try {
    return realpathSync(target)
  } catch {
    let current = target
    const trailing: string[] = []
    for (let i = 0; i < 64; i++) {
      try {
        return resolve(realpathSync(current), ...trailing)
      } catch {
        const parent = dirname(current)
        if (parent === current) break
        trailing.unshift(basename(current))
        current = parent
      }
    }
    return resolve(current, ...trailing)
  }
}

export function resolveInside(cwd: string, userPath: string): SafePath {
  const root = canonicalize(resolve(cwd))
  const target = canonicalize(resolve(root, userPath))
  const rel = relative(root, target)
  if (rel !== '' && (isAbsolute(rel) || rel.split(sep)[0] === '..')) {
    return { ok: false, reason: `Path ${userPath} resolves outside the workspace root ${root}` }
  }
  return { ok: true, path: target, relative: rel }
}

export function patternEscapes(pattern: string): boolean {
  return isAbsolute(pattern) || pattern.split('/').includes('..') || pattern.split('\\').includes('..')
}
