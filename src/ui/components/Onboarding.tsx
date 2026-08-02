import { Box, Text } from 'ink'
import Spinner from 'ink-spinner'
import TextInput from 'ink-text-input'
import { useState } from 'react'
import { useStrings } from '../i18n'
import { useTheme } from '../theme'
import { Logo } from './Logo'

type Step = 'url' | 'key' | 'working'

export function Onboarding({ onSubmit }: { onSubmit(url: string, key: string): Promise<string> }) {
  const theme = useTheme()
  const strings = useStrings()
  const [step, setStep] = useState<Step>('url')
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [error, setError] = useState('')

  const submitKey = async (value: string) => {
    if (value.trim() === '') return
    setStep('working')
    setError('')
    try {
      await onSubmit(url.trim(), value.trim())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setKey('')
      setStep('key')
    }
  }

  return (
    <Box flexDirection="column">
      <Logo subtitle={strings.noProvider} />

      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor>{strings.onboardIntro}</Text>
        <Text dimColor>{strings.onboardExamples}</Text>
      </Box>

      {error !== '' && (
        <Box marginBottom={1}>
          <Text color={theme.error}>{error}</Text>
        </Box>
      )}

      {step === 'url' && (
        <Box>
          <Text color={theme.accent}>{strings.baseUrl}</Text>
          <TextInput
            value={url}
            onChange={setUrl}
            onSubmit={(value) => value.trim() !== '' && setStep('key')}
            placeholder="https://…"
          />
        </Box>
      )}

      {step === 'key' && (
        <Box flexDirection="column">
          <Text dimColor>{url}</Text>
          <Box>
            <Text color={theme.accent}>{strings.apiKey}</Text>
            <TextInput value={key} onChange={setKey} onSubmit={submitKey} mask="•" />
          </Box>
        </Box>
      )}

      {step === 'working' && (
        <Text color={theme.accent}>
          <Spinner type="dots" /> {strings.detecting}
        </Text>
      )}
    </Box>
  )
}
