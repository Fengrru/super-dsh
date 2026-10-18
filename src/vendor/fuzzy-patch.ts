/**
 * FuzzyPatch — Multi-strategy fuzzy matching engine for AI agent file patching.
 *
 * When an AI agent patches a file, the file content may have already been
 * modified by another patch, user edit, or reformatting. Exact string matching
 * fails in these cases. This module provides 8 progressively-degraded matching
 * strategies to find and replace content reliably.
 *
 * ## Quick Start
 * ```ts
 * import { fuzzyFindAndReplace, canPatch } from "@fengrru/fuzzy-patch"
 *
 * const result = fuzzyFindAndReplace(fileContent, oldText, newText)
 * console.log(result.strategy) // "exact" | "whitespace_normalized" | ...
 * console.log(result.matchCount) // number of replacements
 * ```
 *
 * Strategies (in order):
 * 1. exact — direct string match
 * 2. whitespace_normalized — collapse whitespace, anchors via head-tail
 * 3. indentation_normalized — strip leading whitespace per line
 * 4. line_ending_normalized — normalize \\r\\n → \\n, map back
 * 5. token_match — tokenize and match subsequence
 * 6. head_tail_anchor — match first/last N chars, verify middle via Levenshtein
 * 7. context_anchor — match first/last lines
 * 8. levenshtein_fuzzy — sliding window Levenshtein (30% threshold, 20% variation)
 */

// ── Strategy Result ─────────────────────────────────────────────────────────

export interface PatchResult {
  /** The patched content (same as input if no match found) */
  newContent: string
  /** Number of successful matches/replacements made */
  matchCount: number
  /** Name of the strategy that succeeded */
  strategy: string
  /** Exact substring in the original content that the strategy matched (single replacement only) */
  matchedText?: string
  /** Index of the matched region in the original content (single replacement only) */
  matchedIndex?: number
  /** Length of the matched region in the original content (single replacement only) */
  matchedLength?: number
  /** Error message if all strategies failed */
  error?: string
}

// ── Internal match result ───────────────────────────────────────────────────

interface MatchResult {
  index: number
  length: number
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Simple Levenshtein distance with single-row optimization (O(n) space) */
function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m

  let prev = new Array<number>(n + 1)
  let curr = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j

  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      )
    }
    const tmp = prev
    prev = curr
    curr = tmp
  }
  return prev[n]
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[\s,;:.\-()[\]{}"'`~?!@#$%^&*+=/\\<>|]+/)
    .filter((t) => t.length > 0)
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

/**
 * Value-bearing tokens: numeric and quoted string literals.
 *
 * Whitespace inside a token is normalized so that a multi-line template
 * literal matches its whitespace-collapsed form.
 */
function valueTokens(s: string): string[] {
  const out: string[] = []
  const re = /0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?|"[^"\n]*"|'[^'\n]*'|`[^`]*`/g
  for (const m of s.matchAll(re)) out.push(normalizeWhitespace(m[0]))
  return out.sort()
}

/**
 * Fuzzy matching tolerates formatting drift (spacing, indentation, line
 * endings) but never value drift. A candidate match is rejected when it would
 * substitute a different numeric or string literal than the one searched for — 
 * e.g. rewriting `port: 9999` when asked to patch `port: 3000`.
 *
 * Without this guard a strategy degenerates into "edit something that looks
 * roughly similar", which silently corrupts the wrong line and is far harder to
 * recover from than a failed patch.
 */
function preservesValueTokens(region: string, oldStr: string): boolean {
  const regionTokens = valueTokens(region)
  const oldTokens = valueTokens(oldStr)
  if (regionTokens.length !== oldTokens.length) return false
  for (let i = 0; i < regionTokens.length; i++) {
    if (regionTokens[i] !== oldTokens[i]) return false
  }
  return true
}

/** Wrap a strategy so results that would change a value literal are refused. */
function guarded(fn: (content: string, oldStr: string) => MatchResult | null) {
  return (content: string, oldStr: string): MatchResult | null => {
    const match = fn(content, oldStr)
    if (match === null) return null
    if (match.index < 0 || match.length <= 0) return null
    const region = content.slice(match.index, match.index + match.length)
    return preservesValueTokens(region, oldStr) ? match : null
  }
}

