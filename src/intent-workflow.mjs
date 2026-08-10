export const INTENT_WORKFLOW_SCREEN = Object.freeze({
  ACKNOWLEDGEMENT: "acknowledgement",
  ADOPTION: "adoption",
  COVERAGE: "coverage",
  DELETE: "delete",
  GROUP: "group",
  MANAGER: "manager",
  POLICY: "policy",
})

const INTENT_WORKFLOW_SCREEN_LABEL = Object.freeze({
  [INTENT_WORKFLOW_SCREEN.ACKNOWLEDGEMENT]: "Acknowledge exact state",
  [INTENT_WORKFLOW_SCREEN.ADOPTION]: "Review ungoverned drift",
  [INTENT_WORKFLOW_SCREEN.COVERAGE]: "Expected coverage",
  [INTENT_WORKFLOW_SCREEN.DELETE]: "Confirm removal",
  [INTENT_WORKFLOW_SCREEN.GROUP]: "Saved scope",
  [INTENT_WORKFLOW_SCREEN.MANAGER]: "Fleet intent",
  [INTENT_WORKFLOW_SCREEN.POLICY]: "Facet policy",
})

export function intentWorkflowScreenLabel(screen) {
  return INTENT_WORKFLOW_SCREEN_LABEL[screen] || "Fleet intent"
}

export function intentWorkflowPath(entries) {
  const labels = entries
    .map((entry) => intentWorkflowScreenLabel(entry.screen))
    .filter((label, index, values) => index === 0 || label !== values[index - 1])
  if (labels[0] !== INTENT_WORKFLOW_SCREEN_LABEL[INTENT_WORKFLOW_SCREEN.MANAGER]) {
    labels.unshift(INTENT_WORKFLOW_SCREEN_LABEL[INTENT_WORKFLOW_SCREEN.MANAGER])
  }
  return labels.join(" / ")
}

export function createIntentWorkflowNavigation() {
  let stack = []
  let visible = false

  function begin(entry) {
    stack = [entry]
    visible = true
    return entry
  }

  return Object.freeze({
    active() {
      return stack[stack.length - 1] || null
    },
    begin,
    clear() {
      const entries = [...stack].reverse()
      stack = []
      visible = false
      return entries
    },
    depth() {
      return stack.length
    },
    entries() {
      return [...stack]
    },
    hide() {
      visible = false
    },
    isVisible() {
      return visible
    },
    pop() {
      if (stack.length <= 1) return null
      const removed = stack.pop()
      return {
        active: stack[stack.length - 1],
        removed,
      }
    },
    push(entry) {
      if (!visible || stack.length === 0) return begin(entry)
      stack.push(entry)
      return entry
    },
    restore() {
      if (stack.length === 0) return null
      visible = true
      return stack[stack.length - 1]
    },
  })
}
