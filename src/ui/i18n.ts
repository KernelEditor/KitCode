import { createContext, useContext } from 'react'

export type Lang = 'en' | 'ru'

export const LANGS: { key: Lang; label: string }[] = [
  { key: 'en', label: 'English' },
  { key: 'ru', label: 'Русский' },
]

export interface Strings {
  hint: string
  noProvider: string

  onboardIntro: string
  onboardExamples: string
  baseUrl: string
  apiKey: string
  detecting: string

  placeholder: string
  working: string
  suggestHelp: string
  more: (count: number) => string

  allowOnce: string
  always: string
  deny: string
  yes: string
  noDefault: string

  noMatches: string
  pickerHelp: (shown: number, total: number) => string

  noModel: string
  busy: string
  sessionFor: (elapsed: string) => string
  workingFor: (elapsed: string) => string
  titleProvider: string
  titleLogout: string
  titleSessions: string
  titleSessionAction: string
  resumed: (id: string, count: number) => string
  sessionsEmpty: string
  providerSet: (id: string, model: string) => string
  providersEmpty: string
  sessionSummary: (elapsed: string, turns: number) => string
  providerBalance: (balances: string) => string
  providerKeyRemaining: (balances: string) => string
  noThink: string
  mcpFailed: (count: number) => string

  escCancel: string
  escHelp: string
  cancelled: string
  queued: (count: number) => string
  configAt: (path: string) => string
  skillsEmpty: string
  mcpStatus: (connected: number, failed: number) => string
  mcpEmpty: string
  mcpAddUsage: string
  mcpAddInvalidName: string
  mcpAddInvalidUrl: string
  mcpAddHttpArgs: string
  mcpExists: (name: string) => string
  mcpConnecting: (name: string) => string
  mcpAdded: (name: string, tools: number) => string
  mcpAddFailed: (name: string, error: string) => string
  mcpDeleted: (name: string) => string
  mcpDeleteFailed: (name: string, error: string) => string
  mcpNotFound: (name: string) => string
  mcpTools: (count: number) => string
  mcpEnabled: (name: string, tools: number) => string
  mcpDisabled: (name: string) => string
  mcpToggleFailed: (name: string, error: string) => string
  mcpState: Record<string, string>
  attachUsage: string
  attachmentAdded: (name: string) => string
  attachmentsCleared: string
  compactNothing: string
  compactDone: (count: number) => string
  sessionRenameUsage: string
  sessionRenamed: (title: string) => string
  sessionDeleteAsk: string
  sessionDeleted: (id: string) => string
  sessionDeleteAllAsk: string
  sessionDeleteAllAskBody: string
  sessionDeleteAllFinalAsk: string
  sessionDeleteAllFinalBody: string
  sessionsDeletedAll: (count: number) => string
  sessionsDeleteAllFailed: (deleted: number, failed: number) => string
  sessionExported: (path: string) => string
  sessionActionResume: string
  sessionActionRename: string
  sessionActionDelete: string
  sessionActionExport: string
  updateAvailable: (version: string, url: string) => string
  accentSet: (name: string, hex: string) => string
  reasoning: (on: boolean) => string
  effortSet: (value: string) => string
  modelSet: (value: string) => string
  noModels: string
  bypassOff: string
  bypassAsk1: string
  bypassAsk1Body: string
  bypassAsk2: string
  bypassAsk2Body: string
  bypassCancelled: string
  bypassOn: string
  logoutAsk: (provider: string) => string
  logoutAskBody: string
  loggedOut: (provider: string) => string
  logoutNothing: string
  promptUsage: string
  promptNothing: string
  promptSaved: (name: string) => string
  promptsEmpty: string
  unknownCommand: (name: string) => string
  didYouMean: (typed: string, guess: string) => string
  undoNothing: string
  undoResult: (restored: number, removed: number) => string
  undoConflicts: (paths: string[]) => string
  undoFailed: (failures: string[]) => string

  titleAccent: string
  titleEffort: string
  titleModel: string
  titlePrompts: string
  titleLang: string
  titleMcpDelete: string
  titleMcpEnable: string
  titleMcpDisable: string
  modeLabel: Record<string, string>
  modeChanged: (label: string) => string

