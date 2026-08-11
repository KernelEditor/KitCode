import { Box, Text, useApp, useInput, useWindowSize } from 'ink'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentEvent, AgentHooks, PermissionDecision, PermissionRequest } from '../core/types'
import { attachmentLabel, looksLikeAttachmentPath } from '../core/attachments'
import { parseMcpAddArgs } from '../mcp/add'
import type { McpAddError } from '../mcp/add'
import type { McpServerState } from '../mcp/client'
import type { ContentBlock, Effort, Message } from '../providers/types'
import { COMMANDS, closestCommand } from './commands'
import TextInput from 'ink-text-input'
import { useTheme } from './theme'
import { Confirm } from './components/Confirm'
import { LanguagePicker } from './components/LanguagePicker'
import { Onboarding } from './components/Onboarding'
import { PermissionPrompt } from './components/PermissionPrompt'
import { Picker } from './components/Picker'
import { PromptInput } from './components/PromptInput'
import { StatusBar } from './components/StatusBar'
import { TerminalViewport, liveTranscriptRows } from './components/TerminalViewport'
import { Transcript } from './components/Transcript'
import { appendInputHistory } from './history'
import { LANGS, StringsContext, stringsFor } from './i18n'
import type { Lang, Strings } from './i18n'
import { useTerminalInput } from './input'
import type { Runtime } from './runtime'
import { PRESETS, ThemeContext, makeTheme, resolveAccent } from './theme'
import { formatDuration } from './time'
import { applyEvents, emptyTranscript, fromHistory, pushNotice, pushUser } from './transcript'
import type { PickerItem } from './types'

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const STREAM_FRAME_MS = 50
const MAX_ATTACHMENTS = 8

