import { describe, expect, it } from 'vitest'
import { extractBlocks } from '../src/ui/markdown'

describe('markdown block parser', () => {
  it('parses a paragraph followed by an ordered list (chat example)', () => {
    const sample = `Чтобы ответить, мне нужно чуть больше контекста:

1. **«Эффорт»** — это ты про \`effort\`/\`reasoning_effort\` параметр в GLM?
2. **Где используется GLM** — это API Zhipu/GLM, локальная модель?`
    const blocks = extractBlocks(sample)
    expect(blocks[0]).toEqual({ type: 'paragraph', text: 'Чтобы ответить, мне нужно чуть больше контекста:' })
    expect(blocks[1]).toEqual({
      type: 'ol',
      items: [
        '**«Эффорт»** — это ты про `effort`/`reasoning_effort` параметр в GLM?',
        '**Где используется GLM** — это API Zhipu/GLM, локальная модель?',
      ],
    })
  })

  it('parses headings and blockquotes', () => {
    const md = `# Title

> a quote

## Sub`
    const blocks = extractBlocks(md)
    expect(blocks).toEqual([
      { type: 'heading', level: 1, text: 'Title' },
      { type: 'blockquote', text: 'a quote' },
      { type: 'heading', level: 2, text: 'Sub' },
    ])
  })

  it('parses unordered lists (dash, star, plus collapse into one list)', () => {
    const md = `- a
- b`
    const blocks = extractBlocks(md)
    expect(blocks).toEqual([{ type: 'ul', items: ['a', 'b'] }])
  })

  it('treats blank-separated runs as separate paragraphs', () => {
    const md = `first line continued

second paragraph`
    const blocks = extractBlocks(md)
    expect(blocks).toEqual([
      { type: 'paragraph', text: 'first line continued' },
      { type: 'paragraph', text: 'second paragraph' },
    ])
  })
})