  cmd: Record<string, string>
}

const en: Strings = {
  hint: 'type / for commands',
  noProvider: "no provider yet — let's add one",

  onboardIntro: 'Paste any OpenAI-compatible or Anthropic base URL, then its API key.',
  onboardExamples: 'e.g. https://openrouter.ai/api/v1 · https://api.anthropic.com',
  baseUrl: 'base url › ',
  apiKey: 'api key › ',
  detecting: 'detecting provider…',

  placeholder: 'ask, or / for commands',
  working: 'working…',
  suggestHelp: '↑↓ move · tab complete · enter run',
  more: (count) => `… ${count} more`,

  allowOnce: 'allow once',
  always: 'always',
  deny: 'deny',
  yes: 'yes',
  noDefault: 'no (default)',

  noMatches: 'no matches',
  pickerHelp: (shown, total) => `${shown} of ${total} · ↑↓ move · enter pick · esc cancel`,

  noModel: 'no model',
  busy: 'working',
  sessionFor: (elapsed) => `up ${elapsed}`,
  workingFor: (elapsed) => `working ${elapsed}`,
  titleProvider: 'Provider',
  titleLogout: 'Sign out of a provider',
  titleSessions: 'Resume a session',
  titleSessionAction: 'Session action',
  resumed: (id, count) => `Resumed ${id} — ${count} messages restored`,
  sessionsEmpty: 'No saved sessions yet.',
  providerSet: (id, model) => `Provider: ${id} · model ${model}`,
  providersEmpty: 'No providers configured. Use /login to add one.',
  sessionSummary: (elapsed, turns) => `session ${elapsed} · ${turns} turns`,
  providerBalance: (balances) => `provider balance: ${balances}`,
  providerKeyRemaining: (balances) => `API key limit remaining: ${balances}`,
  noThink: 'no-think',
  mcpFailed: (count) => `mcp:${count} failed`,

  escCancel: 'esc to cancel',
  escHelp: 'esc — cancel the running turn',
  cancelled: 'Cancelled.',
  queued: (count) => `queued: ${count}`,
  configAt: (path) => `config: ${path}`,
  skillsEmpty:
    'No skills installed. Drop a folder with a SKILL.md into ~/.kitcode/skills or ./.kitcode/skills',
  mcpStatus: (connected, failed) => `MCP: ${connected} connected, ${failed} failed`,
  mcpEmpty: 'No MCP servers configured.',
  mcpAddUsage:
    'List: /mcp list · Enable/disable: /mcp enable|disable [name] · Delete: /mcp delete [name]\nRemote: /mcp add <name> <https://url>\nLocal: /mcp add <name> -- <command> [args]',
  mcpAddInvalidName: 'MCP name may contain only letters, numbers, _ and - (up to 64 chars).',
  mcpAddInvalidUrl: 'MCP URL must use HTTPS (HTTP is allowed only for localhost).',
  mcpAddHttpArgs: 'An HTTP MCP accepts one URL and no command arguments.',
  mcpExists: (name) => `MCP server "${name}" already exists.`,
  mcpConnecting: (name) => `Connecting MCP "${name}"…`,
  mcpAdded: (name, tools) => `MCP "${name}" connected and saved · ${tools} tools`,
  mcpAddFailed: (name, error) => `Could not add MCP "${name}": ${error}`,
  mcpDeleted: (name) => `MCP "${name}" disconnected and removed.`,
  mcpDeleteFailed: (name, error) => `Could not remove MCP "${name}": ${error}`,
  mcpNotFound: (name) => `MCP server "${name}" was not found.`,
  mcpTools: (count) => `${count} tools`,
  mcpEnabled: (name, tools) => `MCP "${name}" enabled · ${tools} tools`,
  mcpDisabled: (name) => `MCP "${name}" disabled.`,
  mcpToggleFailed: (name, error) => `Could not change MCP "${name}": ${error}`,
  mcpState: {
    connected: 'connected',
    connecting: 'connecting',
    error: 'error',
    disabled: 'disabled',
  },
  attachUsage:
    'Usage: /attach <image-or-text-file> · /attach clipboard · /attach clear',
  attachmentAdded: (name) => `Attached for the next message: ${name}`,
  attachmentsCleared: 'Pending attachments cleared.',
  compactNothing: 'Not enough older conversation to compact yet.',
  compactDone: (count) => `Context compacted · ${count} older messages replaced with a summary.`,
  sessionRenameUsage: 'Type the title after the command: /sessions rename <id> <title>',
  sessionRenamed: (title) => `Session renamed to "${title}".`,
  sessionDeleteAsk: 'The saved chat file will be deleted. This cannot be undone.',
  sessionDeleted: (id) => `Session ${id} deleted.`,
  sessionDeleteAllAsk: 'Delete every saved chat?',
  sessionDeleteAllAskBody:
    'All KitCode sessions from every workspace will be permanently deleted.',
  sessionDeleteAllFinalAsk: 'Final confirmation: delete all chats?',
  sessionDeleteAllFinalBody:
    'This cannot be undone. Press y only if you want to erase the complete session history.',
  sessionsDeletedAll: (count) => `All saved chats deleted · ${count} sessions removed.`,
  sessionsDeleteAllFailed: (deleted, failed) =>
    `Session cleanup was incomplete · ${deleted} removed, ${failed} failed.`,
  sessionExported: (path) => `Session exported to ${path}`,
  sessionActionResume: 'resume',
  sessionActionRename: 'rename',
  sessionActionDelete: 'delete',
  sessionActionExport: 'export Markdown',
  updateAvailable: (version, url) => `A newer KitCode build is available (${version}): ${url}`,
  accentSet: (name, hex) => `Accent: ${name} (${hex})`,
  reasoning: (on) => `Reasoning ${on ? 'on' : 'off'}`,
  effortSet: (value) => `Effort: ${value}`,
  modelSet: (value) => `Model: ${value}`,
  noModels: 'No models available. Use /login to add a provider.',
  bypassOff: 'Approval prompts are back on.',
  bypassAsk1: 'Disable approval prompts for this session?',
  bypassAsk1Body: 'The agent will write files and run shell commands without asking.',
  bypassAsk2: 'Confirm once more.',
  bypassAsk2Body: 'This lasts until you quit. Tools set to "deny" in config stay blocked.',
  bypassCancelled: 'Bypass cancelled.',
  bypassOn: 'Bypass on — approvals disabled for this session.',
  logoutAsk: (provider) => `Sign out of "${provider}"?`,
  logoutAskBody: 'Its API key is removed from auth.json and the provider is dropped from the config.',
  loggedOut: (provider) => `Signed out of "${provider}".`,
  logoutNothing: 'No provider is signed in.',
  promptUsage: 'Usage: /prompt save <name>',
  promptNothing: 'Nothing to save yet — send a message first.',
  promptSaved: (name) => `Saved prompt "${name}"`,
  promptsEmpty: 'No saved prompts. Use /prompt save <name>.',
  unknownCommand: (name) => `Unknown command /${name}. Try /help`,
  didYouMean: (typed, guess) => `Unknown command /${typed}. Did you mean /${guess}?`,
  undoNothing: 'Nothing to undo in this session.',
  undoResult: (restored, removed) =>
    `Undo complete: ${restored} restored, ${removed} newly created removed.`,
  undoConflicts: (paths) =>
    `Kept newer changes in: ${paths.join(', ')}`,
  undoFailed: (failures) => `Could not restore: ${failures.join('; ')}`,

  titleAccent: 'Accent colour',
  titleEffort: 'Reasoning depth',
  titleModel: 'Model',
  titlePrompts: 'Saved prompts',
  titleLang: 'Language',
  titleMcpDelete: 'Remove an MCP server',
  titleMcpEnable: 'Enable an MCP server',
  titleMcpDisable: 'Disable an MCP server',
  modeLabel: { normal: 'normal', accept: 'auto-accept edits', plan: 'plan only' },
  modeChanged: (label) => `Mode: ${label}  (shift+tab to cycle)`,

  cmd: {
    model: 'switch model',
    login: 'add a provider (url + key)',
    provider: 'switch between configured providers',
    logout: 'choose a provider to sign out from',
    effort: 'set reasoning depth',
    thinking: 'toggle reasoning',
    theme: 'change the accent colour',
    lang: 'change the interface language',
    prompt: 'insert or save a prompt',
    skills: 'list installed skills',
    bypass: 'disable approval prompts (asks twice)',
    usage: 'token and cost breakdown',
    mcp: 'show or add MCP servers',
    'mcp add': 'connect and save an MCP server',
    'mcp list': 'list MCP servers and connection status',
    'mcp delete': 'disconnect and remove an MCP server',
    'mcp enable': 'enable and connect an MCP server',
    'mcp disable': 'disconnect without removing an MCP server',
    attach: 'attach an image or text file to the next message',
    compact: 'summarize older context and keep recent turns',
    checker: 'check local setup without spending model tokens',
    sessions: 'search and manage saved sessions',
    'sessions list': 'list saved sessions',
    'sessions rename': 'rename a saved session',
    'sessions delete': 'delete a saved session',
    'sessions delete all': 'permanently delete every saved chat',
    'sessions export': 'export a session to Markdown',
    config: 'show where the config lives',
    resume: 'reopen a past chat',
    undo: 'undo file edits from the latest message',
    clear: 'start a fresh session',
    help: 'list commands',
    exit: 'quit',
  },
}

