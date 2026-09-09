import { showDialog } from "./dialogs.mjs"
import { icon as createIcon } from "./app-icons.mjs"
import { actionButton, attachTooltip } from "./ui-primitives.mjs"

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS

const STATUS_PRESENTATION = Object.freeze({
  active: { icon: "history", tone: "active" },
  aligned: { icon: "ok", tone: "aligned" },
  danger: { icon: "drift", tone: "danger" },
  neutral: { icon: "info", tone: "neutral" },
})

function element(tag, text = null, className = "") {
  const node = document.createElement(tag)
  if (text !== null) node.textContent = text
  if (className) node.className = className
  return node
}

function statusPresentation(text) {
  const value = String(text || "").toLowerCase()
  if (/mismatch|error|fail|denied|unknown/.test(value)) return STATUS_PRESENTATION.danger
  if (/saved|consistent|verified|healthy|observed/.test(value)) return STATUS_PRESENTATION.aligned
  if (/reading|planned|pending/.test(value)) return STATUS_PRESENTATION.active
  return STATUS_PRESENTATION.neutral
}

function utcTime(value) {
  const parsed = new Date(value)
  return Number.isFinite(parsed.valueOf()) ? `${parsed.toISOString().slice(11, 19)} UTC` : "Unknown time"
}

function windowLabel(start, end) {
  const duration = Date.parse(end) - Date.parse(start)
  if (!Number.isFinite(duration) || duration <= 0) return "Custom window"
  if (duration % HOUR_MS === 0) return `${duration / HOUR_MS} h window`
  return `${Math.round(duration / MINUTE_MS)} min window`
}

function tooltipFact(iconName, label, description, tone = "neutral") {
  const fact = element("span", null, `worker-fact ${tone}`)
  fact.setAttribute("role", "listitem")
  fact.tabIndex = 0
  fact.append(createIcon(iconName), element("span", label, "worker-fact-label"))
  return attachTooltip(fact, description, { align: "start" })
}

function disclosure(label, iconName, className = "") {
  const details = element("details", null, className)
  const summary = element("summary")
  summary.append(createIcon(iconName), element("span", label))
  details.append(summary)
  return details
}

function field(labelText, id, parent, tag = "input") {
  const wrapper = element("label", null, "worker-field")
  const label = element("span", labelText, "worker-field-label")
  const input = element(tag)
  input.id = id
  wrapper.htmlFor = id
  wrapper.append(label, input)
  parent.append(wrapper)
  return input
}

