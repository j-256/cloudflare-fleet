function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export function reviewQueueStatus(queues) {
  if (queues.status === "not-configured") return "Define intent to evaluate alignment"
  if (queues.status === "attention") return `${queues.summary.misalignments} item${queues.summary.misalignments === 1 ? " needs" : "s need"} alignment review`
  if (queues.status === "incomplete") return "Read gaps limit the alignment verdict"
  return "No misalignments in the checked scope"
}

export function renderReviewQueue(container, page, actionsForItem) {
  const focused = container.contains(document.activeElement) ? {
    id: document.activeElement.dataset.reviewItem,
    action: document.activeElement.dataset.reviewAction,
  } : null
  const fragment = document.createDocumentFragment()
  if (page.items.length === 0) {
    const empty = element("li", "queue-empty")
    empty.append(element("h3", "", page.queue === "misalignments" ? "No misalignments" : page.queue === "decisions" ? "No decisions waiting" : "No unexpected read issues"))
    const detail = page.queue !== "misalignments"
      ? page.queue === "decisions" ? "No observed differences await an intent decision. Read health retains any coverage limits." : `${page.summary.expectedReadGaps} expected read gaps remain recorded separately.`
      : !page.summary.configured ? "Define intent first. An empty queue does not mean that undefined expectations are satisfied."
      : !page.summary.complete ? "No known mismatch is waiting, but incomplete evidence prevents a complete alignment verdict."
      : `Saved intent is satisfied within the checked scope. ${page.summary.acknowledgedCells} acknowledged exceptions and ${page.summary.expectedReadGaps} expected read gaps remain recorded separately.`
    empty.append(element("p", "", detail))
    fragment.append(empty)
  }
  for (const item of page.items) {
    const row = element("li", "review-queue-item")
    row.dataset.queueItem = item.id
    row.dataset.queueKind = item.kind
    const identity = element("div", "queue-item-identity")
    identity.append(element("h3", "", item.label))
    if (item.kind === "unresolved") identity.append(element("p", "queue-item-reason", "Needs evidence or policy review"))
    identity.append(element("p", "queue-item-scope", item.facet ? `${item.facet.category}${item.zoneCount ? ` / ${item.zoneCount} zone${item.zoneCount === 1 ? "" : "s"}` : ""}` : "Read coverage"))
    if (item.kind !== "decision") identity.append(element("p", "queue-item-reason", item.reason))
    const evidence = element("div", "queue-evidence")
    const observed = element("div", "queue-observed")
    observed.append(element("span", "queue-value-label", "Observed"))
    const values = element("dl", "queue-observed-list")
    for (const value of item.observed) {
      values.append(element("dt", "", value.zoneName), element("dd", "queue-observed-value", value.value))
    }
    if (!item.observed.length) observed.append(element("p", "queue-observed-value", "Evidence needs review"))
    else observed.append(values)
    if (item.zoneCount > item.observed.length) observed.append(element("small", "", `${item.zoneCount - item.observed.length} more zones; compare to inspect the full scope`))
    const expected = element("div", "queue-expected")
    expected.append(element("span", "queue-value-label", item.kind === "decision" ? "Intent" : "Expected"), element("p", "queue-expected-value", item.expected))
    evidence.append(observed, expected)
    const actions = element("div", "queue-item-actions")
    for (const [index, action] of actionsForItem(item).entries()) {
      const button = element("button", `button ${action.primary ? "button-primary" : "button-quiet"}`, action.label)
      button.type = "button"
      button.disabled = Boolean(action.disabled)
      button.setAttribute("aria-label", `${action.label}: ${item.label}`)
      button.dataset.reviewItem = item.id
      button.dataset.reviewAction = String(index)
      button.addEventListener("click", action.run)
      actions.append(button)
      if (action.reason) actions.append(element("p", "queue-action-reason", action.reason))
    }
    row.append(identity, evidence, actions)
    fragment.append(row)
  }
  container.replaceChildren(fragment)
  if (focused) {
    const replacement = [...container.querySelectorAll("button")].find((button) => button.dataset.reviewItem === focused.id && button.dataset.reviewAction === focused.action)
    if (replacement) replacement.focus({ preventScroll: true })
    else document.querySelector("#start-here-heading").focus({ preventScroll: true })
  }
}
