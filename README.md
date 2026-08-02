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
- input history with the `↑` and `↓` keys;
- queued messages while the agent is working;
- token, estimated cost, and context-window indicators;
- automatic file checkpoints with `/undo`;
- detected project checks after file edits;
- model and provider switching from the TUI;
- MCP servers, skills, and subagents;
- English and Russian interfaces with configurable accents.

## Requirements

- Node.js 22 or newer;
- npm.

## Install from source

```sh
git clone https://github.com/PanicOnKernel/KitCode.git
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
| `/login` · `/logout` | Add or remove the current provider. |
| `/effort` · `/thinking` | Configure reasoning depth and output. |
| `/resume` · `/clear` | Resume a session or start a new one. |
| `/undo` | Undo built-in file edits from the latest message. |
| `/usage` | Show tokens, requests, cost, and provider-reported balance or key limit when available. |
| `/prompt` | Insert a saved prompt. |
| `/prompt save <name>` | Save the latest message as a prompt. |
| `/skills` | Show discovered skills. |
| `/mcp add <name> <https://url>` | Add and connect a remote MCP server. |
| `/mcp add <name> -- <command> [args]` | Add and connect a local MCP server. |
| `/mcp list` | Show configured MCP servers and connection status. |
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
| `Esc` | Cancel the current request or close an overlay. |

Messages entered while the agent is running are queued and processed in order.

## Modes

- `normal` — file changes, shell commands, and MCP calls request approval when needed;
- `accept` — file edits are accepted automatically;
- `plan` — the agent explores the project and returns a plan without changing files.

The lower status panel shows the active mode, model, and usage. A left-to-right context capsule
stays on the right, with the connected MCP count below it. Completed output is committed to
normal terminal scrollback, so it remains smooth to scroll while a response is streaming.

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

The main settings are `model`, `effort`, `thinking`, `maxTokens`, `budget`, `diagnostics`, `theme`,
`permissions`, `providers`, and `mcp`. `budget` controls local per-message safety limits for model
requests, tokens, estimated cost (when model pricing is available), and subagents. These values are
not the provider's account balance or rate limits. `diagnostics.autoRun`
enables checks after file edits; `diagnostics.commands` can replace automatic detection with up to
eight explicit commands. Manual editing is usually unnecessary: add a provider during onboarding
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
