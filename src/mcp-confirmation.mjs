import { createHash } from "node:crypto"

import { stableString } from "./normalize.mjs"

export const CONFIRMATION_DECISION = Object.freeze({
  APPROVE: "approve",
  DECLINE: "decline",
  REVIEWED: "reviewed",
})
export const CONFIRMATION_APPROVAL_MODE = Object.freeze({
  BATCH: "batch",
  PER_ITEM: "per-item",
})

export const CONFIRMATION_LINE_WIDTH = 76
// Reference layout: 80 columns by 24 rows, reserving eight rows for
// selection, field navigation, validation and padding in the Codex TUI
// MCP does not report viewport size, so smaller windows may need resizing
export const CONFIRMATION_PROMPT_LINE_LIMIT = 16
const FIELD_HEADING_LINES = 2
const MAX_CONTINUATION_INDENT = 8
const NON_ASCII_CELL_BUDGET = 2
const STRING_CHANGE_CONTEXT_LENGTH = 40
const STRING_CHANGE_INLINE_LENGTH = 120
// A leaf value longer than this renders as a summary (length, digest, head)
// instead of its full text, so one large field such as a multi-KB rule
// expression cannot explode an operation across many approval pages; the
// plan digest still binds the exact bytes, and the per-value digest lets a
// reviewer cross-check a specific value against the plan output
const VALUE_SUMMARY_THRESHOLD = 120
const VALUE_SUMMARY_PREVIEW_LENGTH = 48
const VALUE_SUMMARY_DIGEST_LENGTH = 12
const HTTP_METHOD = Object.freeze({
  CREATE: "POST",
  DELETE: "DELETE",
  PATCH: "PATCH",
  REPLACE: "PUT",
})

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function jsonValue(value) {
  const serialized = JSON.stringify(value)
  return serialized === undefined ? String(value) : serialized
}

function summarizeValue(value) {
  const serialized = jsonValue(value)
  if (serialized.length <= VALUE_SUMMARY_THRESHOLD) return serialized
  const digest = createHash("sha256")
    .update(stableString(value))
    .digest("hex")
    .slice(0, VALUE_SUMMARY_DIGEST_LENGTH)
  if (typeof value === "string") {
    const head = value.slice(0, VALUE_SUMMARY_PREVIEW_LENGTH)
    return `<large string, ${value.length} chars, sha256:${digest}, head: ${jsonValue(head)}>`
  }
  return `<large value, ${serialized.length} chars, sha256:${digest}>`
}

function sharedObjectKeys(current, desired) {
  if (!isObject(current) || !isObject(desired)) return []
  return Object.keys(desired).filter((key) => Object.hasOwn(current, key))
}

function valueEntries(value, path = "", entries = []) {
  if (Array.isArray(value)) {
    if (value.length === 0) entries.push({ path, value })
    for (const [index, entry] of value.entries()) {
      valueEntries(entry, `${path}[${index}]`, entries)
    }
    return entries
  }
  if (isObject(value)) {
    const keys = Object.keys(value)
    if (keys.length === 0) entries.push({ path, value })
    for (const key of keys) {
      valueEntries(value[key], path ? `${path}.${key}` : key, entries)
    }
    return entries
  }
  entries.push({ path, value })
  return entries
}

function appendChangedValue(entries, kind, path, value) {
  for (const entry of valueEntries(value, path)) {
    entries.push({ kind, path: entry.path, value: entry.value })
  }
}

function changedValueEntries(current, desired, options, path = "", entries = []) {
  if (stableString(current) === stableString(desired)) return entries
  if (Array.isArray(current) && Array.isArray(desired)) {
    const length = Math.max(current.length, desired.length)
    for (let index = 0; index < length; index += 1) {
      const entryPath = `${path}[${index}]`
      if (index >= current.length) {
        appendChangedValue(entries, "add", entryPath, desired[index])
      } else if (index >= desired.length) {
        appendChangedValue(entries, "remove", entryPath, current[index])
      } else {
        changedValueEntries(
          current[index],
          desired[index],
          options,
          entryPath,
          entries,
        )
      }
    }
    return entries
  }
  if (isObject(current) && isObject(desired)) {
    const keys = options.partial
      ? Object.keys(desired)
      : [...new Set([...Object.keys(current), ...Object.keys(desired)])]
    for (const key of keys) {
      const entryPath = path ? `${path}.${key}` : key
      if (!Object.hasOwn(current, key)) {
        appendChangedValue(entries, "add", entryPath, desired[key])
      } else if (!Object.hasOwn(desired, key)) {
        appendChangedValue(entries, "remove", entryPath, current[key])
      } else {
        changedValueEntries(
          current[key],
          desired[key],
          options,
          entryPath,
          entries,
        )
      }
    }
    return entries
  }
  entries.push({
    current,
    desired,
    kind: "change",
    path: path || "value",
  })
  return entries
}

