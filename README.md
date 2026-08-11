# KitCode

English · [Русский](./README.ru.md)

```text
  ╱\_╱\
 ( o.o )
  > ^ <
```

KitCode is a terminal coding agent. It reads and edits files, searches a project, runs commands,
connects external tools through MCP, and keeps persistent session history.

The interface is built with TypeScript, React, and Ink. KitCode supports the Anthropic API and
OpenAI-compatible providers, including OpenRouter and local model servers.

## Features

- streaming responses with reasoning output;
- file reading, creation, and targeted editing;
- filename and content search;
- shell commands with approval prompts;
- `normal`, `accept`, and `plan` modes;
- persistent and resumable sessions with native terminal scrollback;
- searchable session management with rename, delete, and Markdown export;
- input history with the `↑` and `↓` keys;
- queued messages while the agent is working;
- image and UTF-8 text attachments;
- manual and automatic context compaction;
- token, estimated cost, exact context-window, and provider rate-limit indicators;
- automatic file checkpoints with `/undo`;
- detected project checks after file edits;
- model and provider switching from the TUI;
- live MCP add, enable, disable, and delete operations, plus skills and subagents;
- a local `/checker` report for the runtime, provider, session, context, and MCP setup;
- English and Russian interfaces with configurable accents.

## Requirements

- Node.js 22 or newer;
- npm.

## Install

```sh
npm i -g @kernelonpanic/kitcode
```

## Install from source

```sh
git clone https://github.com/KernelEditor/KitCode.git
cd KitCode
npm install
npm run build
npm link
```

After `npm link`, the `kitcode` command is available globally. To run without a global link:

```sh
npm run dev
```

## First run

```sh
kitcode
```

On first launch, KitCode asks for the interface language, an API base URL, and an API key. It then
detects the provider type, loads the available models, and opens the main agent view.

Common base URLs:

```text
https://api.anthropic.com
https://openrouter.ai/api/v1
http://localhost:11434/v1
```

## Command line

| Command | Purpose |
| --- | --- |
| `kitcode` | Start the TUI in the current directory. |
| `kitcode -c` | Continue the latest session for this project. |
| `kitcode -r <id>` | Resume a session by id. |
| `kitcode --cwd <path>` | Use another working directory. |
| `kitcode --model <provider/model>` | Start with a selected model. |
| `kitcode --mode <normal\|accept\|plan>` | Select the initial agent mode. |
| `kitcode sessions` | List saved sessions. |
| `kitcode ask "question"` | Run one request without the TUI. |
| `kitcode add <url>` | Add a provider; the key is entered in a hidden prompt. |
| `kitcode add <url> --key-env <name>` | Read the provider key from an environment variable. |
| `kitcode trust` | Enable this workspace's project config and skills. |
| `kitcode config` | Show the config and key locations. |
| `kitcode config --local` | Create a project config at `./kitcode.json`. |
| `kitcode prompt list` | List saved prompts. |
| `kitcode prompt rm <slug>` | Delete a saved prompt. |

## TUI commands

Press `/` to open the command list.

