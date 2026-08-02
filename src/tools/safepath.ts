import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export type SafePath = { ok: true; path: string; relative: string } | { ok: false; reason: string }

const MAX_SYMLINK_HOPS = 40

function canonicalize(target: string): string {
  const trailing: string[] = []
  let current = target
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
    const info = lstatSync(current, { throwIfNoEntry: false })
    if (info?.isSymbolicLink()) {
      current = resolve(dirname(current), readlinkSync(current))
      continue
    }
    if (info) return resolve(realpathSync(current), ...trailing)
    const parent = dirname(current)
    if (parent === current) break
    trailing.unshift(basename(current))
    current = parent
  }
  return resolve(current, ...trailing)
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
  return isAbsolute(pattern) || pattern.split('/').includes('..')
}