function commonPrefixLength(current, desired) {
  const length = Math.min(current.length, desired.length)
  let index = 0
  while (index < length && current[index] === desired[index]) index += 1
  return index
}

function commonSuffixLength(current, desired, prefixLength) {
  const available = Math.min(current.length, desired.length) - prefixLength
  let length = 0
  while (length < available
    && current[current.length - length - 1] === desired[desired.length - length - 1]) {
    length += 1
  }
  return length
}

function trailingStringContext(value) {
  let context = value.slice(-STRING_CHANGE_CONTEXT_LENGTH)
  if (value.length > context.length) {
    const boundary = context.indexOf(" ")
    if (boundary >= 0 && boundary < context.length - 1) {
      context = context.slice(boundary + 1)
    }
  }
  return context
}

function leadingStringContext(value) {
  let context = value.slice(0, STRING_CHANGE_CONTEXT_LENGTH)
  if (value.length > context.length) {
    const boundary = context.lastIndexOf(" ")
    if (boundary > 0) context = context.slice(0, boundary)
  }
  return context
}

function compactStringChange(path, current, desired) {
  if (Math.max(current.length, desired.length) <= STRING_CHANGE_INLINE_LENGTH) {
    return [`${path}: ${jsonValue(current)} -> ${jsonValue(desired)}`]
  }
  const prefixLength = commonPrefixLength(current, desired)
  const suffixLength = commonSuffixLength(current, desired, prefixLength)
  if (prefixLength === 0 && suffixLength === 0) {
    return [
      `${path}:`,
      `  From: ${jsonValue(current)}`,
      `  To: ${jsonValue(desired)}`,
    ]
  }
  const currentEnd = current.length - suffixLength
  const desiredEnd = desired.length - suffixLength
  const removed = current.slice(prefixLength, currentEnd)
  const inserted = desired.slice(prefixLength, desiredEnd)
  const lines = [`${path}:`]
  if (removed.length === 0) {
    lines.push(`  Insert: ${jsonValue(inserted)}`)
  } else if (inserted.length === 0) {
    lines.push(`  Remove: ${jsonValue(removed)}`)
  } else {
    lines.push(
      `  Replace: ${jsonValue(removed)}`,
      `  With: ${jsonValue(inserted)}`,
    )
  }
  if (prefixLength > 0) {
    const prefix = current.slice(0, prefixLength)
    const context = trailingStringContext(prefix)
    lines.push(
      `  After: ${jsonValue(context)}${prefix.length > context.length ? " (suffix)" : ""}`,
    )
  }
  if (suffixLength > 0) {
    const suffix = current.slice(current.length - suffixLength)
    const context = leadingStringContext(suffix)
    lines.push(
      `  Before: ${jsonValue(context)}${suffix.length > context.length ? " (prefix)" : ""}`,
    )
  }
  return lines
}

function formatChangeEntry(entry) {
  if (entry.kind === "add") {
    return [`+ ${entry.path}: ${summarizeValue(entry.value)}`]
  }
  if (entry.kind === "remove") {
    return [`- ${entry.path}: ${summarizeValue(entry.value)}`]
  }
  if (typeof entry.current === "string" && typeof entry.desired === "string") {
    return compactStringChange(entry.path, entry.current, entry.desired)
  }
  return [
    `${entry.path}: ${summarizeValue(entry.current)} -> ${summarizeValue(entry.desired)}`,
  ]
}

function lineBreakOffset(line) {
  let width = 0
  let offset = 0
  for (const point of line) {
    // Conservatively reserve two cells for non-ASCII terminal glyphs
    const cells = point.codePointAt(0) <= 0x7f ? 1 : NON_ASCII_CELL_BUDGET
    if (width + cells > CONFIRMATION_LINE_WIDTH) break
    width += cells
    offset += point.length
  }
  return offset
}

function wrapLine(line) {
  if (lineBreakOffset(line) === line.length) return [line]
  const indentation = (line.match(/^\s*/u)?.[0] || "")
    .slice(0, MAX_CONTINUATION_INDENT)
  const continuation = `${indentation}  `
  const lines = []
  let remaining = line
  while (lineBreakOffset(remaining) < remaining.length) {
    const boundary = lineBreakOffset(remaining)
    let splitAt = remaining.lastIndexOf(" ", boundary)
    if (splitAt <= continuation.length) splitAt = boundary
    lines.push(remaining.slice(0, splitAt).trimEnd())
    remaining = `${continuation}${remaining.slice(splitAt).trimStart()}`
  }
  lines.push(remaining)
  return lines
}