export function mountWorkerPanel({ api, readOnly }) {
  const opener = document.querySelector("#show-worker-diagnostics")
  const dialog = document.querySelector("#worker-diagnostics-dialog")
  const content = element("div", null, "worker-diagnostics")
  const header = element("header", null, "worker-diagnostics-header")
  const headerCopy = element("div")
  const title = element("h2", "Diagnose a Worker")
  const description = element("p", "Use this after an alert, failed request, or unexpected scheduled behavior to compare live configuration with recent runtime evidence.")
  title.id = "worker-diagnostics-title"
  description.id = "worker-diagnostics-description"
  headerCopy.append(element("p", "Incident response", "dialog-kicker"), title, description)
  const close = actionButton("Close Worker diagnosis", () => dialog.close(), {
    icon: "close",
    iconOnly: true,
    title: "Close Worker diagnosis",
    tooltipAlign: "end",
    tooltipBelow: true,
  })
  close.classList.add("dialog-close", "worker-diagnostics-close")
  header.append(headerCopy, close)
  dialog.setAttribute("aria-describedby", description.id)
  content.append(header)

  const query = element("section", null, "worker-diagnostics-query")
  const queryHeading = element("div", null, "worker-query-heading")
  queryHeading.append(
    element("h3", "Choose a Worker"),
    element("p", "A name is enough for the default one-hour evidence window."),
  )
  const primaryFields = element("div", null, "worker-diagnostics-fields worker-primary-fields")
  const worker = field("Worker name or finding ID", "worker-name", primaryFields)
  const scopeDetails = disclosure("Evidence scope", "layers", "worker-scope-disclosure")
  const scopeSummaryNote = element("small", "Optional")
  scopeDetails.querySelector("summary").append(scopeSummaryNote)
  const scopeFields = element("div", null, "worker-diagnostics-fields worker-scope-fields")
  const start = field("Window start (UTC ISO, optional)", "worker-start", scopeFields)
  const end = field("Window end (UTC ISO, optional)", "worker-end", scopeFields)
  const zones = field("Route zone IDs (comma separated, optional)", "worker-zones", scopeFields)
  scopeDetails.append(scopeFields)
  query.append(queryHeading, primaryFields, scopeDetails)

  const actions = element("div", null, "worker-diagnostics-actions worker-primary-actions")
  const status = element("p", null, "worker-diagnostics-status")
  status.setAttribute("role", "status")
  status.setAttribute("aria-live", "polite")
  const reportArea = element("section", null, "worker-report-area")
  const reviewArea = element("section", null, "worker-review")
  reviewArea.hidden = true
  let revision = ""
  let pending = null
  let busy = false

  function setStatus(text) {
    const presentation = statusPresentation(text)
    status.dataset.tone = presentation.tone
    status.replaceChildren(createIcon(presentation.icon), element("span", text))
  }

  setStatus("Enter a Worker name to begin")

  const name = () => worker.value.trim().split(":").at(-1)
  const scope = () => ({
    ...(worker.value.startsWith("deep.") ? { findingId: worker.value.trim() } : { worker: name() }),
    ...(start.value.trim() ? { start: start.value.trim() } : {}),
    ...(end.value.trim() ? { end: end.value.trim() } : {}),
    ...(zones.value.trim() ? { zoneIds: zones.value.split(",").map((value) => value.trim()) } : {}),
  })

  async function run(action) {
    if (busy) return
    busy = true
    content.setAttribute("aria-busy", "true")
    setStatus("Reading Worker state...")
    try {
      await action()
    } catch (error) {
      setStatus(error.message)
    } finally {
      busy = false
      content.removeAttribute("aria-busy")
    }
  }

  function button(label, parent, action, options = {}) {
    const control = actionButton(label, () => run(action), {
      disabled: options.write && readOnly,
      icon: options.icon,
      title: options.title,
      tooltipAlign: options.tooltipAlign,
      tooltipBelow: options.tooltipBelow,
    })
    control.classList.add("worker-action")
    if (options.tone) {
      control.classList.remove("button-quiet")
      control.classList.add(`button-${options.tone}`)
    }
    parent.append(control)
    return control
  }

  function jsonDetails(label, value, parent = reportArea) {
    const details = disclosure(label, "layers", "worker-json-details")
    details.append(element("pre", JSON.stringify(value, null, 2)))
    parent.append(details)
  }

  function table(label, rows, keys, parent) {
    const card = element("section", null, "worker-evidence-card")
    const heading = element("header")
    heading.append(
      element("h4", label),
      element("span", `${rows.length} ${rows.length === 1 ? "group" : "groups"}`, "worker-evidence-count"),
    )
    card.append(heading)
    if (!rows.length) {
      card.append(element("p", "No observations on this page", "worker-empty-state"))
      parent.append(card)
      return
    }
    const scroll = element("div", null, "worker-table-scroll")
    scroll.setAttribute("aria-label", `${label} table`)
    scroll.setAttribute("role", "region")
    scroll.tabIndex = 0
    const table = element("table")
    const head = element("tr")
    for (const key of keys) {
      const cell = element("th", key.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`))
      cell.scope = "col"
      head.append(cell)
    }
    const thead = element("thead")
    thead.append(head)
    const tbody = element("tbody")
    for (const row of rows) {
      const line = element("tr")
      for (const key of keys) {
        const text = row[key] === null ? "unknown" : String(row[key])
        const cell = element("td", text)
        cell.dataset.value = text.toLowerCase()
        line.append(cell)
      }
      tbody.append(line)
    }
    table.append(thead, tbody)
    scroll.append(table)
    card.append(scroll)
    parent.append(card)
  }

  function renderReport(value) {
    const report = element("article", null, "worker-report")
    const reportHeader = element("header", null, "worker-report-header")
    const reportHeading = element("div")
    reportHeading.append(
      element("p", "Inspection result", "dialog-kicker"),
      element("h3", value.worker),
    )
    const assessmentStatus = value.verification?.status || value.assessment.status
    const presentation = statusPresentation(assessmentStatus)
    const assessment = element("span", null, `worker-report-state ${presentation.tone}`)
    assessment.append(
      createIcon(presentation.icon),
      element("span", value.verification
        ? `Post-change verification: ${assessmentStatus}`
        : `Trigger compatibility: ${assessmentStatus}`),
    )
    reportHeader.append(reportHeading, assessment)
    report.append(reportHeader)

    const invocationCount = value.logs.value?.invocations
    const facts = element("div", null, "worker-facts")
    facts.setAttribute("role", "list")
    facts.setAttribute("aria-label", "Worker inspection facts")
    facts.append(
      tooltipFact(
        "active",
        `${invocationCount ?? "?"} invocations`,
        `${invocationCount ?? "Unknown"} unique invocation records were observed on this evidence page.`,
        invocationCount === 0 ? "danger" : "manual",
      ),
      tooltipFact(
        "history",
        windowLabel(value.selector.start, value.selector.end),
        `Evidence window: ${value.selector.start} to ${value.selector.end}`,
      ),
      tooltipFact(
        "ok",
        `Read ${utcTime(value.readAt)}`,
        `Worker configuration was read at ${value.readAt}`,
        "aligned",
      ),
      tooltipFact(
        "layers",
        `Logs ${value.logs.status}`,
        "Log availability reflects this bounded query only; missing events do not establish health.",
        value.logs.status === "observed" ? "aligned" : "danger",
      ),
    )
    report.append(facts)

    if (value.assessment.recommendedActions.length) {
      const recommendations = element("section", null, "worker-recommendations")
      const heading = element("h4")
      heading.append(createIcon("drift"), document.createTextNode(" Recommended actions"))
      const list = element("ul")
      for (const action of value.assessment.recommendedActions) {
        const item = element("li")
        item.append(createIcon("chevron"), element("span", action))
        list.append(item)
      }
      recommendations.append(heading, list)
      report.append(recommendations)
    }

    const evidence = element("div", null, "worker-evidence-grid")
    table(
      "Invocation outcomes on this page",
      value.logs.value?.groups || [],
      ["eventType", "outcome", "version", "servingVersion", "count"],
      evidence,
    )
    table(
      "HTTP responses on this page",
      value.logs.value?.httpStatuses || [],
      ["status", "version", "servingVersion", "count"],
      evidence,
    )
    report.append(evidence)

    const signatures = value.logs.value?.errorSignatures || []
    const logNote = element("section", null, `worker-log-note${signatures.length ? " danger" : ""}`)
    logNote.append(
      createIcon(signatures.length ? "drift" : "ok"),
      element("strong", `Known error signatures: ${signatures.length ? signatures.join(", ") : "none observed"}`),
      element("span", `Log coverage: ${value.logs.status}`),
    )
    report.append(logNote)

    if (value.logs.value?.nextCursor) {
      const pagination = element("div", null, "worker-report-pagination")
      button(
        "Next evidence page",
        pagination,
        async () => renderReport(await api.workerCommand("inspect", {
          ...value.selector,
          cursor: value.logs.value.nextCursor,
        })),
        { icon: "chevron", title: "Read the next bounded page of invocation evidence" },
      )
      report.append(pagination)
    }

    const supporting = element("div", null, "worker-supporting-details")
    jsonDetails("Configuration, handlers, bindings and ingress", {
      assessment: value.assessment,
      deployment: value.deployment,
      versions: value.versions,
      schedules: value.schedules,
      ingress: value.ingress,
      domains: value.domains,
      routes: value.routes,
      logging: value.logging,
    }, supporting)
    jsonDetails("Recent invocation sample", value.logs.value?.samples || [], supporting)
    jsonDetails("Coverage and interpretation limits", value.limitations, supporting)
    if (value.verification) jsonDetails("Post-change verification", value.verification, supporting)
    report.append(supporting)
    reportArea.replaceChildren(report)
    setStatus(value.verification?.status || "Inspection complete")
  }

  button(
    "Inspect Worker",
    actions,
    async () => renderReport(await api.workerCommand("inspect", scope())),
    {
      icon: "inspect",
      tone: "primary",
      title: "Read configuration and bounded invocation evidence",
      tooltipAlign: "start",
    },
  )
  button("Record incident", actions, async () => {
    const result = await api.workerCommand("record", scope())
    renderReport(result.record.report)
    setStatus(`Saved ${result.record.id}`)
  }, {
    icon: "record",
    tooltipAlign: "start",
    write: true,
    title: "Preserve this bounded diagnostic report in incident history",
  })

  async function history(offset = 0) {
    const result = await api.workerCommand("history", { worker: name(), offset })
    revision = result.revision
    const historyView = element("article", null, "worker-history")
    const historyHeader = element("header", null, "worker-report-header")
    const historyHeading = element("div")
    historyHeading.append(
      element("p", "Saved evidence", "dialog-kicker"),
      element("h3", "Incident history"),
    )
    historyHeader.append(
      historyHeading,
      element("span", `${result.records.length} on this page`, "worker-evidence-count"),
    )
    historyView.append(historyHeader)
    mode.value = result.intent.mode
    crons.value = result.intent.crons.join("\n")
    owner.value = result.intent.owner || ""
    reconciliation.value = result.intent.reconciliation || ""
    if (!result.records.length) {
      historyView.append(element("p", "No saved incidents for this Worker", "worker-empty-state"))
    }
    for (const record of result.records) {
      const row = element("section", null, "worker-history-card")
      const rowHeading = element("header")
      rowHeading.append(
        element("h4", record.report.verification?.status || record.report.assessment.status),
        element("time", utcTime(record.recordedAt)),
      )
      const identity = element("p")
      identity.append(element("code", record.id))
      if (record.supersedes) identity.append(document.createTextNode(` supersedes ${record.supersedes}`))
      row.append(rowHeading, identity)
      button("View assessment", row, () => {
        renderReport(record.report)
        if (record.activityId) activity.value = record.activityId
      }, { icon: "inspect", title: "Open the saved diagnostic report" })
      historyView.append(row)
    }
    if (result.nextOffset !== null) {
      button("Next incident page", historyView, () => history(result.nextOffset), {
        icon: "chevron",
        title: "Load the next page of saved incidents",
      })
    }
    reportArea.replaceChildren(historyView)
    setStatus("Incident history and saved intent loaded")
  }

  button("Load history and intent", actions, () => history(), {
    icon: "history",
    tooltipAlign: "end",
    title: "Load saved incidents and schedule intent for this Worker",
  })
  query.append(actions, status)
  content.append(query, reportArea)

  const management = disclosure(
    "Schedule intent, reviewed changes and recovery",
    "schedule",
    "worker-management",
  )
  const managementFacts = element("div", null, "worker-management-facts")
  managementFacts.setAttribute("role", "list")
  managementFacts.setAttribute("aria-label", "Schedule change safeguards")
  managementFacts.append(
    tooltipFact(
      "ack",
      "Ownership required",
      "Managed schedules require an owning deployment configuration and reviewed reconciliation step.",
      "manual",
    ),
    tooltipFact(
      "remove",
      "Empty list removes",
      "An exact intent with no Cron expressions removes all scheduled triggers.",
      "danger",
    ),
    tooltipFact(
      "history",
      "Up to 15 min",
      "Cloudflare schedule changes can take up to 15 minutes to propagate.",
    ),
  )
  management.append(managementFacts)
  const manageFields = element("div", null, "worker-diagnostics-fields worker-manage-fields")
  const modeLabel = element("label", null, "worker-field")
  modeLabel.append(element("span", "Schedule intent", "worker-field-label"))
  const mode = element("select")
  mode.id = "worker-intent-mode"
  modeLabel.htmlFor = mode.id
  for (const value of ["unmanaged", "disabled", "exact"]) {
    const option = element("option", value)
    option.value = value
    mode.append(option)
  }
  modeLabel.append(mode)
  manageFields.append(modeLabel)
  const crons = field(
    "Desired Cron expressions (one per line)",
    "worker-crons",
    manageFields,
    "textarea",
  )
  const owner = field("Owning deployment configuration", "worker-owner", manageFields)
  const reconciliation = field(
    "Reviewed configuration reconciliation step",
    "worker-reconciliation",
    manageFields,
  )
  const activity = field(
    "Schedule operation ID for verification or undo",
    "worker-activity",
    manageFields,
  )
  const manageActions = element("div", null, "worker-diagnostics-actions worker-manage-actions")
  const intent = () => ({
    mode: mode.value,
    crons: mode.value === "exact"
      ? crons.value.split("\n").map((value) => value.trim()).filter(Boolean)
      : [],
    owner: owner.value || null,
    reconciliation: reconciliation.value || null,
  })

  async function review(command, input) {
    pending = null
    reviewArea.replaceChildren()
    const plan = await api.workerCommand(`${command}-plan`, input)
    setStatus(plan.reason)
    if (plan.status !== "planned") {
      reviewArea.hidden = true
      return
    }
    pending = { command, input: structuredClone(input), digest: plan.planSet.digest }
    reviewArea.hidden = false
    const reviewHeader = element("header")
    const reviewTitle = element("h3")
    reviewTitle.append(createIcon("ack"), document.createTextNode(" Review exact change"))
    reviewHeader.append(reviewTitle, element("p", plan.reason))
    const preview = element("pre", JSON.stringify({
      operations: plan.planSet.preview,
      request: plan.planSet.request,
    }, null, 2), "worker-review-preview")
    const label = element("label", null, "worker-review-check")
    const check = element("input")
    check.type = "checkbox"
    label.append(
      check,
      element("span", "I approve this exact change and the configuration reconciliation step"),
    )
    reviewArea.append(reviewHeader, preview, label)
    const apply = button("Apply reviewed change", reviewArea, async () => {
      if (!pending || !check.checked) return
      const approved = pending
      pending = null
      const payload = approved.command === "undo"
        ? { ...approved.input, planDigest: approved.digest }
        : { input: approved.input, planDigest: approved.digest }
      const result = await api.workerCommand(`${approved.command}-apply`, payload)
      reviewArea.hidden = true
      setStatus(result.health?.status || result.status)
      if (result.activity?.id) activity.value = result.activity.id
      if (result.revision) revision = result.revision
      jsonDetails("Operation result and recovery", result)
    }, {
      icon: "ack",
      tone: "accent",
      write: true,
      title: "Apply only the reviewed plan digest",
    })
    apply.disabled = true
    check.addEventListener("change", () => {
      apply.disabled = readOnly || !check.checked
    })
  }

  button("Review intent save", manageActions, async () => {
    const state = await api.workerCommand("history", { worker: name(), limit: 1 })
    revision = state.revision
    return review("intent", {
      worker: name(),
      intent: intent(),
      expectedRevision: revision,
    })
  }, {
    icon: "edit",
    title: "Review the exact saved schedule intent before applying it",
  })
  button("Review schedule change", manageActions, () => review("schedules", {
    worker: name(),
    kind: "worker-schedules-update",
    intent: intent(),
  }), { icon: "schedule", title: "Review the exact Cloudflare schedule write" })
  button("Review guarded undo", manageActions, () => review("undo", {
    activityId: activity.value.trim(),
  }), { icon: "undo", title: "Review a guarded inverse of the recorded schedule change" })
  button("Verify after change", manageActions, async () => {
    const input = { worker: name(), activityId: activity.value.trim() }
    const result = await api.workerCommand("verify", input)
    renderReport(result.record.report)
  }, {
    icon: "ok",
    write: true,
    title: "Re-read state and persist post-change verification",
  })

  for (const input of [
    worker,
    ...scopeFields.querySelectorAll("input"),
    ...manageFields.querySelectorAll("input, select, textarea"),
  ]) {
    input.addEventListener("input", () => {
      pending = null
      reviewArea.hidden = true
    })
  }
  management.append(manageFields, manageActions, reviewArea)
  content.append(management)
  if (readOnly) {
    const readOnlyNote = element("p", null, "worker-read-only-note")
    readOnlyNote.append(
      createIcon("info"),
      element("span", "This dashboard is read-only; inspection and history remain available."),
    )
    content.append(readOnlyNote)
  }
  dialog.append(content)
  opener.prepend(createIcon("inspect"))
  attachTooltip(opener, "Open focused diagnostics for one Worker after an alert or unexpected runtime behavior", {
    align: "end",
    below: true,
    dismissOnActivation: true,
  })
  opener.addEventListener("click", () => showDialog(dialog, { initialFocus: worker }))
}
