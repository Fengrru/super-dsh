/**
 * Repository map: a zero-dependency symbol index over the current workspace.
 *
 * This is deliberately smaller than a full code graph. It scans a bounded set
 * of source files, extracts declarations with regexes, resolves simple import
 * bindings, and ranks symbols by PageRank over file -> symbol reference edges.
 * Symbol ids include the relative file path, so same-named declarations in
 * different files never overwrite each other. The index is cached per root and
 * revalidated against every file's size and mtime before each tool call.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, posix, resolve } from 'node:path'
import type { PluginContext, SuperDshConfig, ToolDefinitionLike, ToolExecutionLike } from '../plugin-types.ts'
import { sessionCwd, sha256, warn } from '../shared.ts'

interface SourceFile {
  rel: string
  abs: string
  bytes: number
  mtimeMs: number
}

interface ScanResult {
  files: SourceFile[]
  truncated: boolean
}

interface IndexedSymbol {
  id: string
  name: string
  kind: string
  file: string
  line: number
  score: number
}

interface ImportBinding {
  file: string
  /** Original exported name when the local name is an alias. */
  importedName?: string
}

interface ExtractedImports {
  files: string[]
  bindings: Map<string, ImportBinding>
}

interface RepoIndex {
  root: string
  signature: string
  files: string[]
  symbols: IndexedSymbol[]
  byName: Map<string, IndexedSymbol[]>
  defsByFile: Map<string, IndexedSymbol[]>
  referencedBy: Map<string, string[]>
  importsByFile: Map<string, string[]>
  truncated: boolean
  maxScore: number
}

interface RepoMapOptions {
  root?: string
  maxFiles?: number
  maxFileBytes?: number
  /** Optional runtime switch for the natural-language search_code tool. */
  search?: boolean
}

type SearchMode = 'definition' | 'caller' | 'text'

interface SearchHit {
  name: string
  kind: string
  file: string
  line: number
  score: number
}

interface SymbolRule {
  re: RegExp
  kind: string
}

type Language = 'ts' | 'js' | 'py' | 'rs' | 'go' | 'java'

const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.next', 'coverage'])
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java'])
const DEFAULT_MAX_FILES = 2000
const DEFAULT_MAX_FILE_BYTES = 512 * 1024
const DEFAULT_LIMIT = 30
const MAX_LIMIT = 200
const PAGE_RANK_ITERATIONS = 18
const DAMPING = 0.85
const MAX_IMPACT = 50
const MAX_GRAPH_EDGES = 400_000
const IDENTIFIER_PATTERN = /[A-Za-z_$][\w$]*/g
const DEFAULT_SEARCH_LIMIT = 10
const MAX_SEARCH_LIMIT = 50
const TEXT_SYMBOLS_PER_FILE = 2

const SEARCH_STOPWORDS = new Set([
  'where', 'is', 'are', 'who', 'calls', 'call', 'used', 'by', 'find',
  'definition', 'defined', 'locate', 'declaration', 'function', 'class',
  'symbol', 'the', 'of', 'to', 'in', 'on', 'for', 'and', 'or',
])

const SEARCH_CALLER_PATTERN = /\b(?:who\s+calls?|callers?|used\s+by|references?|impact(?:s|ed)?)\b/i
const SEARCH_DEFINITION_PATTERN = /\b(?:where\s+(?:is|are)|defined|definition|locate|declaration|find\s+(?:function|class|symbol))\b/i

const RESERVED = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor', 'else', 'do',
  'try', 'finally', 'new', 'delete', 'typeof', 'void', 'throw', 'await', 'yield', 'super',
  'this', 'import', 'export', 'default', 'class', 'interface', 'type', 'const', 'let', 'var',
  'enum', 'case', 'break', 'continue', 'with', 'debugger', 'in', 'of', 'instanceof',
])

const TS_JS_RULES: SymbolRule[] = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function' },
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/, kind: 'type' },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=/, kind: 'const' },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?let\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=/, kind: 'let' },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?var\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=/, kind: 'var' },
  {
    re: /^\s+(?:(?:public|private|protected|static|async|readonly|override|abstract|declare|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\??\s*\([^;]*\)\s*(?::\s*[^{;]+)?\{/,
    kind: 'method',
  },
]

const PYTHON_RULES: SymbolRule[] = [
  { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, kind: 'def' },
  { re: /^\s*class\s+([A-Za-z_]\w*)\s*[(:]/, kind: 'class' },
]

const RUST_RULES: SymbolRule[] = [
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'fn' },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: 'struct' },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: 'enum' },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, kind: 'trait' },
  { re: /^\s*(?:unsafe\s+)?impl(?:<[^>]*>)?\s+(?:[\w<>,\s:]*?\s+for\s+)?([A-Za-z_]\w*)/, kind: 'impl' },
]

