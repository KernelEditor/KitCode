import type { AgentEvent } from '../core/types'
import type { Message } from '../providers/types'
import { attachmentLabel } from '../core/attachments'
import type { ToolDisplay } from '../tools/types'
import type { Bubble } from './types'
import { canRenderDiff, MAX_RENDER_DIFF_CHARS } from './diff'
import { sanitizeTerminalText } from './sanitize'

export interface TranscriptState {
  bubbles: Bubble[]
  seq: number
}

export function emptyTranscript(): TranscriptState {
  return { bubbles: [], seq: 0 }
}

export function pushUser(state: TranscriptState, text: string): TranscriptState {
  const id = `u${state.seq}`
  return {
    bubbles: [...state.bubbles, { kind: 'user', id, text: sanitizeTerminalText(text) }],
    seq: state.seq + 1,
  }
}

export function pushNotice(
  state: TranscriptState,
  level: 'info' | 'warn' | 'error',
  text: string,
): TranscriptState {
  const id = `n${state.seq}`
  return {
    bubbles: [...state.bubbles, { kind: 'notice', id, level, text: sanitizeTerminalText(text) }],
    seq: state.seq + 1,
  }
}

export function applyEvent(state: TranscriptState, event: AgentEvent): TranscriptState {
  switch (event.type) {
    case 'text_delta':
      return appendToAssistant(state, (bubble) => ({
        ...bubble,
        text: bubble.text + sanitizeTerminalText(event.text),
      }))

    case 'thinking_delta':
      return appendToAssistant(state, (bubble) => ({
        ...bubble,
        thinking: bubble.thinking + sanitizeTerminalText(event.text),
      }))

    case 'tool_start':
      return {
        bubbles: [
          ...closeAssistant(state.bubbles),
          {
            kind: 'tool',
            id: event.id,
            name: sanitizeTerminalText(event.name),
            summary: sanitizeTerminalText(event.summary),
            state: 'running',
            content: '',
          },
        ],
        seq: state.seq + 1,
      }

    case 'tool_end':
      return {
        ...state,
        bubbles: state.bubbles.map((bubble) =>
          bubble.kind === 'tool' && bubble.id === event.id
            ? {
                ...bubble,
                state: event.isError ? 'error' : 'ok',
                content: sanitizeTerminalText(event.content),
                display: sanitizeDisplay(event.display),
              }
            : bubble,
        ),
      }

    case 'subagent_start':
      return {
        bubbles: [
          ...closeAssistant(state.bubbles),
          {
            kind: 'subagent',
            id: event.id,
            description: sanitizeTerminalText(event.description),
            state: 'running',
            seq: 0,
            bubbles: [],
          },
        ],
        seq: state.seq + 1,
      }

    case 'subagent_end':
      return {
        ...state,
        bubbles: state.bubbles.map((bubble) =>
          bubble.kind === 'subagent' && bubble.id === event.id
            ? { ...bubble, state: 'done', result: sanitizeTerminalText(event.result) }
            : bubble,
        ),
      }

    case 'subagent_event': {
      const idx = state.bubbles.findLastIndex(
        (b) => b.kind === 'subagent' && b.id === event.id,
      )
      if (idx === -1) return state
      const sub = state.bubbles[idx] as Extract<typeof state.bubbles[number], { kind: 'subagent' }>
      const innerState: TranscriptState = { bubbles: sub.bubbles, seq: sub.seq }
      const updated = applyEvent(innerState, event.event)
      return {
        ...state,
        bubbles: state.bubbles.map((bubble, i) =>
          i === idx
            ? { ...sub, seq: updated.seq, bubbles: updated.bubbles }
            : bubble,
        ),
      }
    }

    case 'notice':
      return pushNotice(state, event.level, event.text)

    case 'turn_end':
      return { ...state, bubbles: closeAssistant(state.bubbles) }

    case 'turn_start':
    case 'usage':
    case 'rate_limits':
      return state
  }
}

export function applyEvents(state: TranscriptState, events: AgentEvent[]): TranscriptState {
  return coalesceDeltas(events).reduce(applyEvent, state)
}