/** Build regex that matches a string tolerating whitespace differences */
function buildTolerantRegex(s: string): RegExp {
  let pattern = ""
  for (const ch of s) {
    if (/[.*+?^${}()|[\]\\]/.test(ch)) {
      pattern += `\\${ch}`
    } else if (ch === " ") {
      pattern += "\\s+"
    } else {
      pattern += ch
    }
  }
  return new RegExp(pattern, "g")
}

function findInOriginalViaAnchors(content: string, normMatch: string): MatchResult | null {
  const trimmed = normMatch.trim()
  const headLen = Math.min(20, trimmed.length)
  const tailLen = Math.min(20, trimmed.length)
  const head = trimmed.slice(0, headLen)
  const tail = trimmed.slice(-tailLen)

  if (head.length < 3) return null

  const headRegex = buildTolerantRegex(head)
  const match = headRegex.exec(content)
  if (!match) return null

  const startIdx = match.index
  const expectedEnd = startIdx + Math.round(normMatch.length * 1.3)
  const tailRegex = buildTolerantRegex(tail)

  let tailMatch: RegExpExecArray | null = null
  let bestTailIdx = -1
  let searchIdx = Math.min(expectedEnd, content.length - tail.length * 2)

  while (searchIdx < content.length && bestTailIdx < 0) {
    tailRegex.lastIndex = searchIdx
    const m = tailRegex.exec(content)
    if (m) {
      tailMatch = m
      bestTailIdx = m.index
    }
    searchIdx++
  }

  if (!tailMatch) {
    const approxLen = Math.min(normMatch.length + 10, content.length - startIdx)
    return { index: startIdx, length: approxLen }
  }

  const endIdx = tailMatch.index + tailMatch[0].length
  return { index: startIdx, length: endIdx - startIdx }
}

// ── 8 Strategies ────────────────────────────────────────────────────────────

function strategyExact(content: string, oldStr: string): MatchResult | null {
  const idx = content.indexOf(oldStr)
  return idx === -1 ? null : { index: idx, length: oldStr.length }
}

function strategyWhitespaceNorm(content: string, oldStr: string): MatchResult | null {
  const normContent = normalizeWhitespace(content)
  const normOld = normalizeWhitespace(oldStr)
  if (normOld.length === 0) return null
  const normIdx = normContent.indexOf(normOld)
  if (normIdx === -1) return null
  const normMatch = normContent.slice(normIdx, normIdx + normOld.length)
  return findInOriginalViaAnchors(content, normMatch)
}

function strategyIndentNorm(content: string, oldStr: string): MatchResult | null {
  const contentLines = content.split("\n")
  const oldLines = oldStr.split("\n")
  if (oldLines.length === 0 || contentLines.length === 0) return null

  const firstOldLine = oldLines[0]!.trimStart()

  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    const startLine = contentLines[i]!.trimStart()
    if (startLine !== firstOldLine) continue

    let allMatch = true
    for (let j = 1; j < oldLines.length; j++) {
      if (contentLines[i + j]!.trimStart() !== oldLines[j]!.trimStart()) {
        allMatch = false
        break
      }
    }
    if (!allMatch) continue

    const startIdx = contentLines.slice(0, i).reduce((acc, l) => acc + l.length + 1, 0)
    const firstLine = contentLines[i]!
    const leadingWs = firstLine.length - firstLine.trimStart().length
    const adjustedStart = startIdx + leadingWs
    const endIdx = contentLines.slice(0, i + oldLines.length).reduce((acc, l) => acc + l.length + 1, 0) - 1
    return { index: adjustedStart, length: endIdx - adjustedStart }
  }
  return null
}

function strategyLineEndingNorm(content: string, oldStr: string): MatchResult | null {
  const normContent = normalizeLineEndings(content)
  const normOld = normalizeLineEndings(oldStr)
  const normIdx = normContent.indexOf(normOld)
  if (normIdx === -1) return null

  let origPos = 0
  let normPos = 0
  while (normPos < normIdx && origPos < content.length) {
    if (content[origPos] === "\r" && origPos + 1 < content.length && content[origPos + 1] === "\n") {
      origPos += 2
    } else {
      origPos++
    }
    normPos++
  }

  let matchEnd = origPos
  normPos = 0
  while (normPos < normOld.length && matchEnd < content.length) {
    if (content[matchEnd] === "\r" && matchEnd + 1 < content.length && content[matchEnd + 1] === "\n") {
      matchEnd += 2
    } else {
      matchEnd++
    }
    normPos++
  }

  return { index: origPos, length: matchEnd - origPos }
}

