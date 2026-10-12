// A small, dependency-free highlighter for code blocks in answers. It tokenises
// one line at a time (strings, comments, numbers, keywords), which is enough to
// make code readable in a terminal without shipping a full grammar engine.

export type TokenKind = 'plain' | 'keyword' | 'string' | 'comment' | 'number' | 'literal' | 'type'

export interface Token {
  kind: TokenKind
  text: string
}

interface Grammar {
  keywords: Set<string>
  literals: Set<string>
  lineComment: string[]
  /** Block comment delimiters, e.g. C-style. */
  block?: [string, string]
  /** Triple-quoted strings (Python). */
  triple?: boolean
  /** Treat capitalised identifiers as types. */
  types?: boolean
}

const words = (list: string) => new Set(list.split(/\s+/).filter(Boolean))

const JS_KEYWORDS = words(`
  async await break case catch class const continue debugger default delete do else enum export
  extends finally for from function get if implements import in instanceof interface let new of
  package private protected public readonly return satisfies set static super switch this throw
  try type typeof var void while with yield as declare abstract keyof namespace`)

const GRAMMARS: Record<string, Grammar> = {
  js: { keywords: JS_KEYWORDS, literals: words('true false null undefined NaN Infinity'), lineComment: ['//'], block: ['/*', '*/'], types: true },
  py: {
    keywords: words(`and as assert async await break class continue def del elif else except finally for
      from global if import in is lambda nonlocal not or pass raise return try while with yield match case self`),
    literals: words('True False None'),
    lineComment: ['#'],
    triple: true,
    types: true,
  },
  go: {
    keywords: words(`break case chan const continue default defer else fallthrough for func go goto if import
      interface map package range return select struct switch type var`),
    literals: words('true false nil iota'),
    lineComment: ['//'],
    block: ['/*', '*/'],
    types: true,
  },
  rust: {
    keywords: words(`as async await break const continue crate dyn else enum extern fn for if impl in let loop
      match mod move mut pub ref return self Self static struct super trait type unsafe use where while`),
    literals: words('true false None Some Ok Err'),
    lineComment: ['//'],
    block: ['/*', '*/'],
    types: true,
  },
  c: {
    keywords: words(`auto break case char class const continue default delete do double else enum extern float
      for goto if inline int long namespace new private protected public return short signed sizeof static
      struct switch template this throw try typedef typename union unsigned using virtual void volatile while
      boolean byte extends final finally implements import instanceof interface package super synchronized throws var`),
    literals: words('true false null nullptr NULL'),
    lineComment: ['//'],
    block: ['/*', '*/'],
    types: true,
  },
  sh: {
    keywords: words(`if then else elif fi for while until do done case esac in function return export local
      readonly set unset shift exit echo cd source alias`),
    literals: words('true false'),
    lineComment: ['#'],
  },
  json: { keywords: new Set(), literals: words('true false null'), lineComment: [] },
  sql: {
    keywords: words(`select from where insert into values update set delete create table drop alter index join
      left right inner outer on group by order having limit offset as and or not null is in distinct union all
      primary key foreign references default SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE
      DROP ALTER INDEX JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT OFFSET AS AND OR NOT NULL IS IN
      DISTINCT UNION ALL PRIMARY KEY FOREIGN REFERENCES DEFAULT`),
    literals: words('true false TRUE FALSE'),
    lineComment: ['--'],
    block: ['/*', '*/'],
  },
}

const ALIASES: Record<string, string> = {
  js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', typescript: 'js', tsx: 'js',
  py: 'py', python: 'py',
  go: 'go', golang: 'go',
  rs: 'rust', rust: 'rust',
  c: 'c', h: 'c', cpp: 'c', 'c++': 'c', cc: 'c', hpp: 'c', cs: 'c', csharp: 'c', java: 'c', kotlin: 'c', kt: 'c', swift: 'c', php: 'c',
  sh: 'sh', bash: 'sh', zsh: 'sh', shell: 'sh', console: 'sh', powershell: 'sh', ps1: 'sh', ps: 'sh',
  json: 'json', jsonc: 'json', json5: 'json',
  sql: 'sql', postgres: 'sql', mysql: 'sql', sqlite: 'sql',
}

export function grammarFor(lang: string | undefined): string | undefined {
  return lang ? ALIASES[lang.toLowerCase()] : undefined
}

export interface HighlightState {
  /** Closing delimiter of a block comment or triple-quoted string still open. */
  open?: { kind: 'comment' | 'string'; close: string }
}

/** Highlights a whole code block; lines without a known grammar stay plain. */
export function highlightCode(code: string, lang: string | undefined): Token[][] {
  const grammar = GRAMMARS[grammarFor(lang) ?? '']
  const lines = code.split('\n')
  if (!grammar) return lines.map((line) => [{ kind: 'plain', text: line }])
  const state: HighlightState = {}
  return lines.map((line) => highlightLine(line, grammar, state))
}

function highlightLine(line: string, grammar: Grammar, state: HighlightState): Token[] {
  const tokens: Token[] = []
  const push = (kind: TokenKind, text: string) => {
    if (text === '') return
    const last = tokens.at(-1)
    if (last && last.kind === kind) last.text += text
    else tokens.push({ kind, text })
  }
  let i = 0

  if (state.open) {
    const end = line.indexOf(state.open.close)
    if (end === -1) {
      push(state.open.kind, line)
      return tokens
    }
    push(state.open.kind, line.slice(0, end + state.open.close.length))
    i = end + state.open.close.length
    state.open = undefined
  }

  while (i < line.length) {
    const rest = line.slice(i)
    const lineComment = grammar.lineComment.find((marker) => rest.startsWith(marker))
    if (lineComment) {
      push('comment', rest)
      break
    }
    if (grammar.block && rest.startsWith(grammar.block[0])) {
      const end = rest.indexOf(grammar.block[1], grammar.block[0].length)
      if (end === -1) {
        push('comment', rest)
        state.open = { kind: 'comment', close: grammar.block[1] }
        break
      }
      push('comment', rest.slice(0, end + grammar.block[1].length))
      i += end + grammar.block[1].length
      continue
    }
    if (grammar.triple && (rest.startsWith('"""') || rest.startsWith("'''"))) {
      const quote = rest.slice(0, 3)
      const end = rest.indexOf(quote, 3)
      if (end === -1) {
        push('string', rest)
        state.open = { kind: 'string', close: quote }
        break
      }
      push('string', rest.slice(0, end + 3))
      i += end + 3
      continue
    }
    const character = line[i]!
    if (character === '"' || character === "'" || character === '`') {
      let j = i + 1
      while (j < line.length && line[j] !== character) j += line[j] === '\\' ? 2 : 1
      push('string', line.slice(i, Math.min(line.length, j + 1)))
      i = j + 1
      continue
    }
    const number = /^(?:0x[0-9a-f_]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)/i.exec(rest)
    if (number && !/[\w$]/.test(line[i - 1] ?? '')) {
      push('number', number[0])
      i += number[0].length
      continue
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(rest)
    if (word) {
      const text = word[0]
      const kind: TokenKind = grammar.keywords.has(text)
        ? 'keyword'
        : grammar.literals.has(text)
          ? 'literal'
          : grammar.types && /^[A-Z][a-z0-9]/.test(text)
            ? 'type'
            : 'plain'
      push(kind, text)
      i += text.length
      continue
    }
    push('plain', character)
    i += 1
  }
  return tokens
}