const ru: Strings = {
  hint: 'нажми / для команд',
  noProvider: 'провайдер ещё не добавлен',

  onboardIntro: 'Вставь базовый URL любого OpenAI-совместимого или Anthropic API, затем ключ.',
  onboardExamples: 'например https://openrouter.ai/api/v1 · https://api.anthropic.com',
  baseUrl: 'базовый url › ',
  apiKey: 'api-ключ › ',
  detecting: 'определяю провайдера…',

  placeholder: 'спроси, или / для команд',
  working: 'работаю…',
  suggestHelp: '↑↓ выбор · tab — дополнить · enter — выполнить',
  more: (count) => `… ещё ${count}`,

  allowOnce: 'разрешить один раз',
  always: 'всегда',
  deny: 'отклонить',
  yes: 'да',
  noDefault: 'нет (по умолчанию)',

  noMatches: 'ничего не найдено',
  pickerHelp: (shown, total) => `${shown} из ${total} · ↑↓ выбор · enter — ок · esc — отмена`,

  noModel: 'нет модели',
  busy: 'работаю',
  sessionFor: (elapsed) => `в работе ${elapsed}`,
  workingFor: (elapsed) => `думает ${elapsed}`,
  titleProvider: 'Провайдер',
  titleLogout: 'Выбрать API для выхода',
  titleSessions: 'Восстановить сессию',
  titleSessionAction: 'Действие с сессией',
  resumed: (id, count) => `Сессия ${id} восстановлена — сообщений: ${count}`,
  sessionsEmpty: 'Сохранённых сессий пока нет.',
  providerSet: (id, model) => `Провайдер: ${id} · модель ${model}`,
  providersEmpty: 'Провайдеров нет. Добавь через /login.',
  sessionSummary: (elapsed, turns) => `сессия ${elapsed} · ходов: ${turns}`,
  providerBalance: (balances) => `баланс провайдера: ${balances}`,
  providerKeyRemaining: (balances) => `остаток лимита API-ключа: ${balances}`,
  noThink: 'без размышлений',
  mcpFailed: (count) => `mcp: ${count} с ошибкой`,

  escCancel: 'esc — отменить',
  escHelp: 'esc — отменить текущий ход',
  cancelled: 'Отменено.',
  queued: (count) => `в очереди: ${count}`,
  configAt: (path) => `конфиг: ${path}`,
  skillsEmpty:
    'Скиллов нет. Положи папку с файлом SKILL.md в ~/.kitcode/skills или ./.kitcode/skills',
  mcpStatus: (connected, failed) => `MCP: подключено ${connected}, с ошибкой ${failed}`,
  mcpEmpty: 'MCP-серверы пока не добавлены.',
  mcpAddUsage:
    'Список: /mcp list · Вкл/выкл: /mcp enable|disable [имя] · Удалить: /mcp delete [имя]\nУдалённый: /mcp add <имя> <https://url>\nЛокальный: /mcp add <имя> -- <команда> [аргументы]',
  mcpAddInvalidName: 'Имя MCP: только буквы, цифры, _ и - (до 64 символов).',
  mcpAddInvalidUrl: 'URL MCP должен использовать HTTPS (HTTP разрешён только для localhost).',
  mcpAddHttpArgs: 'Для HTTP MCP укажи один URL без аргументов команды.',
  mcpExists: (name) => `MCP-сервер «${name}» уже существует.`,
  mcpConnecting: (name) => `Подключаю MCP «${name}»…`,
  mcpAdded: (name, tools) => `MCP «${name}» подключён и сохранён · инструментов: ${tools}`,
  mcpAddFailed: (name, error) => `Не удалось добавить MCP «${name}»: ${error}`,
  mcpDeleted: (name) => `MCP «${name}» отключён и удалён.`,
  mcpDeleteFailed: (name, error) => `Не удалось удалить MCP «${name}»: ${error}`,
  mcpNotFound: (name) => `MCP-сервер «${name}» не найден.`,
  mcpTools: (count) => `инструментов: ${count}`,
  mcpEnabled: (name, tools) => `MCP «${name}» включён · инструментов: ${tools}`,
  mcpDisabled: (name) => `MCP «${name}» выключен.`,
  mcpToggleFailed: (name, error) => `Не удалось изменить MCP «${name}»: ${error}`,
  mcpState: {
    connected: 'подключён',
    connecting: 'подключается',
    error: 'ошибка',
    disabled: 'отключён',
  },
  attachUsage:
    'Использование: /attach <картинка-или-текстовый-файл> · /attach clipboard · /attach clear',
  attachmentAdded: (name) => `Прикреплено к следующему сообщению: ${name}`,
  attachmentsCleared: 'Ожидающие вложения убраны.',
  compactNothing: 'Пока недостаточно старых сообщений для сжатия контекста.',
  compactDone: (count) => `Контекст сжат · старых сообщений заменено сводкой: ${count}.`,
  sessionRenameUsage: 'Допиши название: /sessions rename <id> <название>',
  sessionRenamed: (title) => `Сессия переименована в «${title}».`,
  sessionDeleteAsk: 'Файл сохранённого чата будет удалён без возможности восстановления.',
  sessionDeleted: (id) => `Сессия ${id} удалена.`,
  sessionDeleteAllAsk: 'Удалить вообще все сохранённые чаты?',
  sessionDeleteAllAskBody:
    'Будут навсегда удалены все сессии KitCode из всех рабочих папок.',
  sessionDeleteAllFinalAsk: 'Последнее подтверждение: точно удалить все чаты?',
  sessionDeleteAllFinalBody:
    'Это нельзя отменить. Нажимай y только если хочешь стереть всю историю сессий.',
  sessionsDeletedAll: (count) => `Все сохранённые чаты удалены · сессий: ${count}.`,
  sessionsDeleteAllFailed: (deleted, failed) =>
    `Удаление завершено не полностью · удалено: ${deleted}, ошибок: ${failed}.`,
  sessionExported: (path) => `Сессия экспортирована: ${path}`,
  sessionActionResume: 'открыть',
  sessionActionRename: 'переименовать',
  sessionActionDelete: 'удалить',
  sessionActionExport: 'экспортировать Markdown',
  updateAvailable: (version, url) => `Доступна новая версия KitCode (${version}): ${url}`,
  accentSet: (name, hex) => `Цвет: ${name} (${hex})`,
  reasoning: (on) => `Размышления ${on ? 'включены' : 'выключены'}`,
  effortSet: (value) => `Глубина: ${value}`,
  modelSet: (value) => `Модель: ${value}`,
  noModels: 'Моделей нет. Добавь провайдера через /login.',
  bypassOff: 'Подтверждения снова включены.',
  bypassAsk1: 'Отключить подтверждения на эту сессию?',
  bypassAsk1Body: 'Агент будет писать файлы и запускать команды без спроса.',
  bypassAsk2: 'Подтверди ещё раз.',
  bypassAsk2Body: 'Действует до выхода. Инструменты с «deny» в конфиге останутся заблокированы.',
  bypassCancelled: 'Отменено.',
  bypassOn: 'Байпас включён — подтверждения отключены до конца сессии.',
  logoutAsk: (provider) => `Выйти из «${provider}»?`,
  logoutAskBody: 'Ключ будет удалён из auth.json, а провайдер — из конфига.',
  loggedOut: (provider) => `Выполнен выход из «${provider}».`,
  logoutNothing: 'Ни один провайдер не подключён.',
  promptUsage: 'Использование: /prompt save <имя>',
  promptNothing: 'Пока нечего сохранять — сначала отправь сообщение.',
  promptSaved: (name) => `Промт «${name}» сохранён`,
  promptsEmpty: 'Сохранённых промтов нет. Используй /prompt save <имя>.',
  unknownCommand: (name) => `Неизвестная команда /${name}. Попробуй /help`,
  didYouMean: (typed, guess) => `Неизвестная команда /${typed}. Может быть /${guess}?`,
  undoNothing: 'В этой сессии пока нечего откатывать.',
  undoResult: (restored, removed) =>
    `Откат завершён: восстановлено ${restored}, удалено новых файлов ${removed}.`,
  undoConflicts: (paths) =>
    `Более свежие изменения сохранены в: ${paths.join(', ')}`,
  undoFailed: (failures) => `Не удалось восстановить: ${failures.join('; ')}`,

  titleAccent: 'Цвет акцента',
  titleEffort: 'Глубина размышлений',
  titleModel: 'Модель',
  titlePrompts: 'Сохранённые промты',
  titleLang: 'Язык',
  titleMcpDelete: 'Удалить MCP-сервер',
  titleMcpEnable: 'Включить MCP-сервер',
  titleMcpDisable: 'Выключить MCP-сервер',
  modeLabel: { normal: 'обычный', accept: 'правки без спроса', plan: 'только план' },
  modeChanged: (label) => `Режим: ${label}  (shift+tab — переключить)`,

  cmd: {
    model: 'сменить модель',
    login: 'добавить провайдера (url + ключ)',
    provider: 'переключиться между провайдерами',
    logout: 'выбрать провайдера и удалить его ключ',
    effort: 'глубина размышлений',
    thinking: 'включить/выключить размышления',
    theme: 'сменить цвет акцента',
    lang: 'сменить язык интерфейса',
    prompt: 'вставить или сохранить промт',
    skills: 'список установленных скиллов',
    bypass: 'отключить подтверждения (спросит дважды)',
    usage: 'токены и стоимость',
    mcp: 'показать или добавить MCP-сервер',
    'mcp add': 'подключить и сохранить MCP-сервер',
    'mcp list': 'список MCP-серверов и их статус',
    'mcp delete': 'отключить и удалить MCP-сервер',
    'mcp enable': 'включить и подключить MCP-сервер',
    'mcp disable': 'отключить MCP без удаления',
    attach: 'прикрепить картинку или текстовый файл к сообщению',
    compact: 'сжать старый контекст, сохранив последние ходы',
    checker: 'проверить настройку без траты токенов модели',
    sessions: 'поиск и управление сохранёнными сессиями',
    'sessions list': 'список сохранённых сессий',
    'sessions rename': 'переименовать сессию',
    'sessions delete': 'удалить сессию',
    'sessions delete all': 'навсегда удалить все сохранённые чаты',
    'sessions export': 'экспортировать сессию в Markdown',
    config: 'где лежит конфиг',
    resume: 'открыть прошлый чат',
    undo: 'откатить правки файлов из последнего сообщения',
    clear: 'начать новую сессию',
    help: 'список команд',
    exit: 'выход',
  },
}

const DICTIONARIES: Record<Lang, Strings> = { en, ru }

export function stringsFor(lang: Lang | undefined): Strings {
  return DICTIONARIES[lang ?? 'en']
}

export const StringsContext = createContext<Strings>(en)

export function useStrings(): Strings {
  return useContext(StringsContext)
}