function wrapLines(lines) {
  return lines.flatMap((line) => String(line).split(/\r?\n/u)
    .flatMap((part) => wrapLine(part.replace(/[\u0000-\u001f\u007f-\u009f]/gu, (point) => (
      `\\u${point.codePointAt(0).toString(16).padStart(4, "0")}`
    )))))
}

function snapshotLines(label, value) {
  if (!isObject(value) && !Array.isArray(value)) {
    return [`${label}: ${summarizeValue(value)}`]
  }
  return [
    `${label}:`,
    ...valueEntries(value).map((entry) => (
      `  ${entry.path || "value"}: ${summarizeValue(entry.value)}`
    )),
  ]
}

function operationPath(operation) {
  const zonePrefix = `zones/${operation.zoneId}/`
  return operation.path.startsWith(zonePrefix)
    ? operation.path.slice(zonePrefix.length)
    : operation.path
}

function operationApiLines(operation) {
  const segments = operationPath(operation).split("/")
  const groups = []
  for (let index = 0; index < segments.length; index += 2) {
    groups.push(segments.slice(index, index + 2).join("/"))
  }
  const lines = []
  let line = `API: ${operation.method}`
  for (const [index, group] of groups.entries()) {
    const separator = index === 0 ? " " : "/"
    const addition = `${separator}${group}`
    if (line.length + addition.length <= CONFIRMATION_LINE_WIDTH) {
      line += addition
    } else {
      lines.push(line)
      line = `  ${addition.trimStart()}`
    }
  }
  lines.push(line)
  return lines
}

function comparableOperationValues(operation) {
  const current = operation.currentValue
  const desired = operation.body
  if (!isObject(current) && isObject(desired)
    && Object.keys(desired).length === 1
    && Object.hasOwn(desired, "value")) {
    return { context: null, current: { value: current }, desired }
  }
  if (sharedObjectKeys(current, desired).length > 0) {
    return { context: null, current, desired }
  }
  if (isObject(current?.rule)
    && sharedObjectKeys(current.rule, desired).length > 0) {
    const { rule, ...context } = current
    return { context, current: rule, desired }
  }
  return null
}

function operationValueLines(operation) {
  const hasBody = Object.hasOwn(operation, "body")
  const hasCurrent = Object.hasOwn(operation, "currentValue")
  if (operation.method === HTTP_METHOD.DELETE && hasCurrent) {
    return snapshotLines("Delete", operation.currentValue)
  }
  if (operation.method === HTTP_METHOD.CREATE) {
    return [
      ...(hasCurrent ? snapshotLines("Context", operation.currentValue) : []),
      ...(hasBody ? snapshotLines("Create", operation.body) : []),
    ]
  }
  if (hasBody && hasCurrent) {
    const comparison = comparableOperationValues(operation)
    if (comparison) {
      const entries = changedValueEntries(
        comparison.current,
        comparison.desired,
        { partial: operation.method === HTTP_METHOD.PATCH },
      )
      if (entries.length > 0) {
        return [
          ...(comparison.context
            ? snapshotLines("Context", comparison.context)
            : []),
          "Changes:",
          ...entries.flatMap(formatChangeEntry).map((line) => `  ${line}`),
        ]
      }
    }
    return [
      ...snapshotLines("Current", operation.currentValue),
      ...snapshotLines(
        operation.method === HTTP_METHOD.REPLACE ? "Replace with" : "Request",
        operation.body,
      ),
    ]
  }
  if (hasBody) {
    const label = operation.method === HTTP_METHOD.REPLACE
      ? "Replace with"
      : "Request"
    return snapshotLines(label, operation.body)
  }
  if (hasCurrent) return snapshotLines("Current", operation.currentValue)
  return []
}

export function operationReviewItems(operations) {
  return operations.map((operation, index) => ({
    lines: wrapLines([
      operation.worker ? `Worker: ${operation.worker} (account ${operation.accountId})` : `Zone: ${operation.zoneName} (${operation.zoneId})`,
      ...operationApiLines(operation),
      ...operationValueLines(operation),
    ]),
    title: `${index + 1}. ${operation.label}`,
  }))
}

