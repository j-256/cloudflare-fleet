export function recordIntentUndo(
  stack,
  previousDocument,
  savedDocument,
  description,
) {
  return [
    ...stack,
    {
      afterRevision: savedDocument.revision,
      before: structuredClone(previousDocument),
      description: String(description || "Fleet intent change"),
    },
  ]
}

export function currentIntentUndo(stack, currentDocument) {
  const entry = stack.at(-1) || null
  return entry?.afterRevision === currentDocument.revision ? entry : null
}

export function prepareIntentUndoDocument(entry, currentDocument) {
  if (!entry || entry.afterRevision !== currentDocument.revision) return null
  return {
    ...structuredClone(entry.before),
    revision: currentDocument.revision,
    updatedAt: currentDocument.updatedAt,
  }
}

export function completeIntentUndo(stack, savedDocument) {
  const remaining = stack.slice(0, -1)
  const previous = remaining.at(-1)
  if (!previous) return []
  return [
    ...remaining.slice(0, -1),
    {
      ...previous,
      afterRevision: savedDocument.revision,
    },
  ]
}
