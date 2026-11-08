import type { Strings } from './i18n'
import type { SubagentStatus } from '../core/types'

export function subagentStatusLabel(state: 'running' | SubagentStatus, strings: Strings): string {
  switch (state) {
    case 'running': return strings.subagentRunning
    case 'done': return strings.subagentDone
    case 'cancelled': return strings.subagentCancelled
    case 'error': return strings.subagentError
    case 'incomplete': return strings.subagentIncomplete
  }
}
