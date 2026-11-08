// Interpret the cursor/erase sequences emitted by Ink after a full clear.
// Counting raw writes is misleading: later frames overwrite earlier ones.
export function terminalScreen(output: string, columns: number, rows: number): string {
  let screen: string[][] = Array.from({ length: rows }, () => [])
  let saved: string[][] = []
  let row = 0
  let column = 0
  const newline = () => {
    row++
    if (row >= rows) { saved.push(screen.shift()!); screen.push([]); row = rows - 1 }
  }
  for (const token of output.match(/\x1b\[[0-?]*[ -/]*[@-~]|[^]/gu) ?? []) {
    if (token.startsWith('\x1b[')) {
      const command = token.at(-1)
      const args = token.slice(2, -1).split(';').map(Number)
      const n = args[0] || 1
      if (command === 'A') row = Math.max(0, row - n)
      else if (command === 'B') row = Math.min(rows - 1, row + n)
      else if (command === 'C') column = Math.min(columns - 1, column + n)
      else if (command === 'D') column = Math.max(0, column - n)
      else if (command === 'G') column = n - 1
      else if (command === 'H' || command === 'f') { row = n - 1; column = (args[1] || 1) - 1 }
      else if (command === 'K') {
        if (args[0] === 2) screen[row] = []
        else screen[row] = screen[row]!.slice(0, column)
      } else if (command === 'J') {
        if (args[0] === 3) saved = []
        else if (args[0] === 2) screen = Array.from({ length: rows }, () => [])
      }
      continue
    }
    if (token === '\r') { column = 0; continue }
    if (token === '\n') { column = 0; newline(); continue }
    if (token < ' ') continue
    if (column >= columns) { column = 0; newline() }
    while (screen[row]!.length < column) screen[row]!.push(' ')
    screen[row]![column++] = token
  }
  return [...saved, ...screen].map((line) => line.join('').trimEnd()).join('\n')
}
