import { z } from 'zod'

export function isAllowedEndpointUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.username || url.password) return false
    if (url.protocol === 'https:') return true
    if (url.protocol !== 'http:') return false
    const host = url.hostname.toLowerCase()
    return (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '[::1]' ||
      host === '::1' ||
      /^127(?:\.\d{1,3}){3}$/.test(host)
    )
  } catch {
    return false
  }
}

const httpUrl = z.string().refine(isAllowedEndpointUrl, {
  message: 'must use https, except for localhost/127.0.0.1 development endpoints',
})

export const providerKindSchema = z.enum(['anthropic', 'openai'])

export const providerConfigSchema = z.object({
  type: providerKindSchema,
  baseUrl: httpUrl,
  label: z.string().optional(),
  keyEnv: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
})

export const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])

export const permissionModeSchema = z.enum(['allow', 'ask', 'deny'])

const mcpStdioSchema = z.object({
  type: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true),
})

const mcpHttpSchema = z.object({
  type: z.literal('http'),
  url: httpUrl,
  headers: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true),
})

export const mcpServerSchema = z.discriminatedUnion('type', [mcpStdioSchema, mcpHttpSchema])

export const themeSchema = z.object({
  accent: z.string().default('#a78bfa'),
})

export const langSchema = z.enum(['en', 'ru'])

export const budgetSchema = z.object({
  maxRequestsPerTurn: z.number().int().min(1).max(256).default(32),
  maxTokensPerTurn: z.number().int().min(1_000).max(10_000_000).default(1_000_000),
  maxCostUsdPerTurn: z.number().positive().max(1_000).default(5),
  maxSubagentsPerTurn: z.number().int().min(0).max(16).default(3),
})

export const diagnosticsSchema = z.object({
  autoRun: z.boolean().default(true),
  commands: z.array(z.string().trim().min(1).max(20_000)).max(8).default([]),
})

export const configSchema = z.object({
  version: z.literal(1).default(1),
  model: z.string().optional(),
  lang: langSchema.optional(),
  theme: themeSchema.default({ accent: '#a78bfa' }),
  effort: effortSchema.default('xhigh'),
  thinking: z.boolean().default(true),
  maxTokens: z.number().int().positive().max(200_000).default(64_000),
  budget: budgetSchema.default({
    maxRequestsPerTurn: 32,
    maxTokensPerTurn: 1_000_000,
    maxCostUsdPerTurn: 5,
    maxSubagentsPerTurn: 3,
  }),
  diagnostics: diagnosticsSchema.default({ autoRun: true, commands: [] }),
  providers: z.record(z.string(), providerConfigSchema).default({}),
  permissions: z.record(z.string(), permissionModeSchema).default({}),
  mcp: z.record(z.string(), mcpServerSchema).default({}),
})

export const authSchema = z.record(z.string(), z.string())

export type ProviderConfig = z.infer<typeof providerConfigSchema>
export type McpServerConfig = z.infer<typeof mcpServerSchema>
export type Config = z.infer<typeof configSchema>
export type AuthFile = z.infer<typeof authSchema>

export function defaultConfig(): Config {
  return configSchema.parse({})
}

export function parseModelRef(ref: string): { provider: string; model: string } | null {
  const slash = ref.indexOf('/')
  if (slash <= 0 || slash === ref.length - 1) return null
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) }
}

export function formatModelRef(provider: string, model: string): string {
  return `${provider}/${model}`
}
