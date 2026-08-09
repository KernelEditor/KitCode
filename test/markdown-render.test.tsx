import { renderToString } from 'ink'
import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../src/ui/markdown'

describe('markdown rendering', () => {
  it('renders fenced blocks without copyable frame decorations or padding', () => {
    const firstLine = 'Create a track with these parameters:'
    const secondLine = '- Genre: [specify genre]'
    const output = renderToString(
      <Markdown>{`\`\`\`text\n${firstLine}\n${secondLine}\n\`\`\``}</Markdown>,
      { columns: 160 },
    )
    const renderedLines = output.split('\n').filter(Boolean)

    expect(renderedLines).toEqual([firstLine, secondLine])
    expect(output).not.toMatch(/[│╭╮╰╯]/u)
  })

  it('does not truncate headings or add copyable quote decorations', () => {
    const heading = 'A heading that is intentionally much longer than the old arbitrary terminal limit of sixty-six characters'
    const output = renderToString(
      <Markdown>{`# ${heading}\n\n> **quoted content**`}</Markdown>,
      { columns: 160 },
    )

    expect(output).toContain(heading)
    expect(output).toContain('quoted content')
    expect(output).not.toContain('│')
    expect(output).not.toContain('…')
  })

  it('renders list markers without extra indentation', () => {
    const output = renderToString(<Markdown>{'- first\n- second'}</Markdown>, { columns: 80 })
    expect(output.split('\n')).toEqual(['• first', '• second'])
  })

  it('renders tasks and nested lists without duplicate bullets', () => {
    const output = renderToString(
      <Markdown>{'- [x] done\n- parent\n  - child'}</Markdown>,
      { columns: 80 },
    )
    expect(output.split('\n')).toEqual(['☑ done', '• parent', '  • child'])
  })

  it('renders combined, underscore, and escaped emphasis without leaking markers', () => {
    const output = renderToString(
      <Markdown>{'***both*** and _italic_ and \\*literal\\*'}</Markdown>,
      { columns: 80 },
    )
    expect(output).toBe('both and italic and *literal*')
  })

  it('does not mistake multiplication or identifiers for emphasis', () => {
    const output = renderToString(
      <Markdown>{'2 * 3 * 4 and foo_bar_baz'}</Markdown>,
      { columns: 80 },
    )
    expect(output).toBe('2 * 3 * 4 and foo_bar_baz')
  })

  it('handles parentheses in inline image destinations', () => {
    const output = renderToString(
      <Markdown>{'![plot](https://example.test/a_(b).png)'}</Markdown>,
      { columns: 80 },
    )
    expect(output).toBe('[img: plot]')
  })

  it('aligns full-width table content by terminal columns', () => {
    const output = renderToString(
      <Markdown>{`| City | Mark |
|---|---|
| 東京 | x |
| Рим | y |`}</Markdown>,
      { columns: 80 },
    )
    const lines = output.split('\n')

    const dividerColumns = lines
      .filter((line) => line.includes('│'))
      .map((line) => stringWidth(line.slice(0, line.indexOf('│'))))
    expect(dividerColumns).toEqual([5, 5, 5])
  })

  it('fits wide tables into a narrow terminal without wrapping rows', () => {
    const output = renderToString(
      <Markdown>{`| First column | Second column |
|---|---|
| a very long value | another very long value |`}</Markdown>,
      { columns: 24 },
    )
    const lines = output.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines.every((line) => stringWidth(line) <= 24)).toBe(true)
  })
})