function strategyHeadTailAnchor(content: string, oldStr: string): MatchResult | null {
  if (oldStr.length < 20) return null
  const headLen = Math.min(15, Math.floor(oldStr.length * 0.3))
  const tailLen = Math.min(15, Math.floor(oldStr.length * 0.3))
  const head = oldStr.slice(0, headLen)
  const tail = oldStr.slice(-tailLen)

  const candidates: number[] = []
  let headIdx = content.indexOf(head)
  while (headIdx !== -1) {
    candidates.push(headIdx)
    headIdx = content.indexOf(head, headIdx + 1)
  }

  for (const start of candidates) {
    const expectedTailPos = start + oldStr.length - tailLen
    const tailFound =
      expectedTailPos <= content.length && content.slice(expectedTailPos, expectedTailPos + tailLen) === tail
    if (!tailFound) continue
    const middle = content.slice(start + headLen, expectedTailPos)
    const oldMiddle = oldStr.slice(headLen, oldStr.length - tailLen)
    const maxEdit = Math.max(middle.length, oldMiddle.length) * 0.4
    if (levenshtein(middle, oldMiddle) > maxEdit) continue
    return { index: start, length: expectedTailPos + tailLen - start }
  }
  return null
}

function strategyContextAnchor(content: string, oldStr: string): MatchResult | null {
  const oldLines = oldStr.split("\n")
  if (oldLines.length < 3) return null

  const firstLine = oldLines[0]
  const lastLine = oldLines[oldLines.length - 1]
  const contentLines = content.split("\n")

  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() === firstLine.trim()) {
      const expectedLastIdx = i + oldLines.length - 1
      if (expectedLastIdx < contentLines.length) {
        if (contentLines[expectedLastIdx].trim() === lastLine.trim()) {
          const startIdx = contentLines.slice(0, i).reduce((acc, l) => acc + l.length + 1, 0)
          const endIdx = contentLines.slice(0, expectedLastIdx + 1).reduce((acc, l) => acc + l.length + 1, 0) - 1
          return { index: startIdx, length: endIdx - startIdx }
        }
      }
    }
  }
  return null
}

function strategyTokenMatch(content: string, oldStr: string): MatchResult | null {
  const oldTokens = tokenize(oldStr)
  if (oldTokens.length < 3) return null

  const tokenRegex = /[\w]+/g
  const tokenPositions: Array<{ token: string; start: number; end: number }> = []
  for (const m of content.matchAll(tokenRegex)) {
    tokenPositions.push({ token: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length })
  }

  for (let i = 0; i <= tokenPositions.length - oldTokens.length; i++) {
    let allMatch = true
    for (let j = 0; j < oldTokens.length; j++) {
      if (tokenPositions[i + j]!.token !== oldTokens[j]!.toLowerCase()) {
        allMatch = false
        break
      }
    }
    if (allMatch) {
      const startIdx = tokenPositions[i]!.start
      const endTokIdx = tokenPositions[i + oldTokens.length - 1]!.end
      let endIdx = endTokIdx
      while (endIdx < content.length && !/[\w]/.test(content[endIdx])) {
        if (content[endIdx] === "\n" || content[endIdx] === "\r") break
        endIdx++
      }
      return { index: startIdx, length: endIdx - startIdx }
    }
  }
  return null
}

