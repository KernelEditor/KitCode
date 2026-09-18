import fg from 'fast-glob'
import { IGNORED_DIRECTORIES } from '../tools/glob'

const MAX_SCANNED = 20_000
const MAX_RESULTS = 12
const CACHE_TTL_MS = 10_000

interface Listing {
  cwd: string
  files: string[]
  at: number
}

let cached: Listing | undefined
let inFlight: Promise<string[]> | undefined

export async function searchWorkspaceFiles(cwd: string, query: string): Promise<string[]> {
  const files = await workspaceFiles(cwd)
  const needle = query.trim().toLowerCase()
  if (needle === '') return files.slice(0, MAX_RESULTS)

  const exact: string[] = []
  const loose: string[] = []
  for (const file of files) {
    const haystack = file.toLowerCase()
    if (haystack.includes(needle)) exact.push(file)
    else if (isSubsequence(needle, haystack)) loose.push(file)
    if (exact.length >= MAX_RESULTS) break
  }
  // A basename hit is what the typist meant far more often than a directory
  // somewhere in the middle of the path.
  exact.sort((a, b) => score(a, needle) - score(b, needle))
  return [...exact, ...loose].slice(0, MAX_RESULTS)
}

export function resetWorkspaceFileCache(): void {
  cached = undefined
  inFlight = undefined
}

function workspaceFiles(cwd: string): Promise<string[]> {
  const fresh = cached && cached.cwd === cwd && Date.now() - cached.at < CACHE_TTL_MS
  if (fresh) return Promise.resolve(cached!.files)
  if (inFlight) return inFlight

  inFlight = fg('**/*', {
    cwd,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
    suppressErrors: true,
    ignore: IGNORED_DIRECTORIES,
  })
    .then((entries) => {
      const files = entries.slice(0, MAX_SCANNED).sort((a, b) => a.length - b.length)
      cached = { cwd, files, at: Date.now() }
      return files
    })
    .catch(() => [] as string[])
    .finally(() => {
      inFlight = undefined
    })
  return inFlight
}

function score(file: string, needle: string): number {
  const basename = file.slice(file.lastIndexOf('/') + 1).toLowerCase()
  if (basename.startsWith(needle)) return 0
  if (basename.includes(needle)) return 1
  return 2
}

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0
  for (const character of haystack) {
    if (character === needle[index]) index += 1
    if (index === needle.length) return true
  }
  return needle.length === 0
}