const GO_RULES: SymbolRule[] = [
  { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\(/, kind: 'func' },
  { re: /^\s*type\s+([A-Za-z_]\w*)/, kind: 'type' },
]

const JAVA_MODIFIERS = '(?:(?:public|protected|private|static|final|abstract|sealed|non-sealed|strictfp)\\s+)*'
const JAVA_RULES: SymbolRule[] = [
  { re: new RegExp(`^\\s*${JAVA_MODIFIERS}class\\s+([A-Za-z_$][\\w$]*)`), kind: 'class' },
  { re: new RegExp(`^\\s*${JAVA_MODIFIERS}interface\\s+([A-Za-z_$][\\w$]*)`), kind: 'interface' },
  { re: new RegExp(`^\\s*${JAVA_MODIFIERS}enum\\s+([A-Za-z_$][\\w$]*)`), kind: 'enum' },
  { re: new RegExp(`^\\s*${JAVA_MODIFIERS}record\\s+([A-Za-z_$][\\w$]*)`), kind: 'record' },
]

export function applyRepoMap(
  ctx: PluginContext,
  config: SuperDshConfig = {},
): void {
  if (config.repoMap === false) return
  const options: RepoMapOptions = typeof config.repoMap === 'object' && config.repoMap !== null
    ? config.repoMap
    : {}
  const maxFiles = clampInt(options.maxFiles ?? DEFAULT_MAX_FILES, 1, 100_000)
  const maxFileBytes = clampInt(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, 1, 64 * 1024 * 1024)
  const searchEnabled = options.search !== false
  const cache = new Map<string, RepoIndex>()

  ctx.systemPrompt.section({
    name: 'super-dsh:repo-map',
    order: 148,
    text: 'For unfamiliar code, use `repo_map` to see the most referenced symbols, `find_symbol` to locate a '
      + 'definition, and `impact_of` to find files that reference it. The map is a regex-based heuristic index '
      + '(imports and name occurrences, no type analysis); confirm with `read` before editing.'
      + (searchEnabled
        ? ' For natural-language questions use `search_code`; it routes definition queries ("where is X defined"),'
          + ' caller queries ("who calls X"), and text queries through the repository index automatically.'
        : ''),
  })

  const rootOf = async (exec: ToolExecutionLike): Promise<string> => {
    if (typeof options.root === 'string' && options.root.trim().length > 0) {
      return resolve(options.root)
    }
    return resolve(await sessionCwd(ctx, exec.agent, exec.signal))
  }

  const indexFor = async (exec: ToolExecutionLike): Promise<RepoIndex> => {
    const root = await rootOf(exec)
    if (!existsSync(root)) throw new Error(`repository root does not exist: ${root}`)
    let info
    try {
      info = statSync(root)
    } catch (error: unknown) {
      throw new Error(`could not stat repository root ${root}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!info.isDirectory()) throw new Error(`repository root is not a directory: ${root}`)

    const scan = scanRepository(root, maxFiles, maxFileBytes)
    const signature = repoSignature(root, scan.files, maxFiles, maxFileBytes)
    const cached = cache.get(root)
    if (cached !== undefined && cached.signature === signature) return cached
    const index = buildRepoIndex(root, scan, signature)
    cache.set(root, index)
    return index
  }

  const mapTool: ToolDefinitionLike = {
    name: 'repo_map',
    description: 'Show the most central symbols in the repository, or symbols matching a query. '
      + 'Without a query this lists top symbols by reference centrality; with a query it ranks name '
      + 'substring and token matches.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional symbol-name query (substring or word tokens).' },
        limit: { type: 'integer', description: 'Maximum symbols to return, 1..200. Defaults to 30.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          root: { type: 'string' },
          files: { type: 'integer', description: 'Number of indexed source files.' },
          symbols: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                kind: { type: 'string' },
                file: { type: 'string' },
                line: { type: 'integer' },
                score: { type: 'number', description: 'PageRank centrality normalized to 0..1.' },
              },
              required: ['name', 'kind', 'file', 'line', 'score'],
              additionalProperties: false,
            },
          },
          count: { type: 'integer' },
          truncated: { type: 'boolean' },
        },
        required: ['root', 'files', 'symbols', 'count', 'truncated'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const symbols = value.symbols as Array<{ name: string; kind: string; file: string; line: number }>
        const header = `Repository map: ${String(value.files)} file(s), ${String(value.count)} symbol(s) shown`
          + (value.truncated === true ? ' (truncated).' : '.')
        const lines = symbols.slice(0, 15).map(symbol => `- ${symbol.file}:${symbol.line} ${symbol.name} (${symbol.kind})`)
        return [{ type: 'text', text: lines.length === 0 ? header : `${header}\n${lines.join('\n')}` }]
      },
    },
    async execute(rawArgs: Record<string, unknown>, exec: ToolExecutionLike) {
      const index = await indexFor(exec)
      const limit = clampInt(rawArgs.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT)
      const query = typeof rawArgs.query === 'string' ? rawArgs.query.trim() : ''
      let selected: IndexedSymbol[]
      let truncated = index.truncated

      if (query.length === 0) {
        const sorted = index.symbols.slice().sort(compareByCentrality)
        truncated = truncated || sorted.length > limit
        selected = sorted.slice(0, limit)
      } else {
        const lowerQuery = query.toLowerCase()
        const tokens = [...new Set(lowerQuery.match(IDENTIFIER_PATTERN) ?? [])]
        const matches: Array<{ symbol: IndexedSymbol; match: number }> = []
        for (const symbol of index.symbols) {
          const match = queryMatchScore(symbol.name, lowerQuery, tokens)
          if (match > 0) matches.push({ symbol, match })
        }
        matches.sort((left, right) =>
          right.match - left.match
          || compareByCentrality(left.symbol, right.symbol))
        truncated = truncated || matches.length > limit
        selected = matches.slice(0, limit).map(match => match.symbol)
      }

      const symbols = selected.map(symbol => symbolSummary(symbol, index.maxScore))
      return {
        root: index.root,
        files: index.files.length,
        symbols,
        count: symbols.length,
        truncated,
      }
    },
  }

  const findTool: ToolDefinitionLike = {
    name: 'find_symbol',
    description: 'Locate defined symbols by exact name, prefix, or substring. '
      + 'Returns one entry per definition, including same-named symbols in different files.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name or name fragment.' },
        limit: { type: 'integer', description: 'Maximum results, 1..200. Defaults to 20.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          symbols: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                kind: { type: 'string' },
                file: { type: 'string' },
                line: { type: 'integer' },
                score: { type: 'number', description: 'Match quality with a small centrality tie-breaker.' },
              },
              required: ['name', 'kind', 'file', 'line', 'score'],
              additionalProperties: false,
            },
          },
          count: { type: 'integer' },
        },
        required: ['symbols', 'count'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const symbols = value.symbols as Array<{ name: string; kind: string; file: string; line: number; score: number }>
        if (symbols.length === 0) return [{ type: 'text', text: 'No matching symbols.' }]
        return [{
          type: 'text',
          text: symbols.map(symbol =>
            `${symbol.file}:${symbol.line} ${symbol.name} (${symbol.kind}, score ${symbol.score})`).join('\n'),
        }]
      },
    },
    async execute(rawArgs: Record<string, unknown>, exec: ToolExecutionLike) {
      const name = typeof rawArgs.name === 'string' ? rawArgs.name.trim() : ''
      if (name.length === 0) throw new Error('symbol name must be a non-empty string')
      const limit = clampInt(rawArgs.limit ?? 20, 1, MAX_LIMIT)
      const index = await indexFor(exec)
      const lowerName = name.toLowerCase()
      const matches: Array<{ symbol: IndexedSymbol; score: number }> = []
      for (const symbol of index.symbols) {
        const match = nameMatchScore(symbol.name, name, lowerName)
        if (match === 0) continue
        const centrality = index.maxScore > 0 ? symbol.score / index.maxScore : 0
        matches.push({ symbol, score: round(match + centrality * 0.1) })
      }
      matches.sort((left, right) =>
        right.score - left.score
        || compareByCentrality(left.symbol, right.symbol))
      const selected = matches.slice(0, limit)
      return {
        symbols: selected.map(entry => ({
          name: entry.symbol.name,
          kind: entry.symbol.kind,
          file: entry.symbol.file,
          line: entry.symbol.line,
          score: entry.score,
        })),
        count: selected.length,
      }
    },
  }

  const impactTool: ToolDefinitionLike = {
    name: 'impact_of',
    description: 'Find files and symbols that reference a defined symbol, by walking reverse reference '
      + 'edges breadth-first. Depth defaults to 2; results are deduplicated and capped at 50 entries.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Defined symbol name (case-insensitive exact match fallback).' },
        depth: { type: 'integer', description: 'Reference hops to follow, 1..8. Defaults to 2.' },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          symbols: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                kind: { type: 'string' },
                file: { type: 'string' },
                line: { type: 'integer' },
              },
              required: ['name', 'kind', 'file', 'line'],
              additionalProperties: false,
            },
          },
          count: { type: 'integer' },
          truncated: { type: 'boolean' },
        },
        required: ['symbol', 'files', 'symbols', 'count', 'truncated'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const files = value.files as string[]
        const symbols = value.symbols as Array<{ name: string; file: string; line: number }>
        const header = `Impact of ${String(value.symbol)}: ${files.length} file(s), ${symbols.length} symbol(s)`
          + (value.truncated === true ? ' (truncated)' : '')
        const lines = [
          ...files.slice(0, 10).map(file => `- ${file}`),
          ...symbols.slice(0, 10).map(symbol => `- ${symbol.file}:${symbol.line} ${symbol.name}`),
        ]
        return [{ type: 'text', text: lines.length === 0 ? `${header}; no referencing files found.` : `${header}\n${lines.join('\n')}` }]
      },
    },
    async execute(rawArgs: Record<string, unknown>, exec: ToolExecutionLike) {
      const requested = typeof rawArgs.symbol === 'string' ? rawArgs.symbol.trim() : ''
      if (requested.length === 0) throw new Error('symbol must be a non-empty string')
      const depth = clampInt(rawArgs.depth ?? 2, 1, 8)
      const index = await indexFor(exec)

      let definitions = index.byName.get(requested)
      if (definitions === undefined || definitions.length === 0) {
        const lower = requested.toLowerCase()
        definitions = index.symbols.filter(symbol => symbol.name.toLowerCase() === lower)
      }
      if (definitions.length === 0) {
        return { symbol: requested, files: [], symbols: [], count: 0, truncated: false }
      }

      const affectedFiles: string[] = []
      const affectedSymbols: IndexedSymbol[] = []
      const seenFiles = new Set<string>()
      const seenSymbols = new Set(definitions.map(symbol => symbol.id))
      let frontier = definitions.slice()
      let truncated = false

      walk: for (let level = 0; level < depth && frontier.length > 0; level++) {
        const next: IndexedSymbol[] = []
        for (const symbol of frontier) {
          for (const file of index.referencedBy.get(symbol.id) ?? []) {
            if (seenFiles.has(file)) continue
            if (affectedFiles.length + affectedSymbols.length >= MAX_IMPACT) {
              truncated = true
              break walk
            }
            seenFiles.add(file)
            affectedFiles.push(file)
            for (const definition of index.defsByFile.get(file) ?? []) {
              if (seenSymbols.has(definition.id)) continue
              if (affectedFiles.length + affectedSymbols.length >= MAX_IMPACT) {
                truncated = true
                break walk
              }
              seenSymbols.add(definition.id)
              affectedSymbols.push(definition)
              next.push(definition)
            }
          }
        }
        frontier = next
      }

      return {
        symbol: requested,
        files: affectedFiles,
        symbols: affectedSymbols.map(symbol => ({
          name: symbol.name,
          kind: symbol.kind,
          file: symbol.file,
          line: symbol.line,
        })),
        count: affectedFiles.length + affectedSymbols.length,
        truncated,
      }
    },
  }

  const searchTool: ToolDefinitionLike = {
    name: 'search_code',
    description: 'Natural-language code search over the repository index. Classifies the query as a '
      + 'definition lookup ("where is X defined"), a caller lookup ("who calls X"), or a text search, '
      + 'then returns ranked file and symbol hits with file:line locations.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language query, e.g. "where is validateSession defined", "who calls loadConfig", or "timeout handling".',
        },
        limit: { type: 'integer', description: 'Maximum results, 1..50. Defaults to 10.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          mode: { type: 'string', description: 'Effective search mode: definition, caller, or text.' },
          query: { type: 'string' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                kind: { type: 'string', description: 'Symbol kind, or "file" for file-level hits.' },
                file: { type: 'string' },
                line: { type: 'integer' },
                score: { type: 'number', description: 'Normalized relevance score in 0..1.' },
              },
              required: ['name', 'kind', 'file', 'line', 'score'],
              additionalProperties: false,
            },
          },
          count: { type: 'integer' },
        },
        required: ['mode', 'query', 'results', 'count'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const results = value.results as SearchHit[]
        const header = `Search [${String(value.mode)}] "${String(value.query)}": ${String(value.count)} result(s)`
        if (results.length === 0) return [{ type: 'text', text: `${header}; no matches.` }]
        return [{
          type: 'text',
          text: `${header}\n${results.map(hit =>
            `${hit.file}:${hit.line} ${hit.name} (${hit.kind}, ${hit.score})`).join('\n')}`,
        }]
      },
    },
    async execute(rawArgs: Record<string, unknown>, exec: ToolExecutionLike) {
      const query = typeof rawArgs.query === 'string' ? rawArgs.query.trim() : ''
      if (query.length === 0) throw new Error('query must be a non-empty string')
      const limit = clampInt(rawArgs.limit ?? DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT)
      const index = await indexFor(exec)
      const classified = classifySearchQuery(query)
      const identifier = extractSearchIdentifier(query, index.byName)

      let mode: SearchMode = classified
      let results: SearchHit[] = []
      if (classified === 'definition' && identifier !== undefined) {
        results = searchDefinitions(index, identifier, limit)
      } else if (classified === 'caller' && identifier !== undefined) {
        results = searchCallers(index, identifier, limit)
      }

      // Definition/caller hits take priority; fall back to a lexical text scan
      // when the routed mode finds nothing.
      if (results.length === 0) {
        mode = 'text'
        results = searchText(index, query, limit)
      }

      return { mode, query, results, count: results.length }
    },
  }

  const tools = searchEnabled ? [mapTool, findTool, impactTool, searchTool] : [mapTool, findTool, impactTool]
  for (const tool of tools) {
    try {
      ctx.tools.register(tool)
    } catch (error: unknown) {
      warn(ctx.logger, `could not register ${tool.name}`, error)
    }
  }
}

function classifySearchQuery(query: string): SearchMode {
  if (SEARCH_CALLER_PATTERN.test(query)) return 'caller'
  if (SEARCH_DEFINITION_PATTERN.test(query)) return 'definition'
  return 'text'
}

/**
 * Pick the identifier a definition/caller query is about. Tokens that already
 * name an indexed symbol win, longest first; otherwise the longest surviving
 * token is the best guess.
 */
function extractSearchIdentifier(
  query: string,
  byName: Map<string, IndexedSymbol[]>,
): string | undefined {
  const tokens: string[] = []
  const seen = new Set<string>()
  for (const token of query.match(IDENTIFIER_PATTERN) ?? []) {
    const lower = token.toLowerCase()
    if (SEARCH_STOPWORDS.has(lower) || seen.has(lower)) continue
    seen.add(lower)
    tokens.push(token)
  }
  if (tokens.length === 0) return undefined

  const exact = tokens.filter(token => byName.has(token))
  if (exact.length > 0) return longestToken(exact)

  const lowerNames = new Set<string>()
  for (const name of byName.keys()) lowerNames.add(name.toLowerCase())
  const relaxed = tokens.filter(token => lowerNames.has(token.toLowerCase()))
  if (relaxed.length > 0) return longestToken(relaxed)
  return longestToken(tokens)
}

function longestToken(tokens: string[]): string {
  let best = tokens[0]
  for (const token of tokens) {
    if (token.length > best.length) best = token
  }
  return best
}

function matchDefinitions(
  index: RepoIndex,
  identifier: string,
): Array<{ symbol: IndexedSymbol; score: number }> {
  const lowerIdentifier = identifier.toLowerCase()
  const matches: Array<{ symbol: IndexedSymbol; score: number }> = []
  for (const symbol of index.symbols) {
    const score = nameMatchScore(symbol.name, identifier, lowerIdentifier)
    if (score > 0) matches.push({ symbol, score })
  }
  matches.sort((left, right) =>
    right.score - left.score
    || compareByCentrality(left.symbol, right.symbol))
  return matches
}

function searchDefinitions(index: RepoIndex, identifier: string, limit: number): SearchHit[] {
  return matchDefinitions(index, identifier).slice(0, limit).map(match => ({
    name: match.symbol.name,
    kind: match.symbol.kind,
    file: match.symbol.file,
    line: match.symbol.line,
    score: round(match.score),
  }))
}

/**
 * Direct callers: one reverse-reference hop from every definition, plus the
 * symbols each referencing file defines. File-level hits make the referencing
 * file visible even when it has no extractable declarations.
 */
function searchCallers(index: RepoIndex, identifier: string, limit: number): SearchHit[] {
  const definitions = matchDefinitions(index, identifier)
  const results: SearchHit[] = []
  const seenHits = new Set<string>()
  const seenFiles = new Set<string>()

  for (const definition of definitions) {
    for (const file of index.referencedBy.get(definition.symbol.id) ?? []) {
      if (!seenFiles.has(file)) {
        seenFiles.add(file)
        if (pushSearchHit(results, seenHits, {
          name: file,
          kind: 'file',
          file,
          line: 1,
          score: round(definition.score),
        }, limit)) return results
      }
      for (const symbol of index.defsByFile.get(file) ?? []) {
        if (pushSearchHit(results, seenHits, {
          name: symbol.name,
          kind: symbol.kind,
          file: symbol.file,
          line: symbol.line,
          score: round(definition.score * 0.75),
        }, limit)) return results
      }
    }
  }
  return results
}

function searchText(index: RepoIndex, query: string, limit: number): SearchHit[] {
  const tokens = extractTextTokens(query)
  if (tokens.length === 0) return []

  const ranked: Array<{ file: string; count: number }> = []
  let maxCount = 0
  for (const file of index.files) {
    let text: string
    try {
      text = readFileSync(join(index.root, file), 'utf8')
    } catch {
      continue
    }
    let count = 0
    for (const token of tokens) count += countWordOccurrences(text, token)
    if (count === 0) continue
    ranked.push({ file, count })
    if (count > maxCount) maxCount = count
  }

  ranked.sort((left, right) => right.count - left.count || compareText(left.file, right.file))
  const results: SearchHit[] = []
  const seenHits = new Set<string>()
  for (const entry of ranked.slice(0, limit)) {
    if (pushSearchHit(results, seenHits, {
      name: entry.file,
      kind: 'file',
      file: entry.file,
      line: 1,
      score: maxCount > 0 ? round(entry.count / maxCount) : 0,
    }, limit)) break

    const symbols = (index.defsByFile.get(entry.file) ?? [])
      .slice()
      .sort(compareByCentrality)
      .slice(0, TEXT_SYMBOLS_PER_FILE)
    for (const symbol of symbols) {
      if (pushSearchHit(results, seenHits, {
        name: symbol.name,
        kind: symbol.kind,
        file: symbol.file,
        line: symbol.line,
        score: index.maxScore > 0 ? round(symbol.score / index.maxScore) : 0,
      }, limit)) break
    }
    if (results.length >= limit) break
  }
  return results
}

function extractTextTokens(query: string): string[] {
  const tokens: string[] = []
  const seen = new Set<string>()
  for (const token of query.match(IDENTIFIER_PATTERN) ?? []) {
    const lower = token.toLowerCase()
    if (SEARCH_STOPWORDS.has(lower) || seen.has(lower)) continue
    seen.add(lower)
    tokens.push(lower)
  }
  return tokens
}

function countWordOccurrences(text: string, token: string): number {
  if (token.length === 0) return 0
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_$])${escapeRegExp(token)}(?![A-Za-z0-9_$])`,
    'gi',
  )
  return text.match(pattern)?.length ?? 0
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Push a hit unless its file+name+line key was already seen; report whether the limit is full. */
function pushSearchHit(
  results: SearchHit[],
  seen: Set<string>,
  hit: SearchHit,
  limit: number,
): boolean {
  const key = `${hit.file}\u0000${hit.name}\u0000${hit.line}`
  if (!seen.has(key)) {
    seen.add(key)
    results.push(hit)
  }
  return results.length >= limit
}

function scanRepository(root: string, maxFiles: number, maxFileBytes: number): ScanResult {
  const all: SourceFile[] = []
  let skippedLarge = 0

  const walk = (absDir: string, relDir: string): void => {
    let entries
    try {
      entries = readdirSync(absDir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((left, right) => compareText(left.name, right.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const rel = relDir.length === 0 ? entry.name : `${relDir}/${entry.name}`
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) continue
        walk(join(absDir, entry.name), rel)
        continue
      }
      if (!entry.isFile()) continue
      if (!SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
      const abs = join(absDir, entry.name)
      let info
      try {
        info = statSync(abs)
      } catch {
        continue
      }
      if (!info.isFile()) continue
      if (info.size > maxFileBytes) {
        skippedLarge++
        continue
      }
      all.push({ rel, abs, bytes: info.size, mtimeMs: info.mtimeMs })
    }
  }

  walk(root, '')
  all.sort((left, right) => compareText(left.rel, right.rel))
  return {
    files: all.slice(0, maxFiles),
    truncated: all.length > maxFiles || skippedLarge > 0,
  }
}

function repoSignature(
  root: string,
  files: SourceFile[],
  maxFiles: number,
  maxFileBytes: number,
): string {
  return sha256(JSON.stringify({
    root,
    maxFiles,
    maxFileBytes,
    files: files.map(file => [file.rel, file.bytes, Math.round(file.mtimeMs * 1000)]),
  }))
}

function buildRepoIndex(root: string, scan: ScanResult, signature: string): RepoIndex {
  const readable: SourceFile[] = []
  const files: string[] = []
  const symbols: IndexedSymbol[] = []
  const defsByFile = new Map<string, IndexedSymbol[]>()

  for (const file of scan.files) {
    let text: string
    try {
      text = readFileSync(file.abs, 'utf8')
    } catch {
      continue
    }
    readable.push(file)
    files.push(file.rel)
    const extracted = extractSymbols(file.rel, text)
    if (extracted.length > 0) defsByFile.set(file.rel, extracted)
    symbols.push(...extracted)
  }

  const byName = new Map<string, IndexedSymbol[]>()
  for (const symbol of symbols) {
    const list = byName.get(symbol.name)
    if (list === undefined) byName.set(symbol.name, [symbol])
    else list.push(symbol)
  }

  const fileSet = new Set(files)
  const importsByFile = new Map<string, string[]>()
  const referencesByFile = new Map<string, Set<string>>()
  for (const file of readable) {
    let text: string
    try {
      text = readFileSync(file.abs, 'utf8')
    } catch {
      continue
    }
    const language = languageOf(file.rel)
    const extracted = extractImports(file.rel, text, language, fileSet)
    importsByFile.set(file.rel, extracted.files)

    const referenceText = stripImportStatements(text, language)
    const tokens = new Set(referenceText.match(IDENTIFIER_PATTERN) ?? [])
    const definedNames = new Set((defsByFile.get(file.rel) ?? []).map(symbol => symbol.name))
    const refs = new Set<string>()

    // An import is itself a reference, even when the imported name is never
    // used in the body. Bindings are resolved to the importing file's symbols.
    for (const [local, binding] of extracted.bindings) {
      const importedName = binding.importedName ?? local
      for (const symbol of byName.get(importedName) ?? []) {
        if (symbol.file === binding.file) refs.add(symbol.id)
      }
    }

    for (const token of tokens) {
      if (definedNames.has(token)) continue
      const binding = extracted.bindings.get(token)
      if (binding !== undefined) {
        const importedName = binding.importedName ?? token
        for (const symbol of byName.get(importedName) ?? []) {
          if (symbol.file === binding.file) refs.add(symbol.id)
        }
        continue
      }
      for (const symbol of byName.get(token) ?? []) refs.add(symbol.id)
    }
    if (refs.size > 0) referencesByFile.set(file.rel, refs)
  }

  const referencedBy = new Map<string, string[]>()
  for (const [file, ids] of referencesByFile) {
    for (const id of ids) {
      const list = referencedBy.get(id)
      if (list === undefined) referencedBy.set(id, [file])
      else list.push(file)
    }
  }

  const nodes = symbols.map(symbol => `s:${symbol.id}`)
  const nodeSet = new Set(nodes)
  const adjacency = new Map<string, Set<string>>()
  let edgeCount = 0
  let edgesTruncated = false

  const addEdge = (from: string, to: string): void => {
    if (from === to || !nodeSet.has(to)) return
    let targets = adjacency.get(from)
    if (targets === undefined) {
      targets = new Set<string>()
      adjacency.set(from, targets)
    }
    if (targets.has(to)) return
    if (edgeCount >= MAX_GRAPH_EDGES) {
      edgesTruncated = true
      return
    }
    targets.add(to)
    edgeCount++
  }

  // Project file-level references onto the symbols each file defines: a
  // symbol inherits the files that reference anything defined beside it.
  fileLoop: for (const file of files) {
    const sources = defsByFile.get(file) ?? []
    if (sources.length === 0) continue
    const targets = new Set<string>(referencesByFile.get(file) ?? [])
    for (const imported of importsByFile.get(file) ?? []) {
      for (const symbol of defsByFile.get(imported) ?? []) targets.add(symbol.id)
    }
    for (const source of sources) {
      for (const target of targets) {
        if (edgeCount >= MAX_GRAPH_EDGES) {
          edgesTruncated = true
          break fileLoop
        }
        addEdge(`s:${source.id}`, `s:${target}`)
      }
    }
  }

  const ranks = pageRank(nodes, adjacency)
  let maxScore = 0
  for (const symbol of symbols) {
    symbol.score = ranks.get(`s:${symbol.id}`) ?? 0
    if (symbol.score > maxScore) maxScore = symbol.score
  }

  return {
    root,
    signature,
    files,
    symbols,
    byName,
    defsByFile,
    referencedBy,
    importsByFile,
    truncated: scan.truncated || edgesTruncated,
    maxScore,
  }
}

function extractSymbols(file: string, text: string): IndexedSymbol[] {
  const rules = rulesFor(languageOf(file))
  const symbols: IndexedSymbol[] = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line.trim().length === 0) continue
    const seen = new Set<string>()
    for (const rule of rules) {
      const match = rule.re.exec(line)
      if (match === null) continue
      const name = match[1]
      if (name === undefined || name.length === 0 || RESERVED.has(name) || seen.has(name)) continue
      seen.add(name)
      symbols.push({
        id: `${file}:${index + 1}:${name}`,
        name,
        kind: rule.kind,
        file,
        line: index + 1,
        score: 0,
      })
    }
  }
  return symbols
}

function rulesFor(language: Language): SymbolRule[] {
  switch (language) {
    case 'ts':
    case 'js': return TS_JS_RULES
    case 'py': return PYTHON_RULES
    case 'rs': return RUST_RULES
    case 'go': return GO_RULES
    case 'java': return JAVA_RULES
  }
}

function languageOf(file: string): Language {
  switch (extname(file).toLowerCase()) {
    case '.ts':
    case '.tsx': return 'ts'
    case '.js':
    case '.jsx': return 'js'
    case '.py': return 'py'
    case '.rs': return 'rs'
    case '.go': return 'go'
    case '.java': return 'java'
    default: return 'ts'
  }
}

function extractImports(
  file: string,
  text: string,
  language: Language,
  fileSet: Set<string>,
): ExtractedImports {
  switch (language) {
    case 'ts':
    case 'js': return extractTsImports(file, text, fileSet)
    case 'py': return extractPythonImports(file, text, fileSet)
    case 'rs': return extractRustImports(text, fileSet)
    case 'go': return extractGoImports(text, fileSet)
    case 'java': return extractJavaImports(file, text, fileSet)
  }
}

function extractTsImports(file: string, text: string, fileSet: Set<string>): ExtractedImports {
  const files = new Set<string>()
  const bindings = new Map<string, ImportBinding>()

  const fromRe = /\b(?:import|export)\s+(?:type\s+)?([^'";{}\n]*?(?:\{[^}]*\}[^'";{}\n]*?)?)\s+from\s+['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = fromRe.exec(text)) !== null) {
    const target = resolveRelativeModule(file, match[2], fileSet)
    if (target === undefined) continue
    files.add(target)
    for (const [local, imported] of parseTsClause(match[1])) {
      bindings.set(local, imported === local ? { file: target } : { file: target, importedName: imported })
    }
  }

  const callRe = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((match = callRe.exec(text)) !== null) {
    const target = resolveRelativeModule(file, match[1], fileSet)
    if (target !== undefined) files.add(target)
  }

  const sideRe = /\bimport\s+['"]([^'"]+)['"]/g
  while ((match = sideRe.exec(text)) !== null) {
    const target = resolveRelativeModule(file, match[1], fileSet)
    if (target !== undefined) files.add(target)
  }

  const requireRe = /\b(?:const|let|var)\s+([^=;]+?)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((match = requireRe.exec(text)) !== null) {
    const target = resolveRelativeModule(file, match[2], fileSet)
    if (target === undefined) continue
    files.add(target)
    for (const [local, imported] of parseRequireClause(match[1])) {
      bindings.set(local, imported === local ? { file: target } : { file: target, importedName: imported })
    }
  }

  return { files: [...files], bindings }
}

function parseTsClause(clause: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  const brace = clause.match(/\{([\s\S]*)\}/)
  if (brace !== null) pairs.push(...parseNamedBindings(brace[1]))
  const head = (brace === null ? clause : clause.slice(0, brace.index)).trim()
  for (const raw of head.split(',')) {
    const part = raw.trim().replace(/^type\s+/, '').replace(/^default\s+/, '')
    if (/^[A-Za-z_$][\w$]*$/.test(part)) pairs.push([part, part])
  }
  return pairs
}

function parseNamedBindings(inner: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (const raw of inner.split(',')) {
    const part = raw.trim().replace(/^type\s+/, '')
    if (part.length === 0) continue
    const match = part.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/)
    if (match === null) continue
    pairs.push([match[2] ?? match[1], match[1]])
  }
  return pairs
}

function parseRequireClause(clause: string): Array<[string, string]> {
  const trimmed = clause.trim()
  const brace = trimmed.match(/^\{([\s\S]*)\}$/)
  if (brace !== null) return parseNamedBindings(brace[1])
  const identifier = trimmed.match(/^([A-Za-z_$][\w$]*)$/)
  return identifier === null ? [] : [[identifier[1], identifier[1]]]
}

function extractPythonImports(file: string, text: string, fileSet: Set<string>): ExtractedImports {
  const files = new Set<string>()
  const bindings = new Map<string, ImportBinding>()

  const fromRe = /^\s*from\s+([.\w]+)\s+import\s+([^\n#]+)/gm
  let match: RegExpExecArray | null
  while ((match = fromRe.exec(text)) !== null) {
    const target = resolvePythonModule(file, match[1], fileSet)
    if (target === undefined) continue
    files.add(target)
    const names = match[2].replace(/[()]/g, '').trim()
    for (const raw of names.split(',')) {
      const part = raw.trim()
      if (part.length === 0 || part === '*') continue
      const nameMatch = part.match(/^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/)
      if (nameMatch === null) continue
      const imported = nameMatch[1]
      const local = nameMatch[2] ?? imported
      bindings.set(local, imported === local ? { file: target } : { file: target, importedName: imported })
    }
  }

  const importRe = /^\s*import\s+([.\w]+(?:\s*,\s*[.\w]+)*)/gm
  while ((match = importRe.exec(text)) !== null) {
    for (const raw of match[1].split(',')) {
      const spec = raw.trim().replace(/\s+as\s+\w+$/, '')
      if (spec.length === 0) continue
      const target = resolvePythonModule(file, spec, fileSet)
      if (target !== undefined) files.add(target)
    }
  }

  return { files: [...files], bindings }
}

function extractRustImports(text: string, fileSet: Set<string>): ExtractedImports {
  const files = new Set<string>()
  const bindings = new Map<string, ImportBinding>()
  const useRe = /^\s*(?:pub\s+)?use\s+([^;]+);/gm
  let match: RegExpExecArray | null
  while ((match = useRe.exec(text)) !== null) {
    const parsed = parseRustUse(match[1])
    if (parsed === undefined) continue
    const target = resolveRustModule(parsed.moduleExpr, fileSet)
    if (target === undefined) continue
    files.add(target)
    for (const item of parsed.items) {
      if (item.imported === '*') continue
      bindings.set(item.local, item.imported === item.local
        ? { file: target }
        : { file: target, importedName: item.imported })
    }
  }
  return { files: [...files], bindings }
}

function parseRustUse(expr: string): { moduleExpr: string; items: Array<{ imported: string; local: string }> } | undefined {
  const body = expr.trim()
  if (body.length === 0) return undefined
  const group = body.match(/^(.*?)\s*::\s*\{([\s\S]*)\}$/)
  if (group !== null) {
    const items = group[2].split(',').map(parseRustItem).filter((item): item is { imported: string; local: string } => item !== undefined)
    return { moduleExpr: group[1].trim(), items }
  }
  const parts = body.split('::').map(part => part.trim()).filter(part => part.length > 0)
  if (parts.length === 0) return undefined
  const item = parseRustItem(parts[parts.length - 1])
  if (item === undefined) return undefined
  return { moduleExpr: parts.slice(0, -1).join('::'), items: [item] }
}

function parseRustItem(raw: string): { imported: string; local: string } | undefined {
  const part = raw.trim()
  if (part.length === 0) return undefined
  if (part === '*') return { imported: '*', local: '*' }
  const alias = part.match(/^([A-Za-z_]\w*)\s+as\s+([A-Za-z_]\w*)$/)
  if (alias !== null) return { imported: alias[1], local: alias[2] }
  return /^[A-Za-z_]\w*$/.test(part) ? { imported: part, local: part } : undefined
}

function extractGoImports(text: string, fileSet: Set<string>): ExtractedImports {
  const files = new Set<string>()
  const bindings = new Map<string, ImportBinding>()

  const singleRe = /^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm
  let match: RegExpExecArray | null
  while ((match = singleRe.exec(text)) !== null) {
    const target = resolveGoPackage(match[1], fileSet)
    if (target !== undefined) files.add(target)
  }

  const blockRe = /^\s*import\s*\(([\s\S]*?)\)/gm
  while ((match = blockRe.exec(text)) !== null) {
    const innerRe = /(?:\w+\s+)?"([^"]+)"/g
    let inner: RegExpExecArray | null
    while ((inner = innerRe.exec(match[1])) !== null) {
      const target = resolveGoPackage(inner[1], fileSet)
      if (target !== undefined) files.add(target)
    }
  }

  return { files: [...files], bindings }
}

function extractJavaImports(file: string, text: string, fileSet: Set<string>): ExtractedImports {
  const files = new Set<string>()
  const bindings = new Map<string, ImportBinding>()
  const importRe = /^\s*import\s+(static\s+)?([\w.]+)\s*;/gm
  let match: RegExpExecArray | null
  while ((match = importRe.exec(text)) !== null) {
    const isStatic = match[1] !== undefined
    const parts = match[2].split('.').filter(part => part.length > 0)
    if (parts.length === 0) continue
    const className = isStatic && parts.length > 1 ? parts[parts.length - 2] : parts[parts.length - 1]
    const classParts = isStatic && parts.length > 1 ? parts.slice(0, -1) : parts
    const target = resolveSuffix(classParts.join('/') + '.java', fileSet)
    if (target === undefined) continue
    files.add(target)
    if (!isStatic) bindings.set(className, { file: target })
  }
  return { files: [...files], bindings }
}

function stripImportStatements(text: string, language: Language): string {
  switch (language) {
    case 'ts':
    case 'js':
      return text
        .replace(/\b(?:import|export)\s+(?:type\s+)?(?:[^'";{}\n]*?(?:\{[^}]*\}[^'";{}\n]*?)?\s+from\s+)?['"][^'"]*['"]\s*;?/g, '\n')
        .replace(/\b(?:const|let|var)\s+[^=;\n]+=\s*require\s*\(\s*['"][^'"]*['"]\s*\)\s*;?/g, '\n')
        .replace(/\bimport\s*\(\s*['"][^'"]*['"]\s*\)/g, '\n')
    case 'py':
      return text.replace(/^\s*(?:from\s+\S+\s+import\s+.*|import\s+.*)$/gm, '')
    case 'rs':
      return text.replace(/^\s*(?:pub\s+)?use\s+[^;]*;/gm, '')
    case 'go':
      return text.replace(/^\s*import\s+(?:\([\s\S]*?\)|(?:[\w.]+\s+)?"[^"]+")/gm, '')
    case 'java':
      return text.replace(/^\s*import\s+[^;]*;/gm, '')
  }
}

function resolveRelativeModule(fromFile: string, specifier: string, fileSet: Set<string>): string | undefined {
  if (!specifier.startsWith('.')) {
    // A bare specifier can still be a project-internal alias; try a suffix match.
    return resolveSuffix(specifier.replace(/^~\//, '').replace(/^@\//, ''), fileSet)
  }
  const base = posix.normalize(posix.join(posix.dirname(fromFile), specifier))
  if (base === '..' || base.startsWith('../') || posix.isAbsolute(base)) return undefined
  const ext = posix.extname(base)
  const candidates: string[] = []
  if (ext.length > 0) {
    candidates.push(base)
    if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
      const stem = base.slice(0, -ext.length)
      candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.jsx`)
    }
  } else {
    for (const candidateExt of ['.ts', '.tsx', '.js', '.jsx']) candidates.push(`${base}${candidateExt}`)
    for (const candidateExt of ['.ts', '.tsx', '.js', '.jsx']) candidates.push(posix.join(base, `index${candidateExt}`))
  }
  return candidates.find(candidate => fileSet.has(candidate))
}

function resolvePythonModule(fromFile: string, specifier: string, fileSet: Set<string>): string | undefined {
  if (specifier.startsWith('.')) {
    const dots = (specifier.match(/^\.+/) ?? [''])[0].length
    const rest = specifier.slice(dots).replace(/\./g, '/')
    let baseDir = posix.dirname(fromFile)
    for (let index = 1; index < dots; index++) baseDir = posix.dirname(baseDir)
    const base = posix.normalize(posix.join(baseDir, rest))
    if (base === '..' || base.startsWith('../') || posix.isAbsolute(base)) return undefined
    return pythonModuleFile(base, fileSet)
  }
  return pythonModuleFile(specifier.replace(/\./g, '/'), fileSet)
}

function pythonModuleFile(base: string, fileSet: Set<string>): string | undefined {
  const candidates = posix.extname(base).length > 0
    ? [base]
    : [`${base}.py`, posix.join(base, '__init__.py')]
  for (const candidate of candidates) {
    if (fileSet.has(candidate)) return candidate
  }
  for (const candidate of candidates) {
    const found = resolveSuffix(candidate, fileSet)
    if (found !== undefined) return found
  }
  return undefined
}

function resolveRustModule(moduleExpr: string, fileSet: Set<string>): string | undefined {
  let cleaned = moduleExpr.trim().replace(/^::/, '')
  cleaned = cleaned.replace(/^crate::/, '').replace(/^(?:self|super)::/, '')
  const base = cleaned.split('::').map(part => part.trim()).filter(part => part.length > 0).join('/')
  if (base.length === 0) return undefined
  const candidates = [`${base}.rs`, `${base}/mod.rs`]
  for (const candidate of candidates) {
    if (fileSet.has(candidate)) return candidate
  }
  for (const candidate of candidates) {
    const found = resolveSuffix(candidate, fileSet)
    if (found !== undefined) return found
  }
  return undefined
}

function resolveGoPackage(specifier: string, fileSet: Set<string>): string | undefined {
  const pkg = specifier.split('/').filter(part => part.length > 0).pop()
  if (pkg === undefined) return undefined
  for (const file of [...fileSet].sort(compareText)) {
    const dir = posix.dirname(file)
    if (dir === pkg || dir.split('/').pop() === pkg) return file
  }
  return undefined
}

function resolveSuffix(specifier: string, fileSet: Set<string>): string | undefined {
  const normalized = specifier.replace(/\\/g, '/').replace(/^\.?\//, '')
  if (normalized.length === 0) return undefined
  if (fileSet.has(normalized)) return normalized
  for (const file of fileSet) {
    if (file.endsWith(`/${normalized}`)) return file
  }
  return undefined
}

function pageRank(nodes: string[], adjacency: Map<string, Set<string>>): Map<string, number> {
  const scores = new Map<string, number>()
  const total = nodes.length
  if (total === 0) return scores

  const indexByNode = new Map<string, number>()
  for (let index = 0; index < total; index++) indexByNode.set(nodes[index], index)

  const targets: number[][] = new Array(total)
  const outDegree = new Uint32Array(total)
  for (let index = 0; index < total; index++) {
    const edges = adjacency.get(nodes[index])
    if (edges === undefined || edges.size === 0) {
      targets[index] = []
      continue
    }
    const list: number[] = []
    for (const target of edges) {
      const targetIndex = indexByNode.get(target)
      if (targetIndex !== undefined) list.push(targetIndex)
    }
    targets[index] = list
    outDegree[index] = list.length
  }

  let rank = new Float64Array(total)
  let next = new Float64Array(total)
  rank.fill(1 / total)
  for (let iteration = 0; iteration < PAGE_RANK_ITERATIONS; iteration++) {
    let dangling = 0
    for (let index = 0; index < total; index++) {
      if (outDegree[index] === 0) dangling += rank[index]
    }
    const base = (1 - DAMPING) / total + (DAMPING * dangling) / total
    next.fill(base)
    for (let index = 0; index < total; index++) {
      const degree = outDegree[index]
      if (degree === 0) continue
      const share = (DAMPING * rank[index]) / degree
      for (const target of targets[index]) next[target] += share
    }
    const swap = rank
    rank = next
    next = swap
  }
  for (let index = 0; index < total; index++) scores.set(nodes[index], rank[index])
  return scores
}

function symbolSummary(
  symbol: IndexedSymbol,
  maxScore: number,
): { name: string; kind: string; file: string; line: number; score: number } {
  return {
    name: symbol.name,
    kind: symbol.kind,
    file: symbol.file,
    line: symbol.line,
    score: maxScore > 0 ? round(symbol.score / maxScore) : 0,
  }
}

function queryMatchScore(name: string, lowerQuery: string, tokens: string[]): number {
  const lowerName = name.toLowerCase()
  let score = 0
  if (lowerName === lowerQuery) score += 3
  else if (lowerName.includes(lowerQuery)) score += 2

  let matched = 0
  for (const token of tokens) {
    if (token.length >= 2 && lowerName.includes(token)) matched++
  }
  if (tokens.length > 0) {
    if (matched === 0) return score
    score += matched / tokens.length
  }
  return score
}

function nameMatchScore(name: string, query: string, lowerQuery: string): number {
  if (name === query) return 1
  const lowerName = name.toLowerCase()
  if (lowerName === lowerQuery) return 0.95
  if (name.startsWith(query)) return 0.8
  if (lowerName.startsWith(lowerQuery)) return 0.78
  if (name.includes(query)) return 0.6
  if (lowerName.includes(lowerQuery)) return 0.58
  return 0
}

function compareByCentrality(left: IndexedSymbol, right: IndexedSymbol): number {
  return right.score - left.score
    || compareText(left.name, right.name)
    || compareText(left.file, right.file)
    || left.line - right.line
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function clampInt(value: unknown, min: number, max: number): number {
  const number = typeof value === 'number' ? Math.floor(value) : Number.NaN
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : min
}
