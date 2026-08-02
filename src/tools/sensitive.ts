import path from 'node:path'

const sensitiveNames = new Set([
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  'auth.json',
  'credentials',
  'credentials.json',
  'id_rsa',
  'id_ed25519',
])

const sensitiveExtensions = new Set(['.pem', '.key', '.p12', '.pfx'])

export function isSensitivePath(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const normalized = value.replaceAll('\\', '/').toLowerCase()
  const name = path.posix.basename(normalized)
  if (name === '.env' || name.startsWith('.env.')) return true
  if (sensitiveNames.has(name) || sensitiveExtensions.has(path.posix.extname(name))) return true
  return normalized.split('/').some((part) => part === '.ssh' || part === '.aws')
}

export function mentionsSensitivePattern(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const lower = value.toLowerCase()
  return (
    isSensitivePath(lower) ||
    lower.includes('.env') ||
    lower.includes('.npmrc') ||
    lower.includes('auth.json') ||
    /\.(?:pem|key|p12|pfx)(?:$|[^a-z0-9])/.test(lower)
  )
}
