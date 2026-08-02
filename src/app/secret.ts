import { emitKeypressEvents } from 'node:readline'

const MAX_KEY_CHARS = 16_384

export async function readApiKey(options: {
  keyEnv?: string
  keyStdin?: boolean
}): Promise<string> {
  if (options.keyEnv && options.keyStdin) {
    throw new Error('Use either --key-env or --key-stdin, not both.')
  }

  if (options.keyEnv) {
    const key = process.env[options.keyEnv]?.trim()
    if (!key) throw new Error(`Environment variable ${options.keyEnv} is empty or unset.`)
    return validateKey(key)
  }

  if (options.keyStdin) {
    const key = (await readStdin()).trim()
    if (!key) throw new Error('No API key was received on stdin.')
    return validateKey(key)
  }

  return promptSecret('API key: ')
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8')
  let value = ''
  for await (const chunk of process.stdin) {
    value += chunk
    if (value.length > MAX_KEY_CHARS) throw new Error('API key input is unexpectedly large.')
  }
  return value
}

function promptSecret(prompt: string): Promise<string> {
  const input = process.stdin
  const output = process.stderr
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('No interactive terminal. Pass the key through --key-env or --key-stdin.')
  }

  emitKeypressEvents(input)
  const wasRaw = input.isRaw
  const wasPaused = input.isPaused()
  output.write(prompt)
  input.setRawMode(true)
  input.resume()

  return new Promise<string>((resolve, reject) => {
    let value = ''
    const finish = (error?: Error) => {
      input.off('keypress', onKeypress)
      input.setRawMode(wasRaw)
      if (wasPaused) input.pause()
      output.write('\n')
      if (error) reject(error)
      else if (value.trim() === '') reject(new Error('API key cannot be empty.'))
      else {
        try {
          resolve(validateKey(value.trim()))
        } catch (validationError) {
          reject(validationError as Error)
        }
      }
    }
    const onKeypress = (
      character: string,
      key: { name?: string; ctrl?: boolean; meta?: boolean },
    ) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('Cancelled.'))
      if (key.name === 'return' || key.name === 'enter') return finish()
      if (key.name === 'backspace' || key.name === 'delete') {
        value = value.slice(0, -1)
        return
      }
      if (character && !key.ctrl && !key.meta && value.length < MAX_KEY_CHARS) value += character
    }
    input.on('keypress', onKeypress)
  })
}

function validateKey(value: string): string {
  if (value.length > MAX_KEY_CHARS) throw new Error('API key input is unexpectedly large.')
  if (/\r|\n/.test(value)) throw new Error('API key must be a single line.')
  return value
}
