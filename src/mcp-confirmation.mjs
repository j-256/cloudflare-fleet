import { stableString } from "./normalize.mjs"

export const CONFIRMATION_DECISION = Object.freeze({
  APPROVE: "approve",
  DECLINE: "decline",
})

const CONFIRMATION_LINE_WIDTH = 76
const CONFIRMATION_LINES_PER_FIELD = 10
const STRING_CHANGE_CONTEXT_LENGTH = 40
const STRING_CHANGE_INLINE_LENGTH = 120
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
    return [`+ ${entry.path}: ${jsonValue(entry.value)}`]
  }
  if (entry.kind === "remove") {
    return [`- ${entry.path}: ${jsonValue(entry.value)}`]
  }
  if (typeof entry.current === "string" && typeof entry.desired === "string") {
    return compactStringChange(entry.path, entry.current, entry.desired)
  }
  return [
    `${entry.path}: ${jsonValue(entry.current)} -> ${jsonValue(entry.desired)}`,
  ]
}

function wrapLine(line) {
  if (line.length <= CONFIRMATION_LINE_WIDTH) return [line]
  const indentation = line.match(/^\s*/u)?.[0] || ""
  const continuation = `${indentation}  `
  const lines = []
  let remaining = line
  while (remaining.length > CONFIRMATION_LINE_WIDTH) {
    let splitAt = remaining.lastIndexOf(" ", CONFIRMATION_LINE_WIDTH)
    if (splitAt <= continuation.length) splitAt = CONFIRMATION_LINE_WIDTH
    lines.push(remaining.slice(0, splitAt).trimEnd())
    remaining = `${continuation}${remaining.slice(splitAt).trimStart()}`
  }
  lines.push(remaining)
  return lines
}

function wrapLines(lines) {
  return lines.flatMap(wrapLine)
}

function snapshotLines(label, value) {
  if (!isObject(value) && !Array.isArray(value)) {
    return [`${label}: ${jsonValue(value)}`]
  }
  return [
    `${label}:`,
    ...valueEntries(value).map((entry) => (
      `  ${entry.path || "value"}: ${jsonValue(entry.value)}`
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
      `Zone: ${operation.zoneName} (${operation.zoneId})`,
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

function fieldPages(reviewItems) {
  return reviewItems.flatMap((item) => {
    const pageCount = Math.max(
      1,
      Math.ceil(item.lines.length / CONFIRMATION_LINES_PER_FIELD),
    )
    const linesPerPage = Math.ceil(item.lines.length / pageCount)
    return Array.from({ length: pageCount }, (_value, pageIndex) => ({
      description: item.lines
        .slice(
          pageIndex * linesPerPage,
          (pageIndex + 1) * linesPerPage,
        )
        .join("\n"),
      title: pageCount === 1
        ? item.title
        : `${item.title} (${pageIndex + 1}/${pageCount})`,
    }))
  })
}

function fieldSchema(field) {
  return {
    description: field.description,
    oneOf: [
      {
        const: CONFIRMATION_DECISION.DECLINE,
        title: "Do not apply",
      },
      {
        const: CONFIRMATION_DECISION.APPROVE,
        title: "Approve this change",
      },
    ],
    title: field.title,
    type: "string",
  }
}

export function buildConfirmationForm(options) {
  const fields = fieldPages(options.reviewItems)
  if (fields.length === 0) {
    throw new TypeError("A confirmation form requires at least one review item")
  }
  const keys = confirmationFieldKeys(fields.length)
  const properties = Object.fromEntries(fields.map((field, index) => [
    keys[index],
    fieldSchema(field),
  ]))
  return {
    fieldCount: fields.length,
    message: [
      options.heading,
      `Account: ${options.accountId}`,
      `Plan: ${options.planSet.digest}`,
      `Validated: ${options.planSet.validatedAt}`,
      ...options.summaryLines,
    ].join("\n"),
    requestedSchema: {
      properties,
      required: keys,
      type: "object",
    },
  }
}
