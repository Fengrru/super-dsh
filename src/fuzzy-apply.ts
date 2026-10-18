/**
 * Safety wrapper around the vendored fuzzy matcher.
 *
 * A tolerant match is only usable if it covers the same *semantics* as the
 * remembered `old_string`. The upstream matcher can return a region that starts
 * or ends a few characters off, which would silently corrupt surrounding code.
 * Before applying anything we therefore:
 *
 * 1. expand whitespace-only mismatches to whole indentation/trailing runs,
 * 2. require the matched region to start and end on the same tokens,
 * 3. require token-multiset similarity >= 0.98 (>= 0.90 for the typo strategy),
 * 4. keep the matched region at least half the line count of the request,
 * 5. require the matched bytes to be unique in the file.
 *
 * Failing any guard refuses the edit. A refusal is recoverable; a wrong edit is not.
 */

import { fuzzyFindAndReplace } from './vendor/fuzzy-patch.ts'

export interface FuzzyApplyResult {
  ok: boolean
  content: string
  strategy: string
  matchedText?: string
  matchedIndex?: number
  matchedLength?: number
  reason?: string
}

export function fuzzyApply(content: string, oldString: string, newString: string): FuzzyApplyResult {
  if (oldString.length === 0) return refuse(content, 'old_string is empty')
  if (oldString === newString) return refuse(content, 'old_string and new_string are identical')
  // The Levenshtein fallback is O(n·m); refuse inputs where it could block a turn.
  if (oldString.length > 16_000 || content.length > 1_000_000) {
    return refuse(content, 'file or old_string too large for a safe fuzzy edit; re-read and use an exact edit')
  }

  const first = content.indexOf(oldString)
  if (first !== -1) {
    if (content.indexOf(oldString, first + oldString.length) !== -1) {
      return refuse(content, 'old_string matches more than one region')
    }
    return {
      ok: true,
      content: splice(content, first, oldString.length, newString),
      strategy: 'literal',
      matchedText: oldString,
      matchedIndex: first,
      matchedLength: oldString.length,
    }
  }

  const fuzzy = fuzzyFindAndReplace(content, oldString, newString, false)
  if (fuzzy.matchCount === 0
    || fuzzy.matchedText === undefined
    || fuzzy.matchedIndex === undefined
    || fuzzy.matchedLength === undefined) {
    return refuse(content, fuzzy.error ?? 'no fuzzy match')
  }

  let start = expandStart(content, fuzzy.matchedIndex)
  let end = expandEnd(content, fuzzy.matchedIndex + fuzzy.matchedLength)

  // Reconcile the region to the request's first and last non-whitespace runs.
  // Matchers commonly overreach by a closing brace or swallow a line's
  // indentation; both are safe to trim when the overreach is punctuation or
  // whitespace only.
  const trimmedOld = oldString.trim()
  const firstAnchor = trimmedOld.match(/\S+/)?.[0]
  const lastAnchor = trimmedOld.match(/\S+$/)?.[0]
  if (firstAnchor === undefined || lastAnchor === undefined) {
    return refuse(content, 'old_string has no usable anchors')
  }
  {
    const matched = content.slice(start, end)
    const firstAt = matched.indexOf(firstAnchor)
    if (firstAt === -1) {
      return refuse(content, 'fuzzy region does not contain the requested start')
    }
    start += firstAt
    const afterStart = content.slice(start, end)
    const lastAt = afterStart.lastIndexOf(lastAnchor)
    if (lastAt === -1) {
      return refuse(content, 'fuzzy region does not contain the requested end')
    }
    end = start + lastAt + lastAnchor.length
  }

  // A matcher may swallow the newline (and the next line's indentation) after
  // the requested block. Never let a fuzzy region gain line breaks the caller
  // did not ask for.
  if (!oldString.endsWith('\n')) {
    const tail = content.slice(start, end).match(/(?:\r?\n[ \t]*)+$/)
    if (tail !== null) end -= tail[0].length
  }
  if (!oldString.startsWith('\n')) {
    const head = content.slice(start, end).match(/^(?:[ \t]*\r?\n)+/)
    if (head !== null) start += head[0].length
  }
  start = expandStart(content, start)
  end = expandEnd(content, end)
  const matchedText = content.slice(start, end)
  if (matchedText.length === 0) return refuse(content, 'empty fuzzy region')

  if (countOccurrences(content, matchedText) !== 1) {
    return refuse(content, 'fuzzy region is not unique')
  }

  const oldStartChar = firstNonSpace(oldString)
  const oldEndChar = lastNonSpace(oldString)
  const matchedStartChar = firstNonSpace(matchedText)
  const matchedEndChar = lastNonSpace(matchedText)
  if (oldStartChar !== matchedStartChar || oldEndChar !== matchedEndChar) {
    return refuse(content, 'fuzzy region edges differ from the requested block')
  }

  const oldTokens = guardTokens(oldString)
  const matchedTokens = guardTokens(matchedText)
  if (oldTokens.length === 0 || matchedTokens.length === 0) {
    return refuse(content, 'fuzzy region has no identifier content')
  }
  if (oldTokens[0] !== matchedTokens[0] || oldTokens[oldTokens.length - 1] !== matchedTokens[matchedTokens.length - 1]) {
    return refuse(content, 'fuzzy region boundaries do not match the requested block')
  }

  const similarity = dice(oldTokens, matchedTokens)
  const threshold = fuzzy.strategy === 'levenshtein_fuzzy' ? 0.9 : 0.98
  if (similarity < threshold) {
    return refuse(content, `fuzzy region token similarity ${similarity.toFixed(3)} < ${threshold}`)
  }

  const oldLines = oldString.split('\n').filter(line => line.trim().length > 0).length
  const matchedLines = matchedText.split('\n').filter(line => line.trim().length > 0).length
  if (oldLines >= 3 && matchedLines < Math.ceil(oldLines * 0.5)) {
    return refuse(content, `fuzzy region covers ${matchedLines}/${oldLines} non-empty lines`)
  }

  return {
    ok: true,
    content: splice(content, start, end - start, newString),
    strategy: fuzzy.strategy,
    matchedText,
    matchedIndex: start,
    matchedLength: end - start,
  }
}