function strategyLevenshteinFuzzy(content: string, oldStr: string): MatchResult | null {
  if (oldStr.length < 10) return null

  // Relative edit budget only. An absolute floor of 5 edits (the previous
  // `Math.max(..., 5)`) let a 10-character search rewrite a line differing in
  // 40% of its characters, which is why `port: 9999` satisfied a search for
  // `port: 3000`.
  const threshold = Math.max(Math.floor(oldStr.length * 0.2), 2)

  const windowSize = oldStr.length
  const variation = Math.floor(oldStr.length * 0.2)
  const step = Math.max(1, Math.floor(oldStr.length / 10))

  let bestMatch: { index: number; length: number; distance: number } | null = null

  for (let i = 0; i <= content.length - windowSize + variation; i += step) {
    for (let ws = windowSize - variation; ws <= windowSize + variation; ws++) {
      if (i + ws > content.length) continue
      const candidate = content.slice(i, i + ws)
      const dist = levenshtein(candidate, oldStr)
      if (dist <= threshold) {
        if (!bestMatch || dist < bestMatch.distance) {
          // The winning window width must be reported. Returning
          // `oldStr.length` splices residue into the file whenever the best
          // window is wider or narrower than the search string.
          bestMatch = { index: i, length: ws, distance: dist }
        }
      }
    }
  }

  return bestMatch ? { index: bestMatch.index, length: bestMatch.length } : null
}

// ── Main API ────────────────────────────────────────────────────────────────

// Every strategy is guarded: a match is only reported when it preserves the
// numeric and string literals of the search text. `canPatch` and
// `availableStrategies` therefore agree with what `fuzzyFindAndReplace` will
// actually do instead of reporting a patch that the guard would refuse.
const ALL_STRATEGIES: Array<{ name: string; fn: (c: string, o: string) => MatchResult | null }> = [
  { name: "exact", fn: guarded(strategyExact) },
  { name: "whitespace_normalized", fn: guarded(strategyWhitespaceNorm) },
  { name: "indentation_normalized", fn: guarded(strategyIndentNorm) },
  { name: "line_ending_normalized", fn: guarded(strategyLineEndingNorm) },
  { name: "token_match", fn: guarded(strategyTokenMatch) },
  { name: "head_tail_anchor", fn: guarded(strategyHeadTailAnchor) },
  { name: "context_anchor", fn: guarded(strategyContextAnchor) },
  { name: "levenshtein_fuzzy", fn: guarded(strategyLevenshteinFuzzy) },
]

/**
 * Fuzzy find and replace — walks 8 strategies from exact match to token-level
 * matching. The first strategy that finds a match is used for replacement.
 *
 * @param content   The full file content string
 * @param oldString The text to find and replace
 * @param newString The replacement text
 * @param replaceAll Whether to replace all occurrences (default: false)
 * @returns PatchResult with new content, match count, and strategy used
 */
export function fuzzyFindAndReplace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): PatchResult {
  if (oldString === newString) {
    return { newContent: content, matchCount: 0, strategy: "identity", error: "old and new strings are identical" }
  }
  if (oldString.length === 0) {
    return { newContent: content, matchCount: 0, strategy: "empty_old", error: "old string is empty" }
  }

  for (const strategy of ALL_STRATEGIES) {
    const match = strategy.fn(content, oldString)
    if (match && match.index >= 0 && match.length > 0) {
      let result = content
      let matchCount = 0

      if (replaceAll) {
        let working = content
        let found = true
        let iteration = 0
        const MAX_ITERATIONS = 10000
        while (found && iteration < MAX_ITERATIONS) {
          const m = strategy.fn(working, oldString)
          if (!m || m.length === 0) {
            found = false
          } else {
            working = working.slice(0, m.index) + newString + working.slice(m.index + m.length)
            matchCount++
          }
          iteration++
        }
        result = working
      } else {
        result = content.slice(0, match.index) + newString + content.slice(match.index + match.length)
        matchCount = 1
      }

      return {
        newContent: result,
        matchCount,
        strategy: strategy.name,
        ...replaceAll ? {} : {
          matchedText: content.slice(match.index, match.index + match.length),
          matchedIndex: match.index,
          matchedLength: match.length,
        },
      }
    }
  }

  return {
    newContent: content,
    matchCount: 0,
    strategy: "none",
    error: `Could not find match for "${oldString.slice(0, 80)}${oldString.length > 80 ? "..." : ""}" with any strategy`,
  }
}

/**
 * Check if a patch would succeed without actually applying it.
 */
export function canPatch(content: string, oldString: string): boolean {
  for (const strategy of ALL_STRATEGIES) {
    if (strategy.fn(content, oldString) !== null) return true
  }
  return false
}

/**
 * List all strategies that would find a match (for diagnostics).
 */
export function availableStrategies(content: string, oldString: string): string[] {
  return ALL_STRATEGIES.filter((s) => s.fn(content, oldString) !== null).map((s) => s.name)
}
