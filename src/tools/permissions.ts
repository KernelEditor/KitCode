import type { PermissionMode, Tool } from './types'

export type AgentMode = 'normal' | 'accept' | 'plan'

export const MODES: AgentMode[] = ['normal', 'accept', 'plan']

export interface PermissionEngine {
  resolve(tool: Tool, requested?: PermissionMode): PermissionMode
  decide(tool: Tool, requested?: PermissionMode, input?: unknown): PermissionMode
  grantForSession(toolName: string): void
  bypass: {
    enable(): void
    disable(): void
    isEnabled(): boolean
  }
  denyReason(tool: Tool, requested?: PermissionMode, input?: unknown): string | undefined
  mode: {
    get(): AgentMode
    set(mode: AgentMode): void
    /** Next mode for shift+tab; bypass joins the cycle once /bypass unlocked it. */
    cycle(): AgentMode | 'bypass'
  }
}

export const PLAN_REFUSAL =
  'Plan mode is on: this tool changes state and is unavailable. Investigate with read-only tools and reply with a plan instead. Do not retry.'

export function createPermissionEngine(
  configPermissions: Record<string, PermissionMode>,
): PermissionEngine {
  const sessionGrants = new Set<string>()
  let bypassEnabled = false
  // Set by an explicit, confirmed /bypass (or --bypass): only then may
  // shift+tab bring bypass back after leaving it.
  let bypassUnlocked = false
  let current: AgentMode = 'normal'

  const resolve = (tool: Tool, requested?: PermissionMode): PermissionMode =>
    configPermissions[tool.name] ?? requested ?? tool.defaultPermission

  return {
    resolve,
    decide(tool, requested, input) {
      const configured = resolve(tool, requested)
      if (configured === 'deny') return 'deny'
      if (current === 'plan' && !isReadOnly(tool, input)) return 'deny'
      // A tool asks explicitly for this one call (a credential read, a write to
      // kitcode.json or .git): a blanket "allow", accept mode or an earlier
      // "always" must not wave it through. Only an explicit bypass does.
      if (requested === 'ask') return bypassEnabled ? 'allow' : 'ask'
      if (configured === 'allow') return 'allow'
      if (bypassEnabled) return 'allow'
      if (current === 'accept' && isFileEdit(tool)) return 'allow'
      if (sessionGrants.has(tool.name)) return 'allow'
      return 'ask'
    },
    grantForSession(toolName) {
      sessionGrants.add(toolName)
    },
    denyReason(tool, requested, input) {
      const configured = resolve(tool, requested)
      if (current === 'plan' && !isReadOnly(tool, input)) return PLAN_REFUSAL
      if (configured === 'deny' || configured === 'allow') return undefined
      return undefined
    },
    bypass: {
      enable() {
        bypassEnabled = true
        bypassUnlocked = true
        // Bypass is a mode of its own: plan would otherwise still block writes.
        current = 'normal'
      },
      disable() {
        bypassEnabled = false
        bypassUnlocked = false
      },
      isEnabled() {
        return bypassEnabled
      },
    },
    mode: {
      get: () => current,
      set(mode) {
        current = mode
      },
      cycle() {
        if (bypassEnabled) {
          bypassEnabled = false
          current = 'normal'
          return current
        }
        const next = MODES[(MODES.indexOf(current) + 1) % MODES.length] ?? 'normal'
        if (next === 'normal' && bypassUnlocked) {
          bypassEnabled = true
          current = 'normal'
          return 'bypass'
        }
        current = next
        return current
      },
    },
  }
}

function isFileEdit(tool: Tool): boolean {
  return tool.name === 'write' || tool.name === 'edit'
}

function isReadOnly(tool: Tool, input: unknown): boolean {
  return typeof tool.readOnly === 'function' ? tool.readOnly(input) : tool.readOnly === true
}
