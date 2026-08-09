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
        { type: 'paragraph', text: '**«Эффорт»** — это ты про `effort`/`reasoning_effort` параметр в GLM?' },
        { type: 'paragraph', text: '**Где используется GLM** — это API Zhipu/GLM, локальная модель?' },
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
    expect(blocks).toEqual([{ type: 'ul', items: [{ type: 'paragraph', text: 'a' }, { type: 'paragraph', text: 'b' }] }])
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

  it('parses fenced code blocks with language', () => {
    const md = '```typescript\nconst x = 1;\n```'
    const blocks = extractBlocks(md)
    expect(blocks).toEqual([{ type: 'code', lang: 'typescript', text: 'const x = 1;' }])
  })

  it('parses horizontal rules', () => {
    const md = '---'
    const blocks = extractBlocks(md)
    expect(blocks).toEqual([{ type: 'hr' }])
  })

  it('parses task list items', () => {
    const md = `- [x] done
- [ ] todo`
    const blocks = extractBlocks(md)
    expect(blocks).toEqual([
      {
        type: 'ul',
        items: [
          { type: 'paragraph', text: '☑ done' },
          { type: 'paragraph', text: '☐ todo' },
        ],
      },
    ])
  })

  it('parses a simple table with left-aligned columns', () => {
    const md = `| Name | Age |
|------|-----|
| Alice| 30  |
| Bob  | 25  |`
    const blocks = extractBlocks(md)
    expect(blocks).toEqual([
      {
        type: 'table',
        headers: ['Name', 'Age'],
        rows: [['Alice', '30'], ['Bob', '25']],
        colAligns: ['left', 'left'],
      },
    ])
  })

  it('parses table with right and center alignment', () => {
    const md = `| Left | Center | Right |
|:-----|:------:|------:|
| a    |   b    |     c |`
    const blocks = extractBlocks(md)
    expect(blocks).toEqual([
      {
        type: 'table',
        headers: ['Left', 'Center', 'Right'],
        rows: [['a', 'b', 'c']],
        colAligns: ['left', 'center', 'right'],
      },
    ])
  })

  it('parses table without leading/trailing pipes', () => {
    const md = `Name | Age
-----|----
Alice| 30`
    const blocks = extractBlocks(md)
    expect(blocks).toEqual([
      {
        type: 'table',
        headers: ['Name', 'Age'],
        rows: [['Alice', '30']],
        colAligns: ['left', 'left'],
      },
    ])
  })

  it('does not invent a table without a delimiter row', () => {
    const md = `just | some | text
not a table really`
    const blocks = extractBlocks(md)
    expect(blocks).toEqual([{ type: 'paragraph', text: 'just | some | text not a table really' }])
  })

  it('requires at least three dashes in every table delimiter cell', () => {
    const md = `| A | B |
| - | - |
| C | D |`
    expect(extractBlocks(md)).toEqual([
      { type: 'paragraph', text: '| A | B | | - | - | | C | D |' },
    ])
  })

  it('supports empty cells and pipes escaped or wrapped in code spans', () => {
    const md = `| A | B | C |
|---|---|---|
| x \\| y | | \`a|b\` |`
    expect(extractBlocks(md)).toEqual([
      {
        type: 'table',
        headers: ['A', 'B', 'C'],
        rows: [['x | y', '', '`a|b`']],
        colAligns: ['left', 'left', 'left'],
      },
    ])
  })

  it('does not treat code with || as a table', () => {
    const md = `if (x || y) {
  doSomething()
}`
    const blocks = extractBlocks(md)
    expect(blocks).toEqual([{ type: 'paragraph', text: 'if (x || y) { doSomething() }' }])
  })

  it('does not treat Windows paths with | as a table', () => {
    const md = `C:\\path|other`
    const blocks = extractBlocks(md)
    expect(blocks).toEqual([{ type: 'paragraph', text: 'C:\\path|other' }])
  })

  it('does not treat UNC paths with | as a table', () => {
    const md = `\\\\server\\share|file.txt`
    const blocks = extractBlocks(md)
    expect(blocks).toEqual([{ type: 'paragraph', text: '\\\\server\\share|file.txt' }])
  })

  it('does not treat a single column pipe line as a table', () => {
    const md = `| just one pipe`
    const blocks = extractBlocks(md)
    expect(blocks).toEqual([{ type: 'paragraph', text: '| just one pipe' }])
  })

  it('handles deeply nested inline formatting without stack overflow', () => {
    const md = `**bold *italic **bold *italic **bold *italic **bold *italic **bold *italic** text** more** text** more** text** more`
    const blocks = extractBlocks(md)
    expect(blocks[0].type).toBe('paragraph')
    expect(blocks[0].text).toContain('bold')
  })

  it('accepts common fenced-code info strings', () => {
    const md = '```c++ title="demo"\nstd::cout << "ok";\n```'
    expect(extractBlocks(md)).toEqual([
      { type: 'code', lang: 'c++', text: 'std::cout << "ok";' },
    ])
  })

  it('normalizes lone carriage returns and preserves hard line breaks', () => {
    expect(extractBlocks('first\r\rsecond')).toEqual([
      { type: 'paragraph', text: 'first' },
      { type: 'paragraph', text: 'second' },
    ])
    expect(extractBlocks('first  \nsecond')).toEqual([
      { type: 'paragraph', text: 'first\nsecond' },
    ])
  })

  it('parses setext headings and ordered-list starting numbers', () => {
    expect(extractBlocks('Long title\n==========')).toEqual([
      { type: 'heading', level: 1, text: 'Long title' },
    ])
    expect(extractBlocks('3. third\n4. fourth')).toEqual([
      {
        type: 'ol',
        start: 3,
        items: [
          { type: 'paragraph', text: 'third' },
          { type: 'paragraph', text: 'fourth' },
        ],
      },
    ])
  })

  it('keeps indented list continuation text in its item', () => {
    expect(extractBlocks('- first\n  indented\nlazy continuation')).toEqual([
      { type: 'ul', items: [{ type: 'paragraph', text: 'first indented lazy continuation' }] },
    ])
  })

  it('keeps a lazy blockquote continuation inside the quote', () => {
    expect(extractBlocks('> first line\nlazy continuation')).toEqual([
      { type: 'blockquote', text: 'first line\nlazy continuation' },
    ])
  })

  it('preserves nested list structure', () => {
    expect(extractBlocks('- parent\n  - child one\n  - child two\n- sibling')).toEqual([
      {
        type: 'ul',
        items: [
          {
            type: 'paragraph',
            text: 'parent',
            children: [
              {
                type: 'ul',
                items: [
                  { type: 'paragraph', text: 'child one' },
                  { type: 'paragraph', text: 'child two' },
                ],
              },
            ],
          },
          { type: 'paragraph', text: 'sibling' },
        ],
      },
    ])
  })

  it('bounds deeply nested lists instead of overflowing the stack', () => {
    const markdown = Array.from(
      { length: 100 },
      (_, depth) => `${'  '.repeat(depth)}- level ${depth}`,
    ).join('\n')
    expect(() => extractBlocks(markdown)).not.toThrow()
  })

  it('parses ASCII table without pipe borders', () => {
    const md = `Name     Age   City
───────────────────────
Alice    30    Moscow
Bob      25    SPb`
    const blocks = extractBlocks(md)
    expect(blocks[0].type).toBe('table')
    expect(blocks[0].headers).toEqual(['Name', 'Age', 'City'])
    expect(blocks[0].rows?.length).toBe(2)
    expect(blocks[0].rows?.[0]).toEqual(['Alice', '30', 'Moscow'])
  })
})
