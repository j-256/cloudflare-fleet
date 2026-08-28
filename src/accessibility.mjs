export function contextualActionLabel(visibleLabel, context) {
  const label = String(visibleLabel || "").trim()
  const detail = String(context || "").trim()
  if (!label) throw new TypeError("Accessible action labels require visible text")
  return detail ? `${label}: ${detail}` : label
}
