import type { Effort, Message } from './types'

export function resolveEffort(effort: Effort | undefined, messages: Message[]): Exclude<Effort, 'auto'> | undefined {
  if (effort !== 'auto') return effort
  const latest = messages.findLast((message) => message.role === 'user' && message.content.some((block) => block.type === 'text'))
  const text = latest?.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n') ?? ''
  return text.length > 500 || /bug|fix|debug|test|refactor|implement|баг|фикс|исправ|тест|рефактор|реализ/i.test(text) ? 'high' : 'medium'
}

export function openAiEffort(model: string, effort: Exclude<Effort, 'auto'> | undefined): Exclude<Effort, 'auto'> | undefined {
  const id = model.split('/').at(-1) ?? model
  if (!/^(?:o[134](?:-|$)|gpt-5(?:[.-]|$))/.test(id)) return undefined
  // The original GPT-5 and o-series expose only low/medium/high.
  if (/^(?:o[134](?:-|$)|gpt-5(?:-(?:mini|nano|\d{4})|$)|gpt-5\.1(?:-|$))/.test(id)) {
    return effort === 'max' || effort === 'xhigh' ? 'high' : effort
  }
  if (/^gpt-5\.[234](?:-|$)/.test(id)) return effort === 'max' ? 'xhigh' : effort
  return effort === 'max' || effort === 'xhigh' ? 'high' : effort
}
