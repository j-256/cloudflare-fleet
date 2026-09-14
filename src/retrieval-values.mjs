import { stableString } from "./normalize.mjs"
import { RETRIEVAL_LIMIT } from "./retrieval-schemas.mjs"

const encoder = new TextEncoder()
export const COMPLETE_READ = Object.freeze({ complete: true, failureCount: 0, failures: [], truncated: false })
export const jsonBytes = (value) => encoder.encode(JSON.stringify(value)).byteLength
export async function retrievalDigest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(stableString(value)))
  return `sha256:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}
export async function boundedValue(value) {
  const normalized = value ?? null
  const serialized = JSON.stringify(normalized)
  const bytes = encoder.encode(serialized).byteLength
  const truncated = bytes > RETRIEVAL_LIMIT.VALUE_BYTES
  const keys = normalized && typeof normalized === "object" ? Object.keys(normalized) : []
  return {
    value: truncated ? null : normalized, truncated, bytes, digest: await retrievalDigest(normalized),
    preview: truncated ? serialized.slice(0, RETRIEVAL_LIMIT.PREVIEW_CHARACTERS) : null,
    childCount: keys.length, childKeys: truncated ? keys.filter((key) => key.length <= 256).slice(0, RETRIEVAL_LIMIT.MAX) : [],
  }
}
export function valueAtPath(value, path) {
  let selected = value
  for (const key of path) {
    if (!selected || typeof selected !== "object" || !Object.hasOwn(selected, key)) throw new TypeError(`Record has no value at path ${JSON.stringify(path)}`)
    selected = selected[key]
  }
  return selected
}
export async function cursorOffset(accountId, kind, query, revision) {
  const { cursor, ...filters } = query
  const fingerprint = await retrievalDigest({ accountId, kind, filters })
  if (!cursor) return { offset: 0, fingerprint }
  let parsed
  try { parsed = JSON.parse(atob(cursor)) } catch { throw new TypeError("Invalid retrieval cursor; restart without cursor") }
  if (!parsed || parsed.version !== 1 || parsed.fingerprint !== fingerprint || parsed.revision !== revision || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) {
    throw new TypeError("Retrieval cursor no longer matches this account, query, or revision; restart without cursor")
  }
  return { offset: parsed.offset, fingerprint }
}
export async function retrievalPage({ accountId, kind, query, revision, items, total = items.length, offset: suppliedOffset }) {
  const { offset, fingerprint } = await cursorOffset(accountId, kind, query, revision)
  if (suppliedOffset !== undefined && suppliedOffset !== offset) throw new Error("Retrieval storage offset does not match the cursor")
  const remaining = suppliedOffset === undefined ? items.slice(offset) : items
  const selected = []
  let bytes = 2
  for (const item of remaining.slice(0, query.limit)) {
    const size = jsonBytes(item) + (selected.length > 0 ? 1 : 0)
    if (bytes + size > RETRIEVAL_LIMIT.PAGE_BYTES) break
    selected.push(item)
    bytes += size
  }
  if (remaining.length > 0 && selected.length === 0) throw new Error("Retrieval item exceeds the page budget; use the summary view or a targeted detail read")
  const nextOffset = offset + selected.length
  return {
    items: selected, total, returned: selected.length, limit: query.limit,
    nextCursor: nextOffset < total ? btoa(JSON.stringify({ version: 1, fingerprint, revision, offset: nextOffset })) : null,
    pageLimited: nextOffset < total,
    valueTruncated: selected.some((item) => containsTruncation(item)),
  }
}
function containsTruncation(value) {
  if (!value || typeof value !== "object") return false
  if (value.truncated === true || value.targetsTruncated === true || value.summaryTruncated === true) return true
  return Object.values(value).some(containsTruncation)
}
export const compareIds = (left, right) => left < right ? -1 : left > right ? 1 : 0
export const matchesSearch = (search, ...values) => !search || values.some((value) => String(value ?? "").toLowerCase().includes(search.toLowerCase()))
