import { contextualActionLabel } from "./accessibility.mjs"
import { icon as createIcon } from "./app-icons.mjs"

const ESCAPE_KEY = "Escape"
const TOOLTIP_DISMISSED_CLASS = "tooltip-dismissed"
const TOOLTIP_ALIGNMENT_CLASS = Object.freeze({
  end: " tooltip--align-end",
  start: " tooltip--align-start",
})

function dismissTooltipOnEscape(event) {
  if (event.key !== ESCAPE_KEY) return
  const host = event.currentTarget
  const active = host.ownerDocument?.activeElement
  if (active !== host && !host.contains(active)) return
  event.preventDefault()
  event.stopPropagation()
  active?.blur()
}

function dismissTooltipOnActivation(event) {
  event.currentTarget.classList.add(TOOLTIP_DISMISSED_CLASS)
}

function restoreTooltip(event) {
  event.currentTarget.classList.remove(TOOLTIP_DISMISSED_CLASS)
}

export function attachTooltip(element, text, options = {}) {
  const content = String(text || "").trim()
  if (!content) return element
  const alignmentClass = TOOLTIP_ALIGNMENT_CLASS[options.align] || ""
  element.classList.add("tooltip-host")
  if (options.focusable && element.tabIndex < 0) element.tabIndex = 0
  const tip = element.ownerDocument.createElement("span")
  tip.className = `tooltip${options.below ? " tooltip--below" : ""}${alignmentClass}`
  tip.textContent = content
  tip.setAttribute("aria-hidden", "true")
  element.append(tip)
  element.addEventListener("keydown", dismissTooltipOnEscape)
  if (options.dismissOnActivation) {
    element.addEventListener("click", dismissTooltipOnActivation)
    element.addEventListener("blur", restoreTooltip)
    element.addEventListener("pointerenter", restoreTooltip)
  }
  return element
}

export function actionButton(label, action, options = {}) {
  const visibleLabel = String(label || "").trim()
  const accessibleName = options.context
    ? contextualActionLabel(visibleLabel, options.context)
    : contextualActionLabel(visibleLabel, "")
  const iconOnly = Boolean(options.iconOnly && options.icon)
  const button = document.createElement("button")
  button.className = `button ${options.danger ? "button-danger" : "button-quiet"}${iconOnly ? " button-icon" : ""}`
  button.type = "button"
  button.disabled = Boolean(options.disabled)
  if (options.icon) button.append(createIcon(options.icon))
  if (!iconOnly) {
    button.append(document.createTextNode(options.icon ? ` ${visibleLabel}` : visibleLabel))
  }
  if (options.context || iconOnly) button.setAttribute("aria-label", accessibleName)
  attachTooltip(button, options.title || (iconOnly ? accessibleName : ""), {
    align: options.tooltipAlign,
    below: options.tooltipBelow,
    dismissOnActivation: true,
  })
  button.addEventListener("click", action)
  return button
}
