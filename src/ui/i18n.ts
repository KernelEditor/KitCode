import { createContext, useContext } from 'react'
import { tokens } from '../core/usage'

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
  dangerousCommand: string
  permissionKeys: string
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
  titleKeyChange: string
  titleModelRefresh: string
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
  escClear: string
  escHelp: string
  cancelled: string
  queued: (count: number) => string
  queueHint: string
  pasteToken: (id: number, lines: number, chars: number) => string
  inputRows: (from: number, to: number, total: number) => string
  configAt: (path: string) => string
  skillsEmpty: string
  skillsInstallUsage: string
  skillsInstalling: (source: string) => string
  skillsInstalled: (name: string, source: string) => string
  skillsRemoved: (name: string) => string
  titleSkillsRemove: string
  mcpStatus: (connected: number, failed: number) => string
  mcpEmpty: string
  mcpAddUsage: string
  mcpAddInvalidName: string
  mcpAddInvalidUrl: string
  mcpAddHttpArgs: string
  mcpAddInvalidEnv: string
  mcpAddInvalidHeader: string
  mcpAddOptionMismatch: string
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
  moreAgents: (count: number) => string
  noSubagents: string
  subagentsTitle: string
  subagentRunning: string
  subagentDone: string
  subagentWaiting: string
  subagentBack: string
  attachUsage: string
  attachmentAdded: (name: string) => string
  attachmentsCleared: string
  attachmentsLimit: (max: number) => string
  attachmentsTooLarge: (mb: number) => string
  mentionAttached: (name: string) => string
  compactNothing: string
  compactStarting: string
  compactDone: (summarised: number, cleared: number, before?: number, after?: number) => string
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
  updateCurrent: (version: string) => string
  updateFailed: (reason: string) => string
  accentSet: (name: string, hex: string) => string
  accentInvalid: (value: string) => string
  customAccent: string
  customAccentPrompt: string
  reasoning: (on: boolean) => string
  bellState: (on: boolean) => string
  effortSet: (value: string) => string
  budgetCurrent: (tokens: number) => string
  budgetSet: (tokens: number) => string
  budgetUnlimited: string
  budgetInvalid: string
  modelSet: (value: string) => string
  modelsRefreshed: (provider: string, count: number) => string
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
  keyChangeAsk: (provider: string) => string
  keyChangeAskBody: string
  keyChanged: (provider: string) => string
  promptUsage: string
  promptNothing: string
  promptSaved: (name: string) => string
  promptDeleteAsk: (name: string) => string
  promptOverwriteAsk: (name: string) => string
  promptNameTitle: string
  sessionNoMatch: (query: string) => string
  sessionAmbiguous: (query: string, count: number) => string
  sessionsUsage: string
  modelNoMatch: (query: string) => string
  memoryUsage: string
  memoryEmpty: string
  memoryClearAsk: string
  memoryReplaceAsk: string
  systemPromptTitle: string
  systemPromptUsage: string
  systemPromptEmpty: string
  systemPromptSet: string
  systemPromptCleared: string
  systemPromptEnabled: string
  systemPromptDisabled: string
  stepsCurrent: (n: number) => string
  stepsSet: (n: number) => string
  stepsUnlimited: string
  stepsInvalid: string
  promptDeleted: (name: string) => string
  promptNotFound: (name: string) => string
  promptsEmpty: string
  unknownCommand: (name: string) => string
  didYouMean: (typed: string, guess: string) => string
  undoNothing: string
  undoResult: (restored: number, removed: number) => string
  undoConflicts: (paths: string[]) => string
  undoFailed: (failures: string[]) => string

  titleContext: string
  contextCurrent: (tokens: number) => string
  contextSet: (tokens: number) => string
  contextAuto: (tokens: number | null) => string
  contextUnknown: string
  contextInvalid: string
  contextCurrentLabel: string

  titleAccent: string
  titleEffort: string
  titleModel: string
  titlePrompts: string
  titleSkills: string
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
  dangerousCommand: 'risky command',
  permissionKeys: '↑/↓ choose · enter confirm · y/a/n · esc deny',
  yes: 'yes',
  noDefault: 'no (default)',

  noMatches: 'no matches',
  pickerHelp: (shown, total) => `${shown} of ${total} · ↑↓ move · enter pick · esc cancel`,

  noModel: 'no model',
  busy: 'working',
  sessionFor: (elapsed) => `session ${elapsed}`,
  workingFor: (elapsed) => `working ${elapsed}`,
  titleProvider: 'Provider',
  titleLogout: 'Sign out of a provider',
  titleKeyChange: 'Change API key for a provider',
  titleModelRefresh: 'Reload models for a provider',
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
  escClear: 'esc clears the input · esc again cancels the answer',
  escHelp: 'esc — cancel the running turn',
  cancelled: 'Cancelled.',
  queued: (count) => `queued: ${count}`,
  pasteToken: (id, lines, chars) => `[paste #${id} · ${lines > 1 ? `${lines} lines` : `${chars} chars`}]`,
  inputRows: (from, to, total) => `lines ${from}–${to} of ${total}`,
  queueHint: 'waiting for the current answer · ↑/↓ pick one to edit · enter puts it back in its place',
  configAt: (path) => `config: ${path}`,
  skillsEmpty:
    'No skills installed. Drop a folder with a SKILL.md into ~/.kitcode/skills or ./.kitcode/skills',
  skillsInstallUsage:
    'Usage: /skills install <github-url|npm-package|local-path> · /skills remove [name]',
  skillsInstalling: (source) => `Installing skill from "${source}"…`,
  skillsInstalled: (name, source) => `Skill "${name}" installed from "${source}"`,
  skillsRemoved: (name) => `Skill "${name}" removed`,
  titleSkillsRemove: 'Remove skill',
  mcpStatus: (connected, failed) => `MCP: ${connected} connected, ${failed} failed`,
  mcpEmpty: 'No MCP servers configured.',
  mcpAddUsage:
    'List: /mcp list · Enable/disable: /mcp enable|disable [name] · Delete: /mcp delete [name]\nRemote: /mcp add <name> [-H "Name: value"] <https://url>\nLocal: /mcp add <name> [-e KEY=value] -- <command> [args]\nKeep secrets out of the config with ${env:VAR}, e.g. -H "Authorization: Bearer ${env:TOKEN}"',
  mcpAddInvalidName: 'MCP name may contain only letters, numbers, _ and - (up to 64 chars).',
  mcpAddInvalidUrl: 'MCP URL must use HTTPS (HTTP is allowed only for localhost).',
  mcpAddHttpArgs: 'An HTTP MCP accepts one URL and no command arguments.',
  mcpAddInvalidEnv: 'Environment variables look like -e KEY=value.',
  mcpAddInvalidHeader: 'Headers look like -H "Name: value".',
  mcpAddOptionMismatch: '-e is for local (command) servers, -H is for remote (URL) servers.',
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
  moreAgents: (count) => `+${count} more`,
  noSubagents: 'No sub-agents in this session yet.',
  subagentsTitle: 'Open a sub-agent chat',
  subagentRunning: 'running',
  subagentDone: 'done',
  subagentWaiting: 'waiting for the first step…',
  subagentBack: 'esc back',
  attachUsage:
    'Usage: /attach <image-or-text-file> · /attach clipboard · /attach clear',
  attachmentAdded: (name) => `Attached for the next message: ${name}`,
  attachmentsCleared: 'Pending attachments cleared.',
  attachmentsLimit: (max) => `At most ${max} attachments can be queued for one message.`,
  attachmentsTooLarge: (mb) => `Attachments for one message are limited to about ${mb} MB in total. Send these first or use smaller files.`,
  mentionAttached: (name) => `Sending with this message: ${name}`,
  compactNothing: 'Not enough older conversation to compact yet.',
  compactStarting: 'Compacting context…',
  compactDone: (summarised, cleared, before, after) => [
    'Context compacted',
    summarised > 0 ? `${summarised} older messages replaced with a summary` : '',
    cleared > 0 ? `${cleared} old tool outputs cleared` : '',
    before !== undefined && after !== undefined ? `~${tokens(before)} → ~${tokens(after)} tokens` : '',
  ].filter(Boolean).join(' · ') + '.',
  sessionRenameUsage: 'Type the title after the command: /sessions rename [id] <title>',
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
  updateAvailable: (version, url) =>
    `A newer KitCode version is available (${version}). Update with:\nnpm install -g @kernelonpanic/kitcode@latest\n${url}`,
  updateCurrent: (version) => `KitCode ${version} is up to date.`,
  updateFailed: (reason) => `Could not check for updates: ${reason}.`,
  accentSet: (name, hex) => `Accent: ${name} (${hex})`,
  accentInvalid: (value) => `"${value}" is not a colour. Use a preset name or a hex code like #ff8800 or #f80.`,
  customAccent: 'custom colour…',
  customAccentPrompt: 'Hex colour, e.g. #ff8800 or #f80',
  reasoning: (on) => `Reasoning ${on ? 'on' : 'off'}`,
  bellState: (on) => on ? 'Sound on: a beep when a long answer finishes or a permission is needed.' : 'Sound off.',
  effortSet: (value) => `Effort: ${value}`,
  budgetCurrent: (tokens) => `Token budget: ${tokens.toLocaleString()} per turn`,
  budgetSet: (tokens) => `Token budget set to ${tokens.toLocaleString()} per turn`,
  budgetUnlimited: 'Token budget: unlimited (0). Set /budget <tokens> to restore a limit.',
  budgetInvalid: 'Invalid budget: must be between 1,000 and 10,000,000',
  modelSet: (value) => `Model: ${value}`,
  modelsRefreshed: (provider, count) => `${provider}: ${count} models reloaded from the endpoint.`,
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
  keyChangeAsk: (provider) => `Change API key for "${provider}"?`,
  keyChangeAskBody: 'The new key replaces the old one. Models are re-fetched automatically.',
  keyChanged: (provider) => `API key updated for "${provider}".`,
  promptUsage: 'Usage: /prompt save <name>',
  promptNothing: 'Nothing to save yet — send a message first.',
  promptSaved: (name) => `Saved prompt "${name}"`,
  promptDeleteAsk: (name) => `Delete prompt "${name}"?`,
  promptOverwriteAsk: (name) => `A prompt named "${name}" exists. Replace it?`,
  promptNameTitle: 'Prompt name',
  sessionNoMatch: (query) => `No saved session matches "${query}".`,
  sessionAmbiguous: (query, count) => `"${query}" matches ${count} sessions; give more of the id.`,
  sessionsUsage: 'Usage: /sessions [list|rename [id] <title>|delete [id|all]|export [id] [path]]',
  modelNoMatch: (query) => `No single model matches "${query}"; pick one from the list.`,
  memoryUsage: '/memory show · /memory set <text> · /memory clear',
  memoryEmpty: 'Project memory is empty.',
  memoryClearAsk: 'Clear project memory?',
  memoryReplaceAsk: 'Replace all project memory notes with this text?',
  systemPromptTitle: 'System prompt addition',
  systemPromptUsage: '/systemp [show] · /systemp set <text> · /systemp clear',
  systemPromptEmpty: 'No extra system prompt. Set one with /systemp set <text>.',
  systemPromptSet: 'System prompt addition saved.',
  systemPromptCleared: 'System prompt addition cleared.',
  systemPromptEnabled: 'System prompt enabled.',
  systemPromptDisabled: 'System prompt disabled (kept in config).',
  stepsCurrent: (n) => n === 0 ? 'Model calls per turn: unlimited' : `Model calls per turn: ${n}`,
  stepsSet: (n) => `Model calls per turn set to ${n}`,
  stepsUnlimited: 'Model calls per turn: unlimited (0). The turn budget still applies.',
  stepsInvalid: 'Usage: /steps <0-1000> (0 = unlimited)',
  promptDeleted: (name) => `Deleted prompt "${name}"`,
  promptNotFound: (name) => `Prompt "${name}" not found.`,
  promptsEmpty: 'No saved prompts. Use /prompt save <name>.',
  unknownCommand: (name) => `Unknown command /${name}. Try /help`,
  didYouMean: (typed, guess) => `Unknown command /${typed}. Did you mean /${guess}?`,
  undoNothing: 'Nothing to undo: no file changes made by kitcode in this folder.',
  undoResult: (restored, removed) =>
    `Undo complete: ${restored} restored, ${removed} newly created removed.`,
  undoConflicts: (paths) =>
    `Kept newer changes in: ${paths.join(', ')}`,
  undoFailed: (failures) => `Could not restore: ${failures.join('; ')}`,

  titleContext: 'Context window',
  contextCurrent: (tokens) => `Context window: ${tokens.toLocaleString()} tokens`,
  contextSet: (tokens) =>
    `Context window set to ${tokens.toLocaleString()} tokens. Auto-compact triggers at 80%.`,
  contextAuto: (tokens) =>
    tokens === null
      ? 'Context window: unknown — using whatever the provider reports.'
      : `Context window: auto (${tokens.toLocaleString()} tokens from the provider).`,
  contextUnknown: 'Context window: unknown. Set it with /context 256k, /context 512k or /context 1m.',
  contextInvalid: 'Usage: /context 256k | 512k | 1m | <tokens> | auto',
  contextCurrentLabel: 'current',

  titleAccent: 'Accent colour',
  titleEffort: 'Reasoning depth',
  titleModel: 'Model',
  titlePrompts: 'Saved prompts',
  titleSkills: 'Skill',
  titleLang: 'Language',
  titleMcpDelete: 'Remove an MCP server',
  titleMcpEnable: 'Enable an MCP server',
  titleMcpDisable: 'Disable an MCP server',
  modeLabel: { normal: 'normal', accept: 'auto-accept edits', plan: 'plan only', bypass: 'BYPASS — no permission prompts' },
  modeChanged: (label) => `Mode: ${label}  (shift+tab to cycle)`,

  cmd: {
    model: 'switch model',
    login: 'add a provider (url + key)',
    provider: 'switch between configured providers',
    logout: 'choose a provider to sign out from',
    key: 'change API key for a provider',
    refresh: 'reload the model list for a provider',
    effort: 'set reasoning depth',
    thinking: 'toggle reasoning',
    bell: 'toggle the sound for finished answers and permission prompts',
    context: 'set or show the model context window',
    budget: 'set token budget per turn',
    theme: 'change the accent colour',
    lang: 'change the interface language',
    memory: 'view, replace or clear project memory',
    systemp: 'view, set, load from file, or toggle the extra system prompt',
    steps: 'cap model calls per turn',
    prompt: 'insert or save a prompt',
    'prompt save': 'save the current or recent text as a prompt',
    'prompt delete': 'delete a saved prompt',
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
    update: 'check npm for a newer KitCode version',
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
    subagents: 'open a sub-agent and watch its chat live',
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
  dangerousCommand: 'рискованная команда',
  permissionKeys: '↑/↓ выбрать · enter подтвердить · y/a/n · esc отклонить',
  yes: 'да',
  noDefault: 'нет (по умолчанию)',

  noMatches: 'ничего не найдено',
  pickerHelp: (shown, total) => `${shown} из ${total} · ↑↓ выбор · enter — ок · esc — отмена`,

  noModel: 'нет модели',
  busy: 'работаю',
  sessionFor: (elapsed) => `сессия ${elapsed}`,
  workingFor: (elapsed) => `думает ${elapsed}`,
  titleProvider: 'Провайдер',
  titleLogout: 'Выбрать API для выхода',
  titleKeyChange: 'Сменить ключ провайдера',
  titleModelRefresh: 'Обновить модели провайдера',
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
  escClear: 'esc — очистить поле · ещё раз esc — отменить ответ',
  escHelp: 'esc — отменить текущий ход',
  cancelled: 'Отменено.',
  queued: (count) => `в очереди: ${count}`,
  pasteToken: (id, lines, chars) => `[вставка #${id} · ${lines > 1 ? `${lines} строк` : `${chars} символов`}]`,
  inputRows: (from, to, total) => `строки ${from}–${to} из ${total}`,
  queueHint: 'ждут текущего ответа · ↑/↓ — выбрать одно для правки · enter вернёт его на место',
  configAt: (path) => `конфиг: ${path}`,
  skillsEmpty:
    'Скиллов нет. Положи папку с файлом SKILL.md в ~/.kitcode/skills или ./.kitcode/skills',
  skillsInstallUsage:
    'Использование: /skills install <github-url|npm-пакет|локальный-путь> · /skills remove [имя]',
  skillsInstalling: (source) => `Устанавливаю скилл из "${source}"…`,
  skillsInstalled: (name, source) => `Скилл «${name}» установлен из "${source}"`,
  skillsRemoved: (name) => `Скилл «${name}» удалён`,
  titleSkillsRemove: 'Удалить скилл',
  mcpStatus: (connected, failed) => `MCP: подключено ${connected}, с ошибкой ${failed}`,
  mcpEmpty: 'MCP-серверы пока не добавлены.',
  mcpAddUsage:
    'Список: /mcp list · Вкл/выкл: /mcp enable|disable [имя] · Удалить: /mcp delete [имя]\nУдалённый: /mcp add <имя> [-H "Имя: значение"] <https://url>\nЛокальный: /mcp add <имя> [-e КЛЮЧ=значение] -- <команда> [аргументы]\nСекреты лучше не хранить в конфиге: ${env:VAR}, например -H "Authorization: Bearer ${env:TOKEN}"',
  mcpAddInvalidName: 'Имя MCP: только буквы, цифры, _ и - (до 64 символов).',
  mcpAddInvalidUrl: 'URL MCP должен использовать HTTPS (HTTP разрешён только для localhost).',
  mcpAddHttpArgs: 'Для HTTP MCP укажи один URL без аргументов команды.',
  mcpAddInvalidEnv: 'Переменные окружения задаются так: -e КЛЮЧ=значение.',
  mcpAddInvalidHeader: 'Заголовки задаются так: -H "Имя: значение".',
  mcpAddOptionMismatch: '-e — для локальных (команда) серверов, -H — для удалённых (URL).',
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
  moreAgents: (count) => `+${count} ещё`,
  noSubagents: 'В этой сессии ещё не было суб-агентов.',
  subagentsTitle: 'Открыть чат суб-агента',
  subagentRunning: 'работает',
  subagentDone: 'готово',
  subagentWaiting: 'ждём первый шаг…',
  subagentBack: 'esc — назад',
  attachUsage:
    'Использование: /attach <картинка-или-текстовый-файл> · /attach clipboard · /attach clear',
  attachmentAdded: (name) => `Прикреплено к следующему сообщению: ${name}`,
  attachmentsCleared: 'Ожидающие вложения убраны.',
  attachmentsLimit: (max) => `К одному сообщению можно прикрепить не больше ${max} вложений.`,
  attachmentsTooLarge: (mb) => `Вложения одного сообщения — не больше ~${mb} МБ в сумме. Отправь эти сначала или возьми файлы поменьше.`,
  mentionAttached: (name) => `Отправляю вместе с сообщением: ${name}`,
  compactNothing: 'Пока недостаточно старых сообщений для сжатия контекста.',
  compactStarting: 'Сжатие контекста…',
  compactDone: (summarised, cleared, before, after) => [
    'Контекст сжат',
    summarised > 0 ? `старых сообщений заменено сводкой: ${summarised}` : '',
    cleared > 0 ? `очищено старых выводов инструментов: ${cleared}` : '',
    before !== undefined && after !== undefined ? `~${tokens(before)} → ~${tokens(after)} токенов` : '',
  ].filter(Boolean).join(' · ') + '.',
  sessionRenameUsage: 'Допиши название: /sessions rename [id] <название>',
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
  updateAvailable: (version, url) =>
    `Доступна новая версия KitCode (${version}). Обновить:\nnpm install -g @kernelonpanic/kitcode@latest\n${url}`,
  updateCurrent: (version) => `Установлена актуальная версия KitCode ${version}.`,
  updateFailed: (reason) => `Не удалось проверить обновления: ${reason}.`,
  accentSet: (name, hex) => `Цвет: ${name} (${hex})`,
  accentInvalid: (value) => `«${value}» — не цвет. Укажи название из списка или hex-код, например #ff8800 или #f80.`,
  customAccent: 'свой цвет…',
  customAccentPrompt: 'Hex-код цвета, например #ff8800 или #f80',
  reasoning: (on) => `Размышления ${on ? 'включены' : 'выключены'}`,
  bellState: (on) => on ? 'Звук включён: сигнал, когда долгий ответ готов или нужно разрешение.' : 'Звук выключен.',
  effortSet: (value) => `Глубина: ${value}`,
  budgetCurrent: (tokens) => `Лимит токенов: ${tokens.toLocaleString()} за ход`,
  budgetSet: (tokens) => `Лимит токенов установлен: ${tokens.toLocaleString()} за ход`,
  budgetUnlimited: 'Лимит токенов: безлимитный (0). Введи /budget <число> чтобы вернуть лимит.',
  budgetInvalid: 'Неверный лимит: от 1 000 до 10 000 000',
  modelSet: (value) => `Модель: ${value}`,
  modelsRefreshed: (provider, count) => `${provider}: с эндпоинта получено моделей — ${count}.`,
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
  keyChangeAsk: (provider) => `Сменить ключ для «${provider}»?`,
  keyChangeAskBody: 'Новый ключ заменит старый. Модели обновятся автоматически.',
  keyChanged: (provider) => `Ключ обновлён для «${provider}».`,
  promptUsage: 'Использование: /prompt save <имя>',
  promptNothing: 'Пока нечего сохранять — сначала отправь сообщение.',
  promptSaved: (name) => `Промт «${name}» сохранён`,
  promptDeleteAsk: (name) => `Удалить промт «${name}»?`,
  promptOverwriteAsk: (name) => `Промт «${name}» уже есть. Заменить?`,
  promptNameTitle: 'Название промта',
  sessionNoMatch: (query) => `Нет сохранённой сессии, подходящей под «${query}».`,
  sessionAmbiguous: (query, count) => `«${query}» подходит к ${count} сессиям — уточни id.`,
  sessionsUsage: 'Использование: /sessions [list|rename [id] <название>|delete [id|all]|export [id] [путь]]',
  modelNoMatch: (query) => `Нет одной модели под «${query}» — выбери из списка.`,
  memoryUsage: '/memory show · /memory set <текст> · /memory clear',
  memoryEmpty: 'Память проекта пуста.',
  memoryClearAsk: 'Очистить память проекта?',
  memoryReplaceAsk: 'Заменить все заметки памяти проекта этим текстом?',
  systemPromptTitle: 'Дополнение к системному промпту',
  systemPromptUsage: '/systemp [show] · /systemp set <текст> · /systemp clear',
  systemPromptEmpty: 'Дополнения к системному промпту нет. Задай через /systemp set <текст>.',
  systemPromptSet: 'Дополнение к системному промпту сохранено.',
  systemPromptCleared: 'Дополнение к системному промпту удалено.',
  systemPromptEnabled: 'Дополнение к системному промпту включено.',
  systemPromptDisabled: 'Дополнение к системному промпту выключено (сохранено в конфиге).',
  stepsCurrent: (n) => n === 0 ? 'Вызовов модели за ход: без лимита' : `Вызовов модели за ход: ${n}`,
  stepsSet: (n) => `Вызовов модели за ход установлено: ${n}`,
  stepsUnlimited: 'Вызовов модели за ход: без лимита (0). Бюджет токенов всё ещё действует.',
  stepsInvalid: 'Использование: /steps <0-1000> (0 = без лимита)',
  promptDeleted: (name) => `Промт «${name}» удалён`,
  promptNotFound: (name) => `Промт «${name}» не найден.`,
  promptsEmpty: 'Сохранённых промтов нет. Используй /prompt save <имя>.',
  unknownCommand: (name) => `Неизвестная команда /${name}. Попробуй /help`,
  didYouMean: (typed, guess) => `Неизвестная команда /${typed}. Может быть /${guess}?`,
  undoNothing: 'Нечего откатывать: kitcode ещё не менял файлы в этой папке.',
  undoResult: (restored, removed) =>
    `Откат завершён: восстановлено ${restored}, удалено новых файлов ${removed}.`,
  undoConflicts: (paths) =>
    `Более свежие изменения сохранены в: ${paths.join(', ')}`,
  undoFailed: (failures) => `Не удалось восстановить: ${failures.join('; ')}`,

  titleContext: 'Окно контекста',
  contextCurrent: (tokens) => `Окно контекста: ${tokens.toLocaleString()} токенов`,
  contextSet: (tokens) =>
    `Окно контекста: ${tokens.toLocaleString()} токенов. Автосжатие сработает на 80%.`,
  contextAuto: (tokens) =>
    tokens === null
      ? 'Окно контекста: неизвестно — берём то, что сообщает провайдер.'
      : `Окно контекста: авто (${tokens.toLocaleString()} токенов от провайдера).`,
  contextUnknown: 'Окно контекста неизвестно. Задай его: /context 256k, /context 512k или /context 1m.',
  contextInvalid: 'Использование: /context 256k | 512k | 1m | <токены> | auto',
  contextCurrentLabel: 'текущее',

  titleAccent: 'Цвет акцента',
  titleEffort: 'Глубина размышлений',
  titleModel: 'Модель',
  titlePrompts: 'Сохранённые промты',
  titleSkills: 'Скиллы',
  titleLang: 'Язык',
  titleMcpDelete: 'Удалить MCP-сервер',
  titleMcpEnable: 'Включить MCP-сервер',
  titleMcpDisable: 'Выключить MCP-сервер',
  modeLabel: { normal: 'обычный', accept: 'правки без спроса', plan: 'только план', bypass: 'BYPASS — без запросов разрешений' },
  modeChanged: (label) => `Режим: ${label}  (shift+tab — переключить)`,

  cmd: {
    model: 'сменить модель',
    login: 'добавить провайдера (url + ключ)',
    provider: 'переключиться между провайдерами',
    logout: 'выбрать провайдера и удалить его ключ',
    key: 'сменить ключ провайдера',
    refresh: 'обновить список моделей провайдера',
    effort: 'глубина размышлений',
    thinking: 'включить/выключить размышления',
    bell: 'включить/выключить звук о готовом ответе и запросах разрешений',
    context: 'задать или показать окно контекста модели',
    budget: 'лимит токенов за ход (0 = безлимит)',
    theme: 'сменить цвет акцента',
    lang: 'сменить язык интерфейса',
    memory: 'показать, заменить или очистить память проекта',
    systemp: 'показать, задать, загрузить из файла или включить/выключить дополнение к системному промпту',
    steps: 'лимит вызовов модели за ход',
    prompt: 'вставить или сохранить промт',
    skills: 'список установленных скиллов',
    'prompt delete': 'удалить сохранённый промт',
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
    update: 'проверить новую версию KitCode в npm',
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
    subagents: 'открыть суб-агента и смотреть его чат вживую',
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