| Command | Purpose |
| --- | --- |
| `/model` | Select a model. |
| `/provider` | Switch providers. |
| `/login` · `/logout [provider]` | Add a provider or choose exactly which provider to remove. |
| `/key [provider]` | Change API key for a provider. |
| `/effort` · `/thinking` | Configure reasoning depth and output. |
| `/resume` · `/clear` | Resume a session or start a new one. |
| `/sessions` | Search sessions, then resume, rename, delete, or export one. |
| `/sessions rename <id> <title>` | Give a saved session a title. |
| `/sessions delete all` | Delete every saved chat after two separate confirmations. |
| `/sessions export <id> [path]` | Export a session to a private Markdown file (default: `.kitcode-exports/`). |
| `/attach <path>` · `/attach clipboard` · `/attach clear` | Manage attachments for the next message. |
| `/compact` | Replace older conversation context with a concise model-generated summary. |
| `/subagents` | Show the current number of active sub-agents. |
| `/undo` | Undo built-in file edits from the latest message. |
| `/usage` | Show tokens, requests, cost, balance/key limits, and response rate-limit headers when available. |
| `/checker` | Check the local setup and provider model listing without sending a paid chat request. |
| `/prompt` | Insert a saved prompt. |
| `/prompt save <name>` | Save the latest message as a prompt. |
| `/skills` | Show discovered skills. |
| `/mcp add <name> <https://url>` | Add and connect a remote MCP server. |
| `/mcp add <name> -- <command> [args]` | Add and connect a local MCP server. |
| `/mcp list` | Show configured MCP servers and connection status. |
| `/mcp enable <name>` · `/mcp disable <name>` | Connect or disconnect an MCP server without removing it. |
| `/mcp delete <name>` | Disconnect and remove an MCP server. |
| `/theme` · `/lang` | Change the accent or interface language. |
| `/config` | Show the active config. |
| `/bypass` | Toggle approval-free operation. |
| `/help` · `/exit` | Show help or quit. |

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Enter` | Send a message or choose an item. |
| `↑` / `↓` | Browse input history or menu items. |
| `Tab` | Complete a slash command. |
| `Shift+Tab` | Cycle `normal → accept → plan`. |
| `Ctrl+V` / `Cmd+V` | Attach an image from the system clipboard; `/attach clipboard` is the explicit fallback. |
| `Esc` | Cancel the current request or close an overlay. |

Messages entered while the agent is running are queued and processed in order.

## Modes

- `normal` — file changes, shell commands, and MCP calls request approval when needed;
- `accept` — file edits are accepted automatically;
- `plan` — the agent explores the project and returns a plan without changing files.

The lower status panel shows the active mode, model, and usage. A left-to-right context capsule
stays on the right, changing from green to yellow at 60% and red at 85%, with the connected MCP
count below it. `ctx ?` means the provider has not returned exact usage for the current model yet.
Completed output is committed to
normal terminal scrollback, so it remains smooth to scroll while a response is streaming.

When exact usage reaches 80% of a known context window, KitCode automatically summarizes older
turns while keeping the latest two user turns. `/compact` runs the same operation manually.

Before the built-in `write` and `edit` tools change a file, KitCode creates a private checkpoint.
`/undo` restores the latest checkpoint and leaves files with newer manual changes untouched.
After a message changes files, KitCode detects common project checks such as `lint`, `typecheck`,
and `test`. The exact commands are shown for approval before they run.

## Configuration

KitCode uses these main paths:

| Path | Contents |
| --- | --- |
| `~/.kitcode/config.json` | Global settings. |
| `~/.kitcode/auth.json` | Provider keys. |
| `~/.kitcode/sessions/` | Saved sessions. |
| `~/.kitcode/checkpoints/` | Automatic file checkpoints used by `/undo`. |
| `~/.kitcode/prompts/` | Saved prompts. |
| `~/.kitcode/skills/` | Global skills. |
| `./.kitcode/skills/` | Project skills. |
| `./kitcode.json` | Project-local config. |

Minimal manual provider configuration:

```json
{
  "version": 1,
  "model": "openrouter/openai/gpt-5",
  "providers": {
    "openrouter": {
      "type": "openai",
      "baseUrl": "https://openrouter.ai/api/v1",
      "keyEnv": "OPENROUTER_API_KEY"
    }
  }
}
```

The main settings are `model`, `effort`, `thinking`, `maxTokens`, `budget`, and `diagnostics`,
`theme`, `permissions`, `providers`, and `mcp`. `budget` controls local per-message safety limits for model
requests, tokens, estimated cost (when model pricing is available), and subagents. These values are
not the provider's account balance or rate limits. `diagnostics.autoRun`
enables checks after file edits; `diagnostics.commands` can replace automatic detection with up to
eight explicit commands. KitCode checks npm for a newer version on every app start and prints the
upgrade command when one is available. `/update` repeats the check manually.
Manual editing is usually unnecessary: add a provider during onboarding
or with `/login`.

Project settings and project skills are enabled after reviewing the workspace and running:

```sh
kitcode trust
```

Run `kitcode trust --revoke` to return to global settings and skills for that workspace.

## MCP and skills

MCP supports local `stdio` servers and remote HTTP servers. Add one from the TUI and it connects
immediately without a restart:

```text
/mcp add docs https://mcp.example.com/mcp
/mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .
/mcp list
/mcp disable filesystem
/mcp enable filesystem
/mcp delete filesystem
```

The server is saved to the active config. Use `${env:NAME}` references in a manually configured
`env` or `headers` object when a server needs a secret; this keeps the secret itself out of the
config file:

```json
{
  "mcp": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${env:GITHUB_TOKEN}"
      }
    }
  }
}
```

A skill is a directory containing a `SKILL.md` file. Global skills live in
`~/.kitcode/skills`; project skills live in `./.kitcode/skills`.

Attachments support PNG, JPEG, GIF, and WebP images up to 10 MB, plus UTF-8 text files up to
256 KB. Pasting or dragging a standalone existing path queues it automatically and displays a
chip below the prompt. File contents are sent only when the attachment is submitted with a message.

## Development

```sh
npm run dev        # run the TypeScript entry point through tsx
npm run build      # build dist/index.js
npm run typecheck  # check TypeScript
npm test           # run the test suite
```

Project layout:

```text
src/app/        application startup and runtime
src/core/       agent loop, sessions, and usage
src/providers/  Anthropic and OpenAI-compatible adapters
src/tools/      file, shell, and utility tools
src/mcp/        MCP client and tool bridge
src/ui/         Ink TUI
test/           Vitest tests
```

## License

MIT
