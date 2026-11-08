import { actionButton, attachTooltip } from "./ui-primitives.mjs"
import { DEFAULT_REVIEW_REASON } from "./review-queues.mjs"

const SETTING_LABELS = Object.freeze({
  always_use_https: "Always use HTTPS",
  automatic_https_rewrites: "Automatic HTTPS rewrites",
  min_tls_version: "Minimum TLS version",
  tls_1_3: "TLS 1.3",
  tls_1_2_only: "TLS 1.2 only",
  ssl: "SSL mode",
  ipv6: "IPv6",
  http2: "HTTP/2",
  http3: "HTTP/3",
  security_header: "Security headers",
})

function itemTitle(item) {
  if (item.facet?.category !== "Zone settings" || item.label !== item.facet.key) return item.label
  if (SETTING_LABELS[item.label]) return SETTING_LABELS[item.label]
  const text = item.label.replaceAll("_", " ")
  return text.charAt(0).toUpperCase() + text.slice(1)
}

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
    const title = element("h3", "", itemTitle(item))
    identity.append(title)
    identity.append(element("p", "queue-item-scope", item.facet ? `${item.facet.category}${item.zoneCount ? ` / ${item.zoneCount} zone${item.zoneCount === 1 ? "" : "s"}` : ""}` : "Read coverage"))
    if (item.kind !== "decision" && item.reason !== DEFAULT_REVIEW_REASON) identity.append(element("p", "queue-item-reason", item.reason))
    const evidence = element("div", "queue-evidence")
    const table = element("table", "queue-evidence-table")
    table.setAttribute("aria-label", `Evidence for ${itemTitle(item)}`)
    const head = element("thead")
    const headings = element("tr")
    const expectedLabel = item.kind === "decision" ? "Intent" : "Expected"
    for (const label of ["Zone", "Observed", expectedLabel]) {
      const th = element("th", "queue-value-label", label)
      th.scope = "col"
      headings.append(th)
    }
    head.append(headings)
    const body = element("tbody")
    const samples = item.observed.length ? item.observed : [{ zoneName: "Scope needs review", value: "Evidence needs review" }]
    for (const sample of samples) {
      const tr = element("tr")
      const zone = element("th", "queue-zone", sample.zoneName)
      zone.scope = "row"
      const observed = element("td", "queue-observed")
      observed.dataset.label = "Observed"
      observed.append(element("p", "queue-observed-value", sample.value))
      const expected = element("td", "queue-expected")
      expected.dataset.label = expectedLabel
      expected.append(element("p", "queue-expected-value", sample.expected ?? item.expected))
      tr.append(zone, observed, expected)
      body.append(tr)
    }
    table.append(head, body)
    evidence.append(table)
    if (item.zoneCount > item.observed.length) evidence.append(element("p", "queue-sampling-note", `${item.zoneCount - item.observed.length} more zones; compare for full scope`))
    if (item.kind === "misalignment" && item.observed.some((sample) => sample.value === (sample.expected ?? item.expected))) evidence.append(element("p", "queue-sampling-note", "Other fields differ; compare full values"))
    const actions = element("div", "queue-item-actions")
    for (const [index, action] of actionsForItem(item).entries()) {
      const button = actionButton(action.label, action.run, {
        context: item.label, disabled: action.disabled, icon: action.icon,
        iconOnly: action.iconOnly, tooltipAlign: "end",
      })
      if (action.primary) {
        button.classList.remove("button-quiet")
        button.classList.add("button-primary")
      }
      if (itemTitle(item) !== item.label && !action.iconOnly) attachTooltip(button, `${action.label}: ${item.label}`, { align: "end", dismissOnActivation: true })
      button.dataset.reviewItem = item.id
      button.dataset.reviewAction = String(index)
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
