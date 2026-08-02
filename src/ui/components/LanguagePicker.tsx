import { Box, Text } from 'ink'
import { useState } from 'react'
import { LANGS } from '../i18n'
import type { Lang } from '../i18n'
import { useTheme } from '../theme'
import { useTerminalInput } from '../input'
import { Logo } from './Logo'

export function LanguagePicker({ onPick }: { onPick(lang: Lang): void }) {
  const theme = useTheme()
  const [cursor, setCursor] = useState(0)

  useTerminalInput((char, key) => {
    if (key.upArrow) return setCursor((index) => Math.max(0, index - 1))
    if (key.downArrow) return setCursor((index) => Math.min(LANGS.length - 1, index + 1))
    if (key.return) return onPick(LANGS[cursor]?.key ?? 'en')
    const digit = Number.parseInt(char, 10)
    if (digit >= 1 && digit <= LANGS.length) onPick(LANGS[digit - 1]?.key ?? 'en')
  })

  return (
    <Box flexDirection="column">
      <Logo subtitle="language · язык" />
      {LANGS.map((lang, index) => (
        <Text
          key={lang.key}
          color={index === cursor ? theme.accent : undefined}
          inverse={index === cursor}
        >
          {index + 1}. {lang.label}
        </Text>
      ))}
      <Text dimColor>↑↓ · enter</Text>
    </Box>
  )
}
