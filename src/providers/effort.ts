import type { Effort, Message, ProviderKind } from './types'

type Level = Exclude<Effort, 'auto'>

// Match keywords at a word start so "prefix" or "latest" do not count as fix/test.
const HARD_TASK = /(?<!\p{L})(?:bug|fix|debug|test|refactor|implement|баг|фикс|исправ|тест|рефактор|реализ)/iu

export function resolveEffort(effort: Effort | undefined, messages: Message[]): Level | undefined {
  if (effort !== 'auto') return effort
  const latest = messages.findLast((message) => message.role === 'user' && message.content.some((block) => block.type === 'text'))
  const text = latest?.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n') ?? ''
  return text.length > 500 || HARD_TASK.test(text) ? 'high' : 'medium'
}

// provider/model pairs whose endpoint rejected reasoning_effort this session.
const rejected = new Set<string>()

export function markEffortRejected(providerId: string, model: string): void {
  rejected.add(`${providerId}/${model}`)
}

/** The effort level actually sent to the API, or undefined when the model does not accept one. */
export function effectiveEffort(
  kind: ProviderKind,
  model: string,
  effort: Effort | undefined,
  messages: Message[],
  providerId?: string,
): Level | undefined {
  if (providerId !== undefined && rejected.has(`${providerId}/${model}`)) return undefined
  const requested = resolveEffort(effort, messages)
  return kind === 'openai' ? openAiEffort(model, requested) : anthropicEffort(model, requested)
}

export function anthropicEffort(model: string, effort: Level | undefined): Level | undefined {
  if (!effort) return undefined
  const id = (model.split('/').at(-1) ?? model).replace(/^(?:[a-z]{2}\.)?anthropic\./, '')
  // Anthropic-compatible gateways serving other models (GLM, Kimi, MiniMax…)
  // reject or ignore output_config; only send it to Claude.
  if (!id.startsWith('claude-')) return undefined
  // Claude 3.x, Haiku 4.5, Sonnet 4.x before 4.6 and Opus 4.0/4.1 reject effort.
  if (/^claude-(?:3|[a-z]+-3|haiku-4|sonnet-4(?:-[0-5])?(?:-\d{8}|@|$)|opus-4(?:-[01])?(?:-\d{8}|@|$))/.test(id)) return undefined
  // Opus 4.5 supports low/medium/high only.
  if (/^claude-opus-4-5(?:-|@|$)/.test(id)) return effort === 'xhigh' || effort === 'max' ? 'high' : effort
  // Opus 4.6 / Sonnet 4.6 have max but not xhigh (added in Opus 4.7).
  if (/^claude-(?:opus|sonnet)-4-6(?:-|@|$)/.test(id)) return effort === 'xhigh' ? 'high' : effort
  return effort
}

export function openAiEffort(model: string, effort: Level | undefined): Level | undefined {
  const id = (model.split('/').at(-1) ?? model).toLowerCase()
  // gpt-oss, Gemini (OpenAI-compatible endpoint) and Grok mini accept low/medium/high.
  if (/^(?:gpt-oss|gemini-(?:2\.5|[3-9])|grok-3-mini)/.test(id)) {
    return effort === 'max' || effort === 'xhigh' ? 'high' : effort
  }
  // Other OpenAI-compatible models (Kimi, GLM, Qwen, DeepSeek, gateways…):
  // send the widely supported low/medium/high. Endpoints that reject the
  // field are retried without it and remembered (markEffortRejected).
  if (!/^(?:o[134](?:-|$)|gpt-5(?:[.-]|$))/.test(id)) {
    return effort === 'max' || effort === 'xhigh' ? 'high' : effort
  }
  // The original GPT-5 and o-series expose only low/medium/high.
  if (/^(?:o[134](?:-|$)|gpt-5(?:-(?:mini|nano|\d{4})|$)|gpt-5\.1(?:-|$))/.test(id)) {
    return effort === 'max' || effort === 'xhigh' ? 'high' : effort
  }
  if (/^gpt-5\.[234](?:-|$)/.test(id)) return effort === 'max' ? 'xhigh' : effort
  return effort === 'max' || effort === 'xhigh' ? 'high' : effort
}
