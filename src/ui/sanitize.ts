/** Remove terminal control sequences from provider, tool, config, and file text. */
export function sanitizeTerminalText(value: unknown): string {
  const text = String(value ?? '')
  let output = ''

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)

    if (code === 0x1b) {
      const next = text.charCodeAt(index + 1)
      if (next === 0x5b) index = skipCsi(text, index + 2)
      else if (next === 0x5d) index = skipControlString(text, index + 2, true)
      else if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        index = skipControlString(text, index + 2, false)
      } else if (!Number.isNaN(next)) {
        index += 1
      }
      continue
    }

    if (code === 0x9b) {
      index = skipCsi(text, index + 1)
      continue
    }
    if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
      index = skipControlString(text, index + 1, code === 0x9d)
      continue
    }

    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)) {
      continue
    }
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) continue
    output += text[index]
  }

  return output
}

function skipCsi(text: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0x40 && code <= 0x7e) return index
  }
  return text.length - 1
}

function skipControlString(text: string, from: number, bellTerminates: boolean): number {
  for (let index = from; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (bellTerminates && code === 0x07) return index
    if (code === 0x9c) return index
    if (code === 0x1b && text.charCodeAt(index + 1) === 0x5c) return index + 1
  }
  return text.length - 1
}
