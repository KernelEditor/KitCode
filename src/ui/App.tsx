import { Box, useApp, useInput } from 'ink'
import { execFile, execFileSync } from 'node:child_process'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentEvent, AgentHooks, PermissionDecision, PermissionRequest } from '../core/types'
import type { Effort, Message } from '../providers/types'
import { COMMANDS, closestCommand } from './commands'
import { Confirm } from './components/Confirm'
import { LanguagePicker } from './components/LanguagePicker'
import { Logo } from './components/Logo'
import { Onboarding } from './components/Onboarding'
import { PermissionPrompt } from './components/PermissionPrompt'
import { Picker } from './components/Picker'
import { PromptInput } from './components/PromptInput'
import { StatusBar } from './components/StatusBar'
import { Transcript } from './components/Transcript'
import { appendInputHistory } from './history'
import { LANGS, StringsContext, stringsFor } from './i18n'
import type { Lang } from './i18n'
import type { Runtime } from './runtime'
import { PRESETS, ThemeContext, makeTheme, resolveAccent } from './theme'
import { formatDuration } from './time'
import { applyEvents, emptyTranscript, fromHistory, pushNotice, pushUser } from './transcript'
import type { PickerItem } from './types'

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const STREAM_FRAME_MS = 50

// Slash commands that affect conversation state and must wait until the agent
// finishes the current turn before running.
const NEEDS_IDLE = new Set<string>(['clear', 'resume', 'logout', 'bypass'])

type Overlay =
  | { kind: 'none' }
  | { kind: 'permission'; request: PermissionRequest; resolve: (d: PermissionDecision) => void }
  | { kind: 'picker'; title: string; items: PickerItem[]; select: (key: string) => void }
  | {
      kind: 'confirm'
      title: string
      body?: string
      danger?: boolean
      resolve: (yes: boolean) => void
    }