function coalesceDeltas(events: AgentEvent[]): AgentEvent[] {
  const out: AgentEvent[] = []
  for (const event of events) {
    const previous = out.at(-1)
    if (event.type === 'text_delta' && previous?.type === 'text_delta') {
      out[out.length - 1] = { type: 'text_delta', text: previous.text + event.text }
    } else if (event.type === 'thinking_delta' && previous?.type === 'thinking_delta') {
      out[out.length - 1] = { type: 'thinking_delta', text: previous.text + event.text }
    } else {
      out.push(event)
    }
  }
  return out
}

function appendToAssistant(
  state: TranscriptState,
  update: (bubble: Extract<Bubble, { kind: 'assistant' }>) => Bubble,
): TranscriptState {
  const last = state.bubbles.at(-1)
  if (last?.kind === 'assistant' && last.streaming) {
    return { ...state, bubbles: [...state.bubbles.slice(0, -1), update(last)] }
  }
  const fresh: Extract<Bubble, { kind: 'assistant' }> = {
    kind: 'assistant',
    id: `a${state.seq}`,
    text: '',
    thinking: '',
    streaming: true,
  }
  return { bubbles: [...state.bubbles, update(fresh)], seq: state.seq + 1 }
}

function closeAssistant(bubbles: Bubble[]): Bubble[] {
  if (!bubbles.some((bubble) => bubble.kind === 'assistant' && bubble.streaming)) return bubbles
  return bubbles.map((bubble) =>
    bubble.kind === 'assistant' && bubble.streaming ? { ...bubble, streaming: false } : bubble,
  )
}

export function fromHistory(messages: Message[]): TranscriptState {
  let state = emptyTranscript()

  for (const message of messages) {
    if (message.role === 'user') {
      const displayed = message.content
        .flatMap((block) => {
          if (block.type === 'text') return [block.text]
          const label = attachmentLabel(block)
          return label ? [`📎 ${label}`] : []
        })
        .map((value) => sanitizeTerminalText(value).trim())
        .filter(Boolean)
        .join('\n')
      if (displayed) state = pushUser(state, displayed)
    }
    for (const block of message.content) {
      if (block.type === 'text') {
        if (message.role === 'user') continue
        const text = sanitizeTerminalText(block.text).trim()
        if (text === '') continue
        state =
          {
            bubbles: [
              ...state.bubbles,
              { kind: 'assistant', id: `a${state.seq}`, text, thinking: '', streaming: false },
            ],
            seq: state.seq + 1,
          }
      } else if (block.type === 'tool_use') {
        state = {
          bubbles: [
            ...state.bubbles,
            {
              kind: 'tool',
              id: block.id,
              name: sanitizeTerminalText(block.name),
              summary: sanitizeTerminalText(block.name),
              state: 'ok',
              content: '',
            },
          ],
          seq: state.seq + 1,
        }
      } else if (block.type === 'tool_result') {
        state = {
          ...state,
          bubbles: state.bubbles.map((bubble) =>
            bubble.kind === 'tool' && bubble.id === block.toolUseId
              ? {
                  ...bubble,
                  state: block.isError ? 'error' : 'ok',
                  content: sanitizeTerminalText(block.content),
                }
              : bubble,
          ),
        }
      } else if ((block.type === 'image' || block.type === 'file') && message.role === 'assistant') {
        const label = attachmentLabel(block)
        if (label) {
          state = {
            bubbles: [
              ...state.bubbles,
              {
                kind: 'assistant',
                id: `a${state.seq}`,
                text: `📎 ${sanitizeTerminalText(label)}`,
                thinking: '',
                streaming: false,
              },
            ],
            seq: state.seq + 1,
          }
        }
      }
    }
  }

  return state
}

function sanitizeDisplay(display: ToolDisplay | undefined): ToolDisplay | undefined {
  if (!display) return undefined
  if (display.kind === 'text') return { ...display, text: sanitizeTerminalText(display.text) }
  if (display.kind === 'list') {
    return {
      ...display,
      title: sanitizeTerminalText(display.title),
      items: display.items.map(sanitizeTerminalText),
    }
  }
  if (!canRenderDiff(display.before, display.after)) {
    return {
      kind: 'text',
      text: `Diff for ${sanitizeTerminalText(display.path)} omitted from the transcript because it exceeds ${MAX_RENDER_DIFF_CHARS.toLocaleString()} characters.`,
    }
  }
  return {
    ...display,
    path: sanitizeTerminalText(display.path),
    before: sanitizeTerminalText(display.before),
    after: sanitizeTerminalText(display.after),
  }
}