function refuse(content: string, reason: string): FuzzyApplyResult {
  return { ok: false, content, strategy: 'refused', reason }
}

function splice(content: string, start: number, length: number, replacement: string): string {
  return content.slice(0, start) + replacement + content.slice(start + length)
}

/** Include the indentation run immediately before a mid-line match. */
function expandStart(content: string, index: number): number {
  let start = index
  while (start > 0 && (content[start - 1] === ' ' || content[start - 1] === '\t')) start--
  return start
}

/** Include trailing spaces/tabs, but never a newline. */
function expandEnd(content: string, index: number): number {
  let end = index
  while (end < content.length && (content[end] === ' ' || content[end] === '\t')) end++
  return end
}

function guardTokens(text: string): string[] {
  return text.match(/[\p{L}\p{N}_]+/gu) ?? []
}

function firstNonSpace(text: string): string | undefined {
  const match = text.match(/\S/)
  return match?.[0]
}

function lastNonSpace(text: string): string | undefined {
  const match = text.match(/\S(?=\s*$)/)
  return match?.[0]
}

function dice(left: string[], right: string[]): number {
  if (left.length + right.length === 0) return 1
  const counts = new Map<string, number>()
  for (const token of left) counts.set(token, (counts.get(token) ?? 0) + 1)
  let overlap = 0
  for (const token of right) {
    const count = counts.get(token) ?? 0
    if (count > 0) {
      overlap++
      counts.set(token, count - 1)
    }
  }
  return (2 * overlap) / (left.length + right.length)
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = 0
  while (true) {
    const found = haystack.indexOf(needle, index)
    if (found === -1) return count
    count++
    index = found + needle.length
    if (count > 10_000) return count
  }
}
