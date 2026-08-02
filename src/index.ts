import { Command } from 'commander'
import { resolve } from 'node:path'
import type { AgentMode } from './tools/permissions'
import { addProvider } from './app/add'
import { ask } from './app/ask'
import { showConfig } from './app/configcmd'
import { listSessions, shortSessionId } from './core/session'
import { startTui } from './app/tui'
import { deletePrompt, listPrompts } from './prompts/library'

const program = new Command()

program
  .name('kitcode')
  .description('Terminal coding agent with a config you never have to write by hand')
  .version('0.1.0')
  .option('-c, --continue', 'resume the most recent session for this directory')
  .option('-r, --resume <id>', 'reopen a past chat by id (any unique part of it works)')
  .option('--cwd <path>', 'run in this directory instead of the current one')
  .option('--model <ref>', 'start the session with this model (provider/model or model)')
  .option('--mode <mode>', 'start in this permission mode: normal | accept | plan')
  .action(async (options: { continue?: boolean; resume?: string; cwd?: string; model?: string; mode?: string }) => {
    const MODES: AgentMode[] = ['normal', 'accept', 'plan']
    if (options.mode && !MODES.includes(options.mode as AgentMode)) {
      throw new Error(`Unknown mode "${options.mode}". Use normal, accept or plan.`)
    }
    let cwd = options.cwd
    if (cwd) {
      try {
        cwd = resolve(cwd)
      } catch {
        // keep raw
      }
    }
    await startTui({
      continueSession: options.continue,
      resumeId: options.resume,
      cwd,
      modelRef: options.model,
      mode: options.mode as AgentMode | undefined,
    })
  })

program
  .command('sessions')
  .description('list past chats')
  .action(async () => {
    const entries = await listSessions(30)
    if (entries.length === 0) {
      console.log('no saved sessions')
      return
    }
    for (const entry of entries) {
      console.log(
        `${shortSessionId(entry.id)}  ${entry.updatedAt.slice(0, 16).replace('T', ' ')}  ` +
          `${String(entry.messageCount).padStart(3)} msgs  ${entry.cwd}`,
      )
    }
    console.log('\nreopen one with: kitcode -r <id>')
  })

program
  .command('add')
  .description('detect a provider from a base URL plus API key and write the config')
  .argument('<url>', 'API base URL, e.g. https://openrouter.ai/api/v1')
  .argument('<key>', 'API key')
  .option('--name <name>', 'override the derived provider id')
  .option('--local', 'write ./kitcode.json in this directory instead of the global config')
  .action(async (url: string, key: string, options: { name?: string; local?: boolean }) => {
    await addProvider(url, key, options)
  })

program
  .command('ask')
  .description('run a single turn and print the answer')
  .argument('<text...>')
  .option('-y, --yes', 'approve every tool call without asking')
  .option('--mode <mode>', 'normal | accept | plan')
  .action(async (text: string[], options: { yes?: boolean; mode?: string }) => {
    const mode = options.mode
    if (mode && !(['normal', 'accept', 'plan'] as AgentMode[]).includes(mode as AgentMode)) {
      throw new Error(`Unknown mode "${mode}". Use normal, accept or plan.`)
    }
    await ask(text.join(' '), { yes: options.yes, mode: mode as AgentMode | undefined })
  })

program
  .command('config')
  .description('show where the config and keys live')
  .option('--local', 'move the config into ./kitcode.json in this directory')
  .action(async (options: { local?: boolean }) => {
    await showConfig(options)
  })

const prompts = program.command('prompt').description('manage saved prompts')

prompts
  .command('list')
  .description('list saved prompts')
  .action(async () => {
    const saved = await listPrompts()
    if (saved.length === 0) {
      console.log('no saved prompts')
      return
    }
    for (const prompt of saved) {
      console.log(`${prompt.slug}\t${prompt.name}${prompt.description ? ` — ${prompt.description}` : ''}`)
    }
  })

prompts
  .command('rm')
  .description('delete a saved prompt')
  .argument('<slug>')
  .action(async (slug: string) => {
    console.log((await deletePrompt(slug)) ? `deleted ${slug}` : `no such prompt: ${slug}`)
  })

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