type QueuedItem =
  | { kind: 'command'; line: string }
  | { kind: 'message'; text: string; content: ContentBlock[] }

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
  | {
      kind: 'textinput'
      title: string
      mask?: boolean
      resolve: (value: string | null) => void
      cancel?: () => void
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
  const { rows } = useWindowSize()
  const [transcript, setTranscript] = useState(() =>
    warnings.reduce((state, text) => pushNotice(state, 'warn', text), fromHistory(initialHistory)),
  )
  const [transcriptRevision, setTranscriptRevision] = useState(0)
  const [input, setInput] = useState('')
  const [promptHistory, setPromptHistory] = useState(() =>
    inputHistoryFromMessages(initialHistory),
  )
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [pendingCount, setPendingCount] = useState(0)
  const queueRef = useRef<QueuedItem[]>([])
  const slashQueueRef = useRef<Promise<void>>(Promise.resolve())
  const slashPendingRef = useRef(0)
  const drainQueueRef = useRef<() => void>(() => undefined)
  const [attachments, setAttachments] = useState<ContentBlock[]>([])
  const attachmentsRef = useRef<ContentBlock[]>([])
  const automaticAttachmentTask = useRef<Promise<boolean> | null>(null)
  const clipboardPasteTask = useRef<Promise<void> | null>(null)
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

  const replaceAttachments = useCallback((next: ContentBlock[]) => {
    attachmentsRef.current = next
    setAttachments(next)
  }, [])

  const appendAttachment = useCallback((block: ContentBlock): boolean => {
    if (attachmentsRef.current.length >= MAX_ATTACHMENTS) return false
    const next = [...attachmentsRef.current, block]
    attachmentsRef.current = next
    setAttachments(next)
    return true
  }, [])

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

  const theme = useMemo(() => makeTheme(accent), [accent])
  const strings = useMemo(() => stringsFor(lang), [lang])

  const notice = useCallback(
    (level: 'info' | 'warn' | 'error', text: string) => {
      flushTranscriptEvents()
      setTranscript((state) => pushNotice(state, level, text))
    },
    [flushTranscriptEvents],
  )

  useEffect(() => {
    const check = runtime.startupUpdateCheck()
    let active = true
    void check.then((result) => {
      if (active && result.status === 'available') {
        notice('info', strings.updateAvailable(result.latest, result.url))
      }
    })
    return () => {
      active = false
    }
  }, [notice, runtime, strings])

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

  const promptInput = useCallback(
    (title: string, mask?: boolean) =>
      new Promise<string | null>((resolve) => {
        setOverlay({ kind: 'textinput', title, mask, resolve, cancel: () => resolve(null) })
      }),
    [],
  )

  const runAgent = useCallback(async () => {
    if (busyRef.current) return
    const controller = new AbortController()
    abort.current = controller
    busyRef.current = true
    setBusy(true)
    setTurnStart(Date.now())
    turns.current += 1
    const hooks: AgentHooks = {
      onEvent: queueTranscriptEvent,
      requestPermission: (request) =>
        new Promise<PermissionDecision>((resolve) => {
          let settled = false
          const finish = (decision: PermissionDecision) => {
            if (settled) return
            settled = true
            controller.signal.removeEventListener('abort', cancel)
            resolve(decision)
          }
          const cancel = () => {
            setOverlay((current) =>
              current.kind === 'permission' && current.resolve === finish
                ? { kind: 'none' }
                : current,
            )
            finish('deny')
          }
          if (controller.signal.aborted) {
            finish('deny')
            return
          }
          controller.signal.addEventListener('abort', cancel, { once: true })
          setOverlay({ kind: 'permission', request, resolve: finish })
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
      busyRef.current = false
      setBusy(false)
      setTurnStart(null)
      drainQueueRef.current()
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
      const body = line.slice(1).trim()
      const firstSpace = body.search(/\s/)
      const command = (firstSpace === -1 ? body : body.slice(0, firstSpace)).toLowerCase()
      const rawRest = firstSpace === -1 ? '' : body.slice(firstSpace).trim()
      const rest = rawRest ? rawRest.split(/\s+/) : []
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
          await runtime.newSession()
          history.current = []
          replaceAttachments([])
          setPromptHistory([])
          setTranscript(emptyTranscript())
          setTranscriptRevision((revision) => revision + 1)
          sessionStart.current = Date.now()
          turns.current = 0
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
            sessionStart.current = Date.now()
            turns.current = 0
          } catch (error) {
            notice('error', error instanceof Error ? error.message : String(error))
          }
          forceRender((n) => n + 1)
          return
        }

        case 'sessions': {
          const items = await runtime.listSessionItems()
          if (items.length === 0) {
            notice('info', strings.sessionsEmpty)
            return
          }

          let action: string | undefined = rest[0]?.toLowerCase()
          if (action === 'list') {
            notice(
              'info',
              items.map((item) => `${item.label}${item.hint ? ` — ${item.hint}` : ''}`).join('\n'),
            )
            return
          }

          if (action === 'delete' && rest.length === 2 && rest[1]?.toLowerCase() === 'all') {
            if (!(await ask(strings.sessionDeleteAllAsk, strings.sessionDeleteAllAskBody, true))) {
              return
            }
            if (
              !(await ask(
                strings.sessionDeleteAllFinalAsk,
                strings.sessionDeleteAllFinalBody,
                true,
              ))
            ) {
              return
            }
            try {
              const result = await runtime.deleteAllSessions()
              history.current = []
              replaceAttachments([])
              setPromptHistory([])
              const message =
                result.failed.length === 0
                  ? strings.sessionsDeletedAll(result.deleted)
                  : [
                      strings.sessionsDeleteAllFailed(result.deleted, result.failed.length),
                      ...result.failed.slice(0, 5).map((failure) => `${failure.id}: ${failure.error}`),
                    ].join('\n')
              setTranscript(
                pushNotice(
                  emptyTranscript(),
                  result.failed.length === 0 ? 'info' : 'error',
                  message,
                ),
              )
              setTranscriptRevision((revision) => revision + 1)
              sessionStart.current = Date.now()
              turns.current = 0
            } catch (error) {
              notice('error', error instanceof Error ? error.message : String(error))
            }
            forceRender((n) => n + 1)
            return
          }

          let id = action ? rest[1] : undefined
          if (!id) id = (await pick(strings.titleSessions, items)) ?? undefined
          if (!id) return
          const matches = items.filter((item) => item.key === id || item.key.includes(id as string))
          if (matches.length !== 1) {
            notice('warn', `No saved session matches "${id}".`)
            return
          }
          id = matches[0]?.key ?? id

          if (!action) {
            action =
              (await pick(strings.titleSessionAction, [
                { key: 'resume', label: strings.sessionActionResume },
                { key: 'rename', label: strings.sessionActionRename },
                { key: 'delete', label: strings.sessionActionDelete },
                { key: 'export', label: strings.sessionActionExport },
              ])) ?? undefined
          }
          if (!action) return

          try {
            if (action === 'resume') {
              const restored = await runtime.resumeSession(id)
              history.current = restored
              replaceAttachments([])
              setPromptHistory(inputHistoryFromMessages(restored))
              setTranscript(
                pushNotice(fromHistory(restored), 'info', strings.resumed(id.slice(-6), restored.length)),
              )
              setTranscriptRevision((revision) => revision + 1)
              sessionStart.current = Date.now()
              turns.current = 0
            } else if (action === 'rename') {
              const title = rest.slice(2).join(' ').trim()
              if (!title) {
                setInput(`/sessions rename ${id} `)
                notice('info', strings.sessionRenameUsage)
                return
              }
              notice('info', strings.sessionRenamed(await runtime.renameSession(id, title)))
            } else if (action === 'delete') {
              if (!(await ask(`${strings.sessionActionDelete}: ${id.slice(-6)}?`, strings.sessionDeleteAsk, true))) {
                return
              }
              const result = await runtime.deleteSession(id)
              const deletedMessage = strings.sessionDeleted(result.id.slice(-6))
              if (result.wasActive) {
                history.current = []
                replaceAttachments([])
                setPromptHistory([])
                setTranscript(pushNotice(emptyTranscript(), 'info', deletedMessage))
                setTranscriptRevision((revision) => revision + 1)
                sessionStart.current = Date.now()
                turns.current = 0
                void runtime.persist([]).catch((error) =>
                  notice('error', error instanceof Error ? error.message : String(error)),
                )
              } else {
                notice('info', deletedMessage)
              }
            } else if (action === 'export') {
              const destination = unquoteArg(rest.slice(2).join(' ').trim()) || undefined
              notice('info', strings.sessionExported(await runtime.exportSession(id, destination)))
            } else {
              notice('warn', 'Usage: /sessions [list|rename|delete [all]|export]')
              return
            }
          } catch (error) {
            notice('error', error instanceof Error ? error.message : String(error))
          }
          forceRender((n) => n + 1)
          return
        }

        case 'undo': {
          try {
            const result = await runtime.undoLastCheckpoint()
            if (!result.found) {
              notice('info', strings.undoNothing)
              return
            }
            const lines = [strings.undoResult(result.restored.length, result.removed.length)]
            if (result.conflicts.length > 0) {
              lines.push(strings.undoConflicts(result.conflicts))
            }
            if (result.failed.length > 0) {
              lines.push(
                strings.undoFailed(
                  result.failed.map((failure) => `${failure.path}: ${failure.error}`),
                ),
              )
            }
            notice(
              result.conflicts.length > 0 || result.failed.length > 0 ? 'warn' : 'info',
              lines.join('\n'),
            )
          } catch (error) {
            notice('error', error instanceof Error ? error.message : String(error))
          }
          return
        }

        case 'config':
          notice('info', strings.configAt(runtime.configPath()))
          return

        case 'update': {
          const result = await runtime.checkForUpdates()
          if (result.status === 'available') {
            notice('info', strings.updateAvailable(result.latest, result.url))
          } else if (result.status === 'current') {
            notice('info', strings.updateCurrent(result.current))
          } else {
            notice('warn', strings.updateFailed(result.reason))
          }
          return
        }

        case 'login':
          setSetup(true)
          return

        case 'logout': {
          const providers = runtime.listProviderItems()
          if (providers.length === 0) {
            notice('warn', strings.logoutNothing)
            return
          }
          let providerId: string | undefined = rest[0]
          if (!providerId) {
            providerId =
              providers.length === 1
                ? providers[0]?.key
                : ((await pick(strings.titleLogout, providers)) ?? undefined)
          }
          if (!providerId) return
          if (!providers.some((provider) => provider.key === providerId)) {
            notice('warn', `Provider "${providerId}" is not configured.`)
            return
          }
          if (!(await ask(strings.logoutAsk(providerId), strings.logoutAskBody, true))) return
          try {
            const result = await runtime.logout(providerId)
            const message = `${strings.loggedOut(result.removed)}${result.nextModel ? `\n${strings.modelSet(result.nextModel)}` : ''}`
            if (result.wasActive) {
              await runtime.newSession()
              history.current = []
              replaceAttachments([])
              setPromptHistory([])
              setTranscript(pushNotice(emptyTranscript(), 'info', message))
              setTranscriptRevision((revision) => revision + 1)
              sessionStart.current = Date.now()
              turns.current = 0
              void runtime.persist([]).catch((error) =>
                notice('error', error instanceof Error ? error.message : String(error)),
              )
            } else {
              notice('info', message)
            }
          } catch (error) {
            notice('error', error instanceof Error ? error.message : String(error))
          }
          setSetup(runtime.needsSetup())
          forceRender((n) => n + 1)
          return
        }

        case 'key': {
          const providers = runtime.listProviderItems()
          if (providers.length === 0) {
            notice('warn', strings.logoutNothing)
            return
          }
          let providerId: string | undefined = rest[0]
          if (!providerId) {
            providerId =
              providers.length === 1
                ? providers[0]?.key
                : ((await pick(strings.titleKeyChange, providers)) ?? undefined)
          }
          if (!providerId) return
          if (!providers.some((provider) => provider.key === providerId)) {
            notice('warn', `Provider "${providerId}" is not configured.`)
            return
          }
          if (!(await ask(strings.keyChangeAsk(providerId), strings.keyChangeAskBody, true))) return
          const newKey = await promptInput(strings.apiKey, true)
          if (!newKey || newKey.trim() === '') {
            notice('warn', 'Empty key — nothing changed.')
            return
          }
          try {
            await runtime.changeProviderKey(providerId, newKey.trim())
            notice('info', strings.keyChanged(providerId))
          } catch (error) {
            notice('error', error instanceof Error ? error.message : String(error))
          }
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
          const action = rest[0]?.toLowerCase()

          if (action === 'install') {
            const source = rest.slice(1).join(' ').trim()
            if (!source) {
              notice('warn', strings.skillsInstallUsage)
              return
            }
            notice('info', strings.skillsInstalling(source))
            try {
              const result = await runtime.installSkill(source)
              notice('info', strings.skillsInstalled(result.name, result.source))
              
              forceRender((n) => n + 1)
            } catch (error) {
              notice('error', error instanceof Error ? error.message : String(error))
            }
            return
          }

          const skills = runtime.listSkills()
          if (skills.length === 0) {
            notice('info', strings.skillsEmpty)
            return
          }
          const items: PickerItem[] = skills.map((skill) => ({
            key: skill.name,
            label: skill.name,
            hint: skill.description || undefined,
          }))
          const choice = await pick(strings.titleSkills, items)
          if (!choice) return
          try {
            const body = await runtime.loadSkill(choice)
            
            setTranscript((state) => pushUser(state, `skill: ${choice}\n${body}`))
            history.current = [...history.current, { role: 'user', content: [{ type: 'text', text: body }] }]
            void runAgent()
          } catch (error) {
            notice('error', error instanceof Error ? error.message : String(error))
          }
          return
        }

        case 'usage': {
          const balance = await runtime.providerBalance()
          const providerBalances = balance?.filter((item) => item.kind === 'balance') ?? []
          const keyLimits = balance?.filter((item) => item.kind === 'key-limit') ?? []
          const balanceLines = [
            providerBalances.length > 0
              ? strings.providerBalance(formatBalances(providerBalances))
              : null,
            keyLimits.length > 0
              ? strings.providerKeyRemaining(formatBalances(keyLimits))
              : null,
          ]
          notice(
            'info',
            [
              runtime.usageReport(),
              runtime.rateLimitsReport(),
              ...balanceLines,
              strings.sessionSummary(
                formatDuration(Date.now() - sessionStart.current),
                turns.current,
              ),
            ]
              .filter((line): line is string => line !== null)
              .join('\n'),
          )
          return
        }

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
          const action = rest[0]?.toLowerCase()
          if (action === 'add') {
            const parsed = parseMcpAddArgs(rest.slice(1))
            if (!parsed.ok) {
              const problem = mcpAddProblem(strings, parsed.error)
              notice(
                'warn',
                parsed.error === 'usage' ? problem : `${problem}\n${strings.mcpAddUsage}`,
              )
              return
            }
            if (runtime.mcpServers().some((state) => state.name === parsed.name)) {
              notice('warn', strings.mcpExists(parsed.name))
              return
            }

            notice('info', strings.mcpConnecting(parsed.name))
            try {
              const state = await runtime.addMcpServer(parsed.name, parsed.config)
              notice('info', strings.mcpAdded(state.name, state.toolCount))
            } catch (error) {
              notice(
                'error',
                strings.mcpAddFailed(
                  parsed.name,
                  error instanceof Error ? error.message : String(error),
                ),
              )
            }
            forceRender((n) => n + 1)
            return
          }

          if (action === 'delete') {
            const states = runtime.mcpServers()
            let name: string | undefined = rest[1]
            if (!name) {
              if (states.length === 0) {
                notice('info', strings.mcpEmpty)
                return
              }
              name =
                (await pick(
                  strings.titleMcpDelete,
                  states.map((state) => ({
                    key: state.name,
                    label: state.name,
                    hint: `${strings.mcpState[state.status] ?? state.status} · ${strings.mcpTools(state.toolCount)}`,
                  })),
                )) ?? undefined
              if (!name) return
            }
            if (!states.some((state) => state.name === name)) {
              notice('warn', strings.mcpNotFound(name))
              return
            }

            try {
              await runtime.removeMcpServer(name)
              notice('info', strings.mcpDeleted(name))
            } catch (error) {
              notice(
                'error',
                strings.mcpDeleteFailed(
                  name,
                  error instanceof Error ? error.message : String(error),
                ),
              )
            }
            forceRender((n) => n + 1)
            return
          }

          if (action === 'enable' || action === 'disable') {
            const states = runtime.mcpServers()
            const enabling = action === 'enable'
            const candidates = states.filter((state) =>
              enabling ? state.status === 'disabled' : state.status !== 'disabled',
            )
            let name: string | undefined = rest[1]
            if (!name) {
              if (candidates.length === 0) {
                notice('info', strings.mcpEmpty)
                return
              }
              name =
                (await pick(
                  enabling ? strings.titleMcpEnable : strings.titleMcpDisable,
                  candidates.map((state) => ({
                    key: state.name,
                    label: state.name,
                    hint: strings.mcpState[state.status] ?? state.status,
                  })),
                )) ?? undefined
            }
            if (!name) return
            if (!states.some((state) => state.name === name)) {
              notice('warn', strings.mcpNotFound(name))
              return
            }
            try {
              const state = await runtime.setMcpEnabled(name, enabling)
              if (enabling && state.status === 'error') {
                notice('error', strings.mcpToggleFailed(name, state.error ?? 'connection failed'))
              } else {
                notice(
                  'info',
                  enabling ? strings.mcpEnabled(name, state.toolCount) : strings.mcpDisabled(name),
                )
              }
            } catch (error) {
              notice(
                'error',
                strings.mcpToggleFailed(
                  name,
                  error instanceof Error ? error.message : String(error),
                ),
              )
            }
            forceRender((n) => n + 1)
            return
          }

          if (action && action !== 'list') {
            notice('warn', strings.mcpAddUsage)
            return
          }

          const { connected, failed } = runtime.mcpSummary()
          const states = runtime.mcpServers()
          const lines = states.map((state) => mcpStateLine(strings, state))
          notice(
            failed > 0 ? 'warn' : 'info',
            [
              strings.mcpStatus(connected, failed),
              ...(lines.length > 0 ? lines : [strings.mcpEmpty]),
              strings.mcpAddUsage,
            ].join('\n'),
          )
          return
        }

        case 'attach': {
          if (rawRest.toLowerCase() === 'clear') {
            replaceAttachments([])
            notice('info', strings.attachmentsCleared)
            return
          }
          if (rawRest.toLowerCase() === 'clipboard') {
            if (attachmentsRef.current.length >= MAX_ATTACHMENTS) {
              notice('warn', `At most ${MAX_ATTACHMENTS} attachments can be queued for one message.`)
              return
            }
            if (clipboardPasteTask.current) return
            const task = runtime
              .loadClipboardImage()
              .then((block) => {
                if (appendAttachment(block)) {
                  notice(
                    'info',
                    strings.attachmentAdded(attachmentLabel(block) ?? 'clipboard image'),
                  )
                }
              })
              .catch((error) =>
                notice('error', error instanceof Error ? error.message : String(error)),
              )
            clipboardPasteTask.current = task
            try {
              await task
            } finally {
              if (clipboardPasteTask.current === task) clipboardPasteTask.current = null
            }
            return
          }
          if (!rawRest) {
            notice('info', strings.attachUsage)
            return
          }
          if (attachmentsRef.current.length >= MAX_ATTACHMENTS) {
            notice('warn', `At most ${MAX_ATTACHMENTS} attachments can be queued for one message.`)
            return
          }
          try {
            const block = await runtime.loadAttachment(rawRest)
            if (appendAttachment(block)) {
              notice('info', strings.attachmentAdded(attachmentLabel(block) ?? 'attachment'))
            }
          } catch (error) {
            notice('error', error instanceof Error ? error.message : String(error))
          }
          return
        }

        case 'compact': {
          const controller = new AbortController()
          abort.current = controller
          busyRef.current = true
          setBusy(true)
          setTurnStart(Date.now())
          notice('info', strings.compactStarting)
          try {
            const result = await runtime.compact(history.current, controller.signal)
            if (!result.compacted) {
              notice('info', strings.compactNothing)
            } else {
              history.current = result.history
              setPromptHistory(inputHistoryFromMessages(result.history))
              setTranscript(
                pushNotice(fromHistory(result.history), 'info', strings.compactDone(result.removedMessages)),
              )
              setTranscriptRevision((revision) => revision + 1)
              await runtime.persist(result.history)
            }
          } catch (error) {
            if (!controller.signal.aborted) {
              notice('error', error instanceof Error ? error.message : String(error))
            }
          } finally {
            abort.current = null
            busyRef.current = false
            setBusy(false)
            setTurnStart(null)
          }
          forceRender((n) => n + 1)
          return
        }

        case 'subagents': {
          const agents = runtime.activeAgentsList()
          if (agents.length === 0) {
            notice('info', strings.subagentsStatus(0))
            return
          }
          const lines = agents.map((a, i) => {
            const label = a.description || `subagent ${i + 1}`
            const progress = a.progress.length > 0 ? ` · ${a.progress[a.progress.length - 1]}` : ''
            return `${label}${progress}`
          })
          notice('info', lines.join('\n'))
          return
        }

        case 'checker':
          try {
            notice('info', await runtime.checkerReport())
          } catch (error) {
            notice('error', error instanceof Error ? error.message : String(error))
          }
          return

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

        case 'budget': {
          const current = runtime.getMaxTokensPerTurn()
          if (rest[0]) {
            const tokens = Number(rest[0])
            if (tokens === 0) {
              await runtime.setMaxTokensPerTurn(0)
              notice('info', strings.budgetUnlimited)
              forceRender((n) => n + 1)
            } else if (!Number.isInteger(tokens) || tokens < 1_000 || tokens > 10_000_000) {
              notice('warn', strings.budgetInvalid)
            } else {
              await runtime.setMaxTokensPerTurn(tokens)
              notice('info', strings.budgetSet(tokens))
              forceRender((n) => n + 1)
            }
          } else {
            notice('info', current === 0 ? strings.budgetUnlimited : strings.budgetCurrent(current))
          }
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
          const sub = rest[0]?.toLowerCase()

          if (sub === 'save') {
            const name = rest.slice(1).join(' ').trim()
            if (name) {
              
              const body = lastUserText(history.current)
              if (!body) {
                notice('warn', strings.promptNothing)
                return
              }
              await runtime.savePrompt(name, body)
              notice('info', strings.promptSaved(name))
              return
            }
            
            const recent = recentUserMessages(history.current, 20)
            if (recent.length > 0) {
              const items: PickerItem[] = recent.map((text, i) => ({
                key: `__recent_${i}__`,
                label: text.length > 60 ? `${text.slice(0, 60)}…` : text,
                hint: text.length > 60 ? undefined : undefined,
              }))
              items.push({ key: '__custom__', label: '— type a custom prompt —' })
              const choice = await pick(strings.titlePrompts, items)
              if (!choice) return
              if (choice === '__custom__') {
                setInput('/prompt save ')
                return
              }
              const index = parseInt(choice.replace('__recent_', '').replace('__', ''), 10)
              const body = recent[index] ?? ''
              if (!body) {
                notice('warn', strings.promptNothing)
                return
              }
              if (!(await ask(strings.promptSaveAsk, strings.promptSaveAskBody))) return
              
              const defaultName = body.split(/\s+/).slice(0, 4).join('-').replace(/[^a-z0-9-]/gi, '').toLowerCase()
              const nameInput = `${defaultName || 'prompt'}`
              
              await runtime.savePrompt(nameInput, body)
              notice('info', `${strings.promptSaved(nameInput)}\nRename the file if you want a different name.`)
              return
            }
            notice('warn', strings.promptNothing)
            return
          }

          if (sub === 'delete') {
            const name = rest.slice(1).join(' ').trim()
            if (name) {
              try {
                await runtime.deletePrompt(name)
                notice('info', strings.promptDeleted(name))
              } catch (error) {
                notice('error', error instanceof Error ? error.message : String(error))
              }
              return
            }
            const items = await runtime.listPromptItems()
            if (items.length === 0) {
              notice('info', strings.promptsEmpty)
              return
            }
            const choice = await pick(strings.titlePrompts, items)
            if (!choice) return
            if (!(await ask(strings.promptDeleteUsage.replace('Usage: ', '').replace('<name>', choice || '') + '?', strings.sessionDeleteAsk, true))) return
            try {
              await runtime.deletePrompt(choice)
              notice('info', strings.promptDeleted(choice))
            } catch (error) {
              notice('error', error instanceof Error ? error.message : String(error))
            }
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
    [applyAccent, appendAttachment, ask, exit, notice, pick, replaceAttachments, runtime, strings],
  )

  const runSlash = useCallback(
    (line: string) => {
      slashPendingRef.current += 1
      const task = slashQueueRef.current.catch(() => undefined).then(() => handleSlash(line))
      slashQueueRef.current = task
      void task.catch((error) =>
        notice('error', error instanceof Error ? error.message : String(error)),
      )
      const finished = () => {
        slashPendingRef.current = Math.max(0, slashPendingRef.current - 1)
        drainQueueRef.current()
      }
      void task.then(finished, finished)
    },
    [handleSlash, notice],
  )

  const enqueueNext = useCallback(
    (item: QueuedItem) => {
      if (item.kind === 'command') {
        runSlash(item.line)
        return
      }
      setTranscript((state) => pushUser(state, userDisplay(item.text, item.content)))
      history.current = [...history.current, { role: 'user', content: item.content }]
      void runAgent()
    },
    [runAgent, runSlash],
  )

  const drainQueue = useCallback(() => {
    if (busyRef.current || slashPendingRef.current > 0) return
    const [next, ...remaining] = queueRef.current
    if (!next) {
      setPendingCount(0)
      return
    }
    queueRef.current = remaining
    setPendingCount(remaining.length)
    queueMicrotask(() => enqueueNext(next))
  }, [enqueueNext])
  drainQueueRef.current = drainQueue

  const tryQueueAutomaticAttachment = useCallback(
    (requestedPath: string): Promise<boolean> => {
      if (!looksLikeAttachmentPath(requestedPath)) return Promise.resolve(false)
      if (automaticAttachmentTask.current) {
        return automaticAttachmentTask.current.then(() => false)
      }
      if (attachmentsRef.current.length >= MAX_ATTACHMENTS) {
        notice('warn', `At most ${MAX_ATTACHMENTS} attachments can be queued for one message.`)
        return Promise.resolve(true)
      }

      const task = runtime
        .loadAutomaticAttachment(requestedPath)
        .then((block) => {
          if (!block) return false
          if (!appendAttachment(block)) {
            notice('warn', `At most ${MAX_ATTACHMENTS} attachments can be queued for one message.`)
            return true
          }
          notice('info', strings.attachmentAdded(attachmentLabel(block) ?? 'attachment'))
          return true
        })
        .catch((error) => {
          notice('error', error instanceof Error ? error.message : String(error))
          return true
        })
      automaticAttachmentTask.current = task
      void task.finally(() => {
        if (automaticAttachmentTask.current === task) automaticAttachmentTask.current = null
      })
      return task
    },
    [appendAttachment, notice, runtime, strings],
  )

  const pasteClipboardImage = useCallback(() => {
    if (clipboardPasteTask.current) return
    if (attachmentsRef.current.length >= MAX_ATTACHMENTS) {
      notice('warn', `At most ${MAX_ATTACHMENTS} attachments can be queued for one message.`)
      return
    }
    const task = runtime
      .loadClipboardImage()
      .then((block) => {
        if (!appendAttachment(block)) {
          notice('warn', `At most ${MAX_ATTACHMENTS} attachments can be queued for one message.`)
          return
        }
        notice('info', strings.attachmentAdded(attachmentLabel(block) ?? 'clipboard image'))
      })
      .catch((error) => notice('error', error instanceof Error ? error.message : String(error)))
    clipboardPasteTask.current = task
    void task.finally(() => {
      if (clipboardPasteTask.current === task) clipboardPasteTask.current = null
    })
  }, [appendAttachment, notice, runtime, strings])

  const submit = useCallback(
    async (raw: string) => {
      const pendingAttachments = [automaticAttachmentTask.current, clipboardPasteTask.current].filter(
        (task): task is Promise<boolean> | Promise<void> => task !== null,
      )
      const detachedInput = pendingAttachments.length > 0
      if (detachedInput) {
        
        
        setInput('')
        await Promise.all(pendingAttachments)
      }
      const text = raw.trim()
      const submitSlash = () => {
        
        
        if (!detachedInput) setInput('')
        if (busyRef.current || slashPendingRef.current > 0) {
          queueRef.current = [...queueRef.current, { kind: 'command', line: text }]
          setPendingCount(queueRef.current.length)
          return
        }
        runSlash(text)
      }

      if (isKnownSlashCommand(text)) {
        submitSlash()
        return
      }
      if (text && looksLikeAttachmentPath(text) && (await tryQueueAutomaticAttachment(text))) {
        if (!detachedInput) setInput('')
        return
      }
      if (text.startsWith('/')) {
        submitSlash()
        return
      }
      const queuedAttachments = attachmentsRef.current
      if (!text && queuedAttachments.length === 0) return
      if (text) setPromptHistory((state) => appendInputHistory(state, text))
      if (!detachedInput) setInput('')
      const content: ContentBlock[] = [
        ...(text ? ([{ type: 'text', text }] as ContentBlock[]) : []),
        ...queuedAttachments,
      ]
      replaceAttachments([])
      const item: QueuedItem = { kind: 'message', text, content }
      if (busyRef.current || slashPendingRef.current > 0) {
        queueRef.current = [...queueRef.current, item]
        setPendingCount(queueRef.current.length)
        return
      }
      setTranscript((state) => pushUser(state, userDisplay(text, content)))
      history.current = [...history.current, { role: 'user', content }]
      void runAgent()
    },
    [replaceAttachments, runAgent, runSlash, tryQueueAutomaticAttachment],
  )

  useTerminalInput((_char, key) => {
    if (key.tab && key.shift) {
      const next = runtime.cycleMode()
      notice('info', strings.modeChanged(strings.modeLabel[next] ?? next))
      forceRender((n) => n + 1)
      return
    }
    if (!key.escape) return
    if (input !== '') {
      setInput('')
      return
    }
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
    <TerminalViewport rows={rows}>
      <Transcript
        key={transcriptRevision}
        bubbles={transcript.bubbles}
        workspace={runtime.cwd}
        maxLiveRows={liveTranscriptRows(rows)}
      />

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

      {overlay.kind === 'textinput' && (
        <TextInputOverlay
          title={overlay.title}
          mask={overlay.mask}
          onAnswer={(value) => {
            overlay.resolve(value)
            setOverlay({ kind: 'none' })
          }}
          onCancel={() => {
            overlay.cancel?.()
            setOverlay({ kind: 'none' })
          }}
        />
      )}

      {overlay.kind === 'none' && (
        <PromptInput
          value={input}
          onChange={setInput}
          onSubmit={submit}
          onPastePath={tryQueueAutomaticAttachment}
          onPasteImage={pasteClipboardImage}
          disabled={busy}
          pending={pendingCount}
          hint={busy ? strings.escCancel : undefined}
          history={promptHistory}
          attachments={attachments.flatMap((block) => {
            const label = attachmentLabel(block)
            return label ? [label] : []
          })}
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
          activeAgents: runtime.activeAgentsCount(),
          context,
        }}
      />
    </TerminalViewport>,
  )
}

function TextInputOverlay({
  title,
  mask,
  onAnswer,
  onCancel,
}: {
  title: string
  mask?: boolean
  onAnswer: (value: string | null) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState('')
  const theme = useTheme()

  const submit = useCallback(() => {
    onAnswer(value || null)
  }, [value, onAnswer])

  useInput((_input, key) => {
    if (key.escape) onCancel()
  })

  return (
    <Box flexDirection="column">
      <Text dimColor>{title}</Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={submit}
        mask={mask ? '•' : undefined}
      />
      <Box marginTop={1}>
        <Text dimColor color={theme.accent}>enter submit · esc cancel</Text>
      </Box>
    </Box>
  )
}

function isKnownSlashCommand(line: string): boolean {
  if (!line.startsWith('/')) return false
  const [name = ''] = line.slice(1).trim().toLowerCase().split(/\s+/)
  return name === 'quit' || COMMANDS.some((command) => command.name === name)
}

function mcpAddProblem(strings: Strings, error: McpAddError): string {
  switch (error) {
    case 'invalid-name':
      return strings.mcpAddInvalidName
    case 'invalid-url':
      return strings.mcpAddInvalidUrl
    case 'http-args':
      return strings.mcpAddHttpArgs
    case 'usage':
      return strings.mcpAddUsage
  }
}

function mcpStateLine(strings: Strings, state: McpServerState): string {
  const mark = state.status === 'connected' ? '●' : state.status === 'error' ? '✗' : '○'
  const status = strings.mcpState[state.status] ?? state.status
  const tools = state.status === 'connected' ? ` · ${strings.mcpTools(state.toolCount)}` : ''
  const error = state.error ? ` · ${state.error}` : ''
  return `${mark} ${state.name} — ${status}${tools}${error}`
}

function formatBalances(
  balances: Array<{ amount: string; currency: string }>,
): string {
  return balances.map((item) => `${item.amount} ${item.currency}`).join(' · ')
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

function recentUserMessages(messages: Message[], max: number): string[] {
  const results: string[] = []
  for (let index = messages.length - 1; index >= 0 && results.length < max; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const text = userText(message)
    if (text) results.unshift(text)
  }
  return results
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

function userDisplay(text: string, content: ContentBlock[]): string {
  const labels = content.flatMap((block) => {
    const label = attachmentLabel(block)
    return label ? [`📎 ${label}`] : []
  })
  return [text, ...labels].filter(Boolean).join('\n')
}

function unquoteArg(value: string): string {
  if (value.length < 2) return value
  const first = value[0]
  const last = value.at(-1)
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? value.slice(1, -1)
    : value
}