export function App({
  runtime,
  initialHistory,
  warnings = [],
}: {
  runtime: Runtime
  initialHistory: Message[]
  warnings?: string[]
}) {
  const { exit } = useApp()
  const [transcript, setTranscript] = useState(() =>
    warnings.reduce((state, text) => pushNotice(state, 'warn', text), fromHistory(initialHistory)),
  )
  const [transcriptRevision, setTranscriptRevision] = useState(0)
  const [input, setInput] = useState('')
  const [promptHistory, setPromptHistory] = useState(() =>
    inputHistoryFromMessages(initialHistory),
  )
  const [busy, setBusy] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  const queueRef = useRef<string[]>([])
  const [overlay, setOverlay] = useState<Overlay>({ kind: 'none' })
  const [accent, setAccent] = useState(runtime.getAccent())
  const [lang, setLang] = useState<Lang | undefined>(runtime.getLang())
  const [setup, setSetup] = useState(runtime.needsSetup())
  const [, forceRender] = useState(0)
  const history = useRef<Message[]>(initialHistory)
  const abort = useRef<AbortController | null>(null)
  const sessionStart = useRef(Date.now())
  const turns = useRef(0)
  const [turnStart, setTurnStart] = useState<number | null>(null)
  const [, tick] = useState(0)
  const [context, setContext] = useState(() => runtime.modelContext())
  const transcriptEvents = useRef<AgentEvent[]>([])
  const transcriptTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushTranscriptEvents = useCallback(() => {
    if (transcriptTimer.current !== null) {
      clearTimeout(transcriptTimer.current)
      transcriptTimer.current = null
    }
    const events = transcriptEvents.current
    if (events.length === 0) return
    transcriptEvents.current = []
    setTranscript((state) => applyEvents(state, events))
  }, [])

  const queueTranscriptEvent = useCallback(
    (event: AgentEvent) => {
      transcriptEvents.current.push(event)
      if (event.type !== 'text_delta' && event.type !== 'thinking_delta') {
        flushTranscriptEvents()
        return
      }
      transcriptTimer.current ??= setTimeout(flushTranscriptEvents, STREAM_FRAME_MS)
    },
    [flushTranscriptEvents],
  )

  useEffect(
    () => () => {
      if (transcriptTimer.current !== null) clearTimeout(transcriptTimer.current)
      transcriptEvents.current = []
    },
    [],
  )

  useEffect(
    () => runtime.subscribeContext(() => setContext(runtime.modelContext())),
    [runtime],
  )

  useEffect(() => {
    if (turnStart === null) return
    const timer = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [turnStart])

  // Auto-copy mouse-selected text to the system clipboard.
  //
  // In a CLI/TUI you normally can't intercept mouse selections — they live
  // inside the terminal emulator. Linux X11 exposes the "primary selection"
  // (what's currently highlighted by the mouse) via the X clipboard; polling it
  // and forwarding it to the "clipboard" gives "select to copy" behaviour.
  // Wayland and macOS don't expose an equivalent, so we skip them.
  useEffect(() => {
    if (process.platform === 'darwin') return
    let last = ''
    let cancelling = false
    let giveUp = false
    let polling = false
    let interval: ReturnType<typeof setInterval> | null = null
    const poll = () => {
      if (cancelling || giveUp || polling) return
      polling = true
      execFile(
        'xclip',
        ['-o', '-selection', 'primary'],
        { encoding: 'utf8' },
        (error, stdout) => {
          polling = false
          if (cancelling) return
          if (error) {
            // xclip missing or not X11: stop polling for the rest of the session.
            giveUp = true
            if (interval) clearInterval(interval)
            return
          }
          const sel = stdout.trim()
          if (sel && sel !== last) {
            last = sel
            copyToClipboard(sel)
          }
        },
      )
    }
    poll()
    interval = setInterval(poll, 750)
    return () => {
      cancelling = true
      if (interval) clearInterval(interval)
    }
  }, [])

  const theme = useMemo(() => makeTheme(accent), [accent])
  const strings = useMemo(() => stringsFor(lang), [lang])

  const notice = useCallback(
    (level: 'info' | 'warn' | 'error', text: string) => {
      flushTranscriptEvents()
      setTranscript((state) => pushNotice(state, level, text))
    },
    [flushTranscriptEvents],
  )

  const ask = useCallback(
    (title: string, body?: string, danger?: boolean) =>
      new Promise<boolean>((resolve) => {
        setOverlay({ kind: 'confirm', title, body, danger, resolve })
      }),
    [],
  )

  const pick = useCallback(
    (title: string, items: PickerItem[]) =>
      new Promise<string | null>((resolve) => {
        if (items.length === 0) {
          resolve(null)
          return
        }
        setOverlay({ kind: 'picker', title, items, select: resolve })
      }),
    [],
  )

  const runAgent = useCallback(async () => {
    const controller = new AbortController()
    abort.current = controller
    setBusy(true)
    setTurnStart(Date.now())
    turns.current += 1
    const hooks: AgentHooks = {
      onEvent: queueTranscriptEvent,
      requestPermission: (request) =>
        new Promise<PermissionDecision>((resolve) => {
          setOverlay({ kind: 'permission', request, resolve })
        }),
    }
    try {
      history.current = await runtime.run(history.current, hooks, controller.signal)
      void runtime
        .persist(history.current)
        .catch((error) => notice('error', error instanceof Error ? error.message : String(error)))
    } catch (error) {
      notice('error', error instanceof Error ? error.message : String(error))
    } finally {
      flushTranscriptEvents()
      abort.current = null
      setBusy(false)
      setTurnStart(null)
      // Drain the queue of messages typed while the agent was running.
      const queue = queueRef.current
      if (queue.length > 0) {
        const [next, ...rest] = queue
        queueRef.current = rest
        setPendingCount(rest.length)
        queueMicrotask(() => enqueueNext(next))
      } else {
        setPendingCount(0)
      }
    }
  }, [flushTranscriptEvents, notice, queueTranscriptEvent, runtime])

  const applyAccent = useCallback(
    async (value: string) => {
      await runtime.setAccent(value)
      setAccent(value)
      notice('info', strings.accentSet(value, resolveAccent(value)))
    },
    [notice, runtime, strings],
  )

  const handleSlash = useCallback(
    async (line: string) => {
      const [command = '', ...rest] = line.slice(1).split(/\s+/)
      setInput('')

      switch (command) {
        case 'help':
          notice(
            'info',
            COMMANDS.map(
              (c) => `/${c.name}${c.args ? ` ${c.args}` : ''} — ${strings.cmd[c.name] ?? ''}`,
            )
              .concat(strings.escHelp)
              .join('\n'),
          )
          return

        case 'exit':
        case 'quit':
          exit()
          return

        case 'clear':
          history.current = []
          setPromptHistory([])
          setTranscript(emptyTranscript())
          setTranscriptRevision((revision) => revision + 1)
          runtime.resetContext()
          void runtime
            .persist([])
            .catch((error) =>
              notice('error', error instanceof Error ? error.message : String(error)),
            )
          return

        case 'resume': {
          const items = await runtime.listSessionItems()
          if (items.length === 0) {
            notice('info', strings.sessionsEmpty)
            return
          }
          const choice = await pick(strings.titleSessions, items)
          if (!choice) return
          try {
            const restored = await runtime.resumeSession(choice)
            history.current = restored
            setPromptHistory(inputHistoryFromMessages(restored))
            setTranscript(
              pushNotice(
                fromHistory(restored),
                'info',
                strings.resumed(choice.slice(-6), restored.length),
              ),
            )
            setTranscriptRevision((revision) => revision + 1)
          } catch (error) {
            notice('error', error instanceof Error ? error.message : String(error))
          }
          forceRender((n) => n + 1)
          return
        }

        case 'config':
          notice('info', strings.configAt(runtime.configPath()))
          return

        case 'login':
          setSetup(true)
          return

        case 'logout': {
          const current = runtime.currentProviderId()
          if (!current) {
            notice('warn', strings.logoutNothing)
            return
          }
          if (!(await ask(strings.logoutAsk(current), strings.logoutAskBody, true))) return
          const removed = await runtime.logout()
          if (removed) notice('info', strings.loggedOut(removed))
          history.current = []
          setPromptHistory([])
          setTranscript(emptyTranscript())
          setTranscriptRevision((revision) => revision + 1)
          runtime.resetContext()
          setSetup(runtime.needsSetup())
          forceRender((n) => n + 1)
          return
        }

        case 'lang': {
          const choice = await pick(
            strings.titleLang,
            LANGS.map((entry) => ({ key: entry.key, label: entry.label })),
          )
          if (!choice) return
          await runtime.setLang(choice as Lang)
          setLang(choice as Lang)
          return
        }

        case 'skills': {
          const skills = runtime.listSkills()
          notice(
            'info',
            skills.length === 0
              ? strings.skillsEmpty
              : skills.map((skill) => `${skill.name} — ${skill.description}`).join('\n'),
          )
          return
        }

        case 'usage':
          notice(
            'info',
            `${runtime.usageReport()}\n${strings.sessionSummary(
              formatDuration(Date.now() - sessionStart.current),
              turns.current,
            )}`,
          )
          return

        case 'provider': {
          const items = runtime.listProviderItems()
          if (items.length === 0) {
            notice('warn', strings.providersEmpty)
            return
          }
          const choice = await pick(strings.titleProvider, items)
          if (!choice) return
          try {
            const ref = await runtime.useProvider(choice)
            notice('info', strings.providerSet(choice, ref))
          } catch (error) {
            notice('error', error instanceof Error ? error.message : String(error))
          }
          forceRender((n) => n + 1)
          return
        }

        case 'mcp': {
          const { connected, failed } = runtime.mcpSummary()
          notice('info', strings.mcpStatus(connected, failed))
          return
        }

        case 'theme': {
          const requested = rest[0]
          if (requested) {
            await applyAccent(requested)
            return
          }
          const choice = await pick(
            strings.titleAccent,
            Object.entries(PRESETS).map(([name, hex]) => ({ key: name, label: name, hint: hex })),
          )
          if (choice) await applyAccent(choice)
          return
        }

        case 'thinking': {
          const next = !runtime.getThinking()
          await runtime.setThinking(next)
          notice('info', strings.reasoning(next))
          forceRender((n) => n + 1)
          return
        }

        case 'effort': {
          const choice = await pick(
            strings.titleEffort,
            EFFORTS.map((effort) => ({ key: effort, label: effort })),
          )
          if (!choice) return
          await runtime.setEffort(choice as Effort)
          notice('info', strings.effortSet(choice))
          forceRender((n) => n + 1)
          return
        }

        case 'model': {
          const items = await runtime.listModelItems()
          if (items.length === 0) {
            notice('warn', strings.noModels)
            return
          }
          const choice = await pick(strings.titleModel, items)
          if (!choice) return
          await runtime.setModelRef(choice)
          notice('info', strings.modelSet(choice))
          forceRender((n) => n + 1)
          return
        }

        case 'bypass': {
          if (runtime.isBypassEnabled()) {
            runtime.setBypass(false)
            notice('info', strings.bypassOff)
            forceRender((n) => n + 1)
            return
          }
          if (!(await ask(strings.bypassAsk1, strings.bypassAsk1Body, true))) {
            notice('info', strings.bypassCancelled)
            return
          }
          if (!(await ask(strings.bypassAsk2, strings.bypassAsk2Body, true))) {
            notice('info', strings.bypassCancelled)
            return
          }
          runtime.setBypass(true)
          notice('warn', strings.bypassOn)
          forceRender((n) => n + 1)
          return
        }

        case 'prompt': {
          if (rest[0] === 'save') {
            const name = rest.slice(1).join(' ').trim()
            const body = lastUserText(history.current)
            if (!name) {
              notice('warn', strings.promptUsage)
              return
            }
            if (!body) {
              notice('warn', strings.promptNothing)
              return
            }
            await runtime.savePrompt(name, body)
            notice('info', strings.promptSaved(name))
            return
          }
          const items = await runtime.listPromptItems()
          if (items.length === 0) {
            notice('info', strings.promptsEmpty)
            return
          }
          const choice = await pick(strings.titlePrompts, items)
          if (!choice) return
          setInput(await runtime.readPrompt(choice))
          return
        }

        default: {
          const guess = closestCommand(command)
          notice(
            'warn',
            guess ? strings.didYouMean(command, guess.name) : strings.unknownCommand(command),
          )
        }
      }
    },
    [applyAccent, ask, exit, notice, pick, runtime, strings],
  )

  const enqueueNext = useCallback(
    (raw: string) => {
      const text = raw.trim()
      if (!text) return
      if (text.startsWith('/')) {
        void handleSlash(text)
        return
      }
      setTranscript((state) => pushUser(state, text))
      history.current = [...history.current, { role: 'user', content: [{ type: 'text', text }] }]
      void runAgent()
    },
    [handleSlash, runAgent],
  )

  const submit = useCallback(
    (raw: string) => {
      const text = raw.trim()
      if (!text) return
      if (text.startsWith('/')) {
        // Slash commands can run even while busy (e.g. /effort, /thinking);
        // queue-impacting commands defer until idle.
        setInput('')
        if (busy && NEEDS_IDLE.has(text.slice(1).split(/\s+/)[0] ?? '')) {
          queueRef.current = [...queueRef.current, text]
          setPendingCount(queueRef.current.length)
          return
        }
        void handleSlash(text)
        return
      }
      setPromptHistory((state) => appendInputHistory(state, text))
      setInput('')
      if (busy) {
        queueRef.current = [...queueRef.current, text]
        setPendingCount(queueRef.current.length)
        return
      }
      setTranscript((state) => pushUser(state, text))
      history.current = [...history.current, { role: 'user', content: [{ type: 'text', text }] }]
      void runAgent()
    },
    [busy, handleSlash, runAgent],
  )

  useInput((_char, key) => {
    if (key.tab && key.shift) {
      const next = runtime.cycleMode()
      notice('info', strings.modeChanged(strings.modeLabel[next] ?? next))
      forceRender((n) => n + 1)
      return
    }
    if (!key.escape) return
    if (busy && abort.current) {
      abort.current.abort()
      queueRef.current = []
      setPendingCount(0)
      notice('warn', strings.cancelled)
      return
    }
    if (overlay.kind === 'permission') {
      overlay.resolve('deny')
      setOverlay({ kind: 'none' })
      return
    }
    if (overlay.kind === 'confirm') {
      overlay.resolve(false)
      setOverlay({ kind: 'none' })
      return
    }
    if (overlay.kind === 'picker') {
      overlay.select('')
      setOverlay({ kind: 'none' })
      return
    }
    setInput('')
  })

  const shell = (children: React.ReactNode) => (
    <ThemeContext.Provider value={theme}>
      <StringsContext.Provider value={strings}>{children}</StringsContext.Provider>
    </ThemeContext.Provider>
  )

  if (lang === undefined) {
    return shell(
      <LanguagePicker
        onPick={(chosen) => {
          setLang(chosen)
          void runtime.setLang(chosen)
        }}
      />,
    )
  }

  if (setup) {
    return shell(
      <Onboarding
        onSubmit={async (url, key) => {
          const summary = await runtime.addProvider(url, key)
          setSetup(false)
          notice('info', `${summary}\n${strings.configAt(runtime.configPath())}`)
          return summary
        }}
      />,
    )
  }

  return shell(
    <Box flexDirection="column">
      <Logo />
      <Transcript key={transcriptRevision} bubbles={transcript.bubbles} />

      {overlay.kind === 'permission' && (
        <PermissionPrompt
          request={overlay.request}
          onDecide={(decision) => {
            overlay.resolve(decision)
            setOverlay({ kind: 'none' })
          }}
        />
      )}

      {overlay.kind === 'picker' && (
        <Picker
          title={overlay.title}
          items={overlay.items}
          onSelect={(key) => {
            overlay.select(key)
            setOverlay({ kind: 'none' })
          }}
          onCancel={() => {
            overlay.select('')
            setOverlay({ kind: 'none' })
          }}
        />
      )}

      {overlay.kind === 'confirm' && (
        <Confirm
          title={overlay.title}
          body={overlay.body}
          danger={overlay.danger}
          onAnswer={(yes) => {
            overlay.resolve(yes)
            setOverlay({ kind: 'none' })
          }}
        />
      )}

      {overlay.kind === 'none' && (
        <PromptInput
          value={input}
          onChange={setInput}
          onSubmit={submit}
          disabled={busy}
          pending={pendingCount}
          hint={busy ? strings.escCancel : undefined}
          history={promptHistory}
        />
      )}

      <StatusBar
        status={{
          modelRef: runtime.getModelRef() || strings.noModel,
          effort: runtime.getEffort(),
          thinking: runtime.getThinking(),
          usage: runtime.usageParts(),
          mcp: runtime.mcpSummary(),
          mode: runtime.getMode(),
          bypass: runtime.isBypassEnabled(),
          busy,
          sessionMs: Date.now() - sessionStart.current,
          turnMs: turnStart === null ? null : Date.now() - turnStart,
          context,
        }}
      />
    </Box>,
  )
}

function lastUserText(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const text = userText(message)
    if (text) return text
  }
  return ''
}

function inputHistoryFromMessages(messages: Message[]): string[] {
  return messages.reduce<string[]>((items, message) => {
    if (message.role !== 'user') return items
    return appendInputHistory(items, userText(message))
  }, [])
}

function userText(message: Message): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim()
}

// Copies text to the system clipboard using the platform's native CLI tool.
// macOS: pbcopy · Linux: wl-copy (Wayland) or xclip/xsel (X11).
// No external npm dependency required.
function copyToClipboard(text: string): void {
  const run = (cmd: string, args: string[]) =>
    execFileSync(cmd, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'] })
  if (process.platform === 'darwin') {
    try {
      run('pbcopy', [])
    } catch {
      /* pbcopy unavailable */
    }
    return
  }
  const candidates: Array<[string, string[]]> = [
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
  ]
  for (const [cmd, args] of candidates) {
    try {
      run(cmd, args)
      return
    } catch {
      /* try next */
    }
  }
}