export function intentReviewItems(plan) {
  const lines = [
    "Cloudflare API writes: none",
    `Expected revision: ${plan.planSet.request.expectedRevision || "empty"}`,
  ]
  for (const [collection, difference] of Object.entries(plan.diff)) {
    for (const [kind, identifiers] of Object.entries(difference)) {
      if (identifiers.length > 0) {
        lines.push(`${collection} ${kind}: ${identifiers.join(", ")}`)
      }
    }
  }
  return [{
    lines: wrapLines(lines),
    title: "Persist fleet intent",
  }]
}

export function confirmationFieldKeys(count) {
  const width = String(count).length
  return Array.from({ length: count }, (_value, index) => (
    `review_${String(index + 1).padStart(width, "0")}`
  ))
}

function fieldPages(reviewItems, linesPerPage, batchApproval) {
  const pages = []
  for (const [index, item] of reviewItems.entries()) {
    const titleLines = wrapLines([item.title])
    const bodyLines = wrapLines(item.lines)
    if (!batchApproval && titleLines.length === 1 && bodyLines.length <= linesPerPage) {
      pages.push({
        firstItem: index + 1,
        lastItem: index + 1,
        lines: bodyLines,
        title: titleLines[0],
      })
      continue
    }
    const lines = [...titleLines, ...bodyLines]
    const previous = pages.at(-1)
    if (batchApproval && previous
      && previous.lines.length + lines.length <= linesPerPage) {
      previous.lines.push(...lines)
      previous.lastItem = index + 1
      continue
    }
    for (let offset = 0; offset < lines.length; offset += linesPerPage) {
      pages.push({
        firstItem: index + 1,
        lastItem: index + 1,
        lines: lines.slice(offset, offset + linesPerPage),
      })
    }
  }
  return pages.map((page, index) => ({
    description: page.lines.join("\n"),
    title: page.title || `Review ${index + 1}/${pages.length}: ${page.firstItem === page.lastItem
      ? `item ${page.firstItem}`
      : `items ${page.firstItem}-${page.lastItem}`}`,
  }))
}

function fieldSchema(field, approveTitle, decision = CONFIRMATION_DECISION.APPROVE) {
  return {
    description: field.description,
    oneOf: [
      {
        const: CONFIRMATION_DECISION.DECLINE,
        title: "Do not apply",
      },
      {
        const: decision,
        title: approveTitle,
      },
    ],
    title: field.title,
    type: "string",
  }
}

export function buildConfirmationForm(options) {
  const batchApproval = options.approvalMode
    === CONFIRMATION_APPROVAL_MODE.BATCH
  if (options.reviewItems.length === 0) {
    throw new TypeError("A confirmation form requires at least one review item")
  }
  const planLines = wrapLines([
    `Plan ${options.planSet.digest}`,
    `Validated: ${options.planSet.validatedAt}`,
    ...options.summaryLines,
  ])
  const messageLines = wrapLines([
    options.heading,
    `Account: ${options.accountId}`,
    ...(batchApproval ? [] : planLines),
  ])
  const linesPerPage = CONFIRMATION_PROMPT_LINE_LIMIT
    - messageLines.length - FIELD_HEADING_LINES
  if (linesPerPage < 1) {
    throw new RangeError("Confirmation heading exceeds the review budget; use the CLI or dashboard to review the complete plan")
  }
  const fields = fieldPages(options.reviewItems, linesPerPage, batchApproval)
  if (batchApproval) {
    const count = options.reviewItems.length
    const description = wrapLines([
      `Apply all ${count} reviewed operation${count === 1 ? "" : "s"} as one batch.`,
      "Every review page must be marked reviewed.",
      ...planLines,
    ])
    if (description.length > linesPerPage) {
      throw new RangeError("Batch confirmation summary exceeds the review budget; use the CLI or dashboard to review the complete plan")
    }
    fields.push({
      description: description.join("\n"),
      title: "Final batch decision",
    })
  }
  const keys = confirmationFieldKeys(fields.length)
  const properties = Object.fromEntries(fields.map((field, index) => [
    keys[index],
    fieldSchema(
      field,
      batchApproval
        ? index === fields.length - 1 ? "Approve entire batch" : "Reviewed / Continue"
        : "Approve this change",
      batchApproval && index < fields.length - 1
        ? CONFIRMATION_DECISION.REVIEWED
        : CONFIRMATION_DECISION.APPROVE,
    ),
  ]))
  return {
    fieldCount: fields.length,
    message: messageLines.join("\n"),
    requestedSchema: {
      properties,
      required: keys,
      type: "object",
    },
  }
}
