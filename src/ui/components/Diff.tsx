import { Box, Text } from 'ink'
import { diffLines, type DiffLine, truncate } from '../diff'

export function Diff({ before, after }: { before: string; after: string }) {
  const { hunk, hidden } = diffLines(before, after)
  return <DiffHunk lines={hunk} hidden={hidden} />
}

// Render a precomputed hunk. Lets a parent reuse one diffLines() call for both
// the visible diff and the +/- stat.
export function DiffHunk({ lines, hidden }: { lines: DiffLine[]; hidden: number }) {
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text
          key={index}
          color={line.kind === 'add' ? 'green' : line.kind === 'del' ? 'red' : 'gray'}
          dimColor={line.kind === 'ctx'}
        >
          {line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  '}
          {truncate(line.text, 110)}
        </Text>
      ))}
      {hidden > 0 && <Text dimColor>  … {hidden} more lines</Text>}
    </Box>
  )
}
