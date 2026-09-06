import { showDialog } from "./dialogs.mjs"

function element(tag, text, className) {
  const node = document.createElement(tag)
  if (text) node.textContent = text
  if (className) node.className = className
  return node
}

export function mountWorkerPanel({ api, readOnly }) {
  const opener = document.querySelector("#show-worker-diagnostics")
  const dialog = document.querySelector("#worker-diagnostics-dialog")
  const content = element("div", null, "worker-diagnostics")
  const close = element("button", "Close", "button button-quiet")
  close.type = "button"
  close.addEventListener("click", () => dialog.close())
  const title = element("h2", "Worker diagnostics")
  title.id = "worker-diagnostics-title"
  content.append(close, title, element("p", "Inspect one Worker's configuration and invocation evidence, review schedules, and preserve incident history."))
  const fields = element("div", null, "worker-diagnostics-fields")
  function field(label, name, type = "text") {
    const wrapper = element("label", label)
    const input = element("input")
    input.id = `worker-${name}`
    input.type = type
    wrapper.htmlFor = input.id
    wrapper.append(input)
    fields.append(wrapper)
    return input
  }
  const worker = field("Worker name or finding ID", "name")
  const start = field("Window start (UTC ISO, optional)", "start")
  const end = field("Window end (UTC ISO, optional)", "end")
  const zones = field("Route zone IDs (comma separated, optional)", "zones")
  content.append(fields)
  const status = element("p", "Enter a Worker name to begin")
  status.setAttribute("role", "status")
  status.setAttribute("aria-live", "polite")
  const actions = element("div", null, "worker-diagnostics-actions")
  const reportArea = element("div")
  const reviewArea = element("section")
  reviewArea.hidden = true
  let revision = ""
  let pending = null
  let busy = false

  const name = () => worker.value.trim().split(":").at(-1)
  const scope = () => ({ ...(worker.value.startsWith("deep.") ? { findingId: worker.value.trim() } : { worker: name() }), ...(start.value.trim() ? { start: start.value.trim() } : {}), ...(end.value.trim() ? { end: end.value.trim() } : {}), ...(zones.value.trim() ? { zoneIds: zones.value.split(",").map((value) => value.trim()) } : {}) })
  function button(label, parent, action, write = false) {
    const button = element("button", label, "button button-quiet")
    button.type = "button"
    button.disabled = write && readOnly
    button.addEventListener("click", () => run(action))
    parent.append(button)
    return button
  }
  async function run(action) {
    if (busy) return
    busy = true
    content.setAttribute("aria-busy", "true")
    status.textContent = "Reading Worker state..."
    try { await action() } catch (error) { status.textContent = error.message }
    finally { busy = false; content.removeAttribute("aria-busy") }
  }
  function jsonDetails(label, value, parent = reportArea) {
    const details = element("details")
    details.append(element("summary", label), element("pre", JSON.stringify(value, null, 2)))
    parent.append(details)
  }
  function table(label, rows, keys) {
    reportArea.append(element("h3", label))
    if (!rows.length) { reportArea.append(element("p", "No observations on this page")); return }
    const table = element("table")
    const head = element("tr")
    for (const key of keys) { const cell = element("th", key.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)); cell.scope = "col"; head.append(cell) }
    const thead = element("thead")
    thead.append(head)
    const tbody = element("tbody")
    for (const row of rows) { const line = element("tr"); for (const key of keys) line.append(element("td", row[key] === null ? "unknown" : String(row[key]))); tbody.append(line) }
    table.append(thead, tbody)
    reportArea.append(table)
  }
  function renderReport(value) {
    reportArea.replaceChildren(element("h3", value.summary))
    status.textContent = value.verification?.status || `Trigger compatibility: ${value.assessment.status}`
    reportArea.append(element("p", `Window: ${value.selector.start} to ${value.selector.end}. Configuration read: ${value.readAt}.`))
    for (const action of value.assessment.recommendedActions) reportArea.append(element("p", action))
    table("Invocation outcomes on this page", value.logs.value?.groups || [], ["eventType", "outcome", "version", "servingVersion", "count"])
    table("HTTP responses on this page", value.logs.value?.httpStatuses || [], ["status", "version", "servingVersion", "count"])
    reportArea.append(element("p", `Log coverage: ${value.logs.status}. Known error signatures: ${value.logs.value?.errorSignatures.join(", ") || "none observed"}.`))
    if (value.logs.value?.nextCursor) button("Next evidence page", reportArea, async () => renderReport(await api.workerCommand("inspect", { ...value.selector, cursor: value.logs.value.nextCursor })))
    jsonDetails("Configuration, handlers, bindings and ingress", { assessment: value.assessment, deployment: value.deployment, versions: value.versions, schedules: value.schedules, ingress: value.ingress, domains: value.domains, routes: value.routes, logging: value.logging })
    jsonDetails("Recent invocation sample", value.logs.value?.samples || [])
    jsonDetails("Coverage and interpretation limits", value.limitations)
    if (value.verification) jsonDetails("Post-change verification", value.verification)
  }
  button("Inspect Worker", actions, async () => renderReport(await api.workerCommand("inspect", scope())))
  button("Record incident", actions, async () => {
    const result = await api.workerCommand("record", scope())
    renderReport(result.record.report)
    status.textContent = `Saved ${result.record.id}`
  }, true)
  async function history(offset = 0) {
    const result = await api.workerCommand("history", { worker: name(), offset })
    revision = result.revision
    reportArea.replaceChildren(element("h3", "Incident history"))
    mode.value = result.intent.mode
    crons.value = result.intent.crons.join("\n")
    owner.value = result.intent.owner || ""
    reconciliation.value = result.intent.reconciliation || ""
    for (const record of result.records) {
      const row = element("section")
      row.append(element("h4", `${record.recordedAt}: ${record.report.verification?.status || record.report.assessment.status}`), element("p", `${record.id}${record.supersedes ? ` supersedes ${record.supersedes}` : ""}`))
      button("View assessment", row, () => { renderReport(record.report); if (record.activityId) activity.value = record.activityId })
      reportArea.append(row)
    }
    if (result.nextOffset !== null) button("Next incident page", reportArea, () => history(result.nextOffset))
    status.textContent = "Incident history and saved intent loaded"
  }
  button("Load history and intent", actions, () => history())
  content.append(actions, status, reportArea)
  const management = element("details")
  management.append(element("summary", "Schedule intent, reviewed changes and recovery"))
  const manageFields = element("div", null, "worker-diagnostics-fields")
  const modeLabel = element("label", "Schedule intent")
  const mode = element("select")
  mode.id = "worker-intent-mode"
  modeLabel.htmlFor = mode.id
  for (const value of ["unmanaged", "disabled", "exact"]) { const option = element("option", value); option.value = value; mode.append(option) }
  modeLabel.append(mode)
  manageFields.append(modeLabel)
  function manageField(label, id, tag = "input") { const wrapper = element("label", label); const input = element(tag); input.id = id; wrapper.htmlFor = id; wrapper.append(input); manageFields.append(wrapper); return input }
  const crons = manageField("Desired Cron expressions (one per line)", "worker-crons", "textarea")
  const owner = manageField("Owning deployment configuration", "worker-owner")
  const reconciliation = manageField("Reviewed configuration reconciliation step", "worker-reconciliation")
  const activity = manageField("Schedule operation ID for verification or undo", "worker-activity")
  const manageActions = element("div", null, "worker-diagnostics-actions")
  const intent = () => ({ mode: mode.value, crons: mode.value === "exact" ? crons.value.split("\n").map((value) => value.trim()).filter(Boolean) : [], owner: owner.value || null, reconciliation: reconciliation.value || null })
  async function review(command, input) {
    pending = null
    reviewArea.replaceChildren()
    const plan = await api.workerCommand(`${command}-plan`, input)
    status.textContent = plan.reason
    if (plan.status !== "planned") { reviewArea.hidden = true; return }
    pending = { command, input: structuredClone(input), digest: plan.planSet.digest }
    reviewArea.hidden = false
    reviewArea.append(element("h3", "Review exact change"), element("p", plan.reason), element("pre", JSON.stringify({ operations: plan.planSet.preview, request: plan.planSet.request }, null, 2)))
    const label = element("label", "I approve this exact change and the configuration reconciliation step")
    const check = element("input")
    check.type = "checkbox"
    label.prepend(check)
    reviewArea.append(label)
    const apply = button("Apply reviewed change", reviewArea, async () => {
      if (!pending || !check.checked) return
      const approved = pending
      pending = null
      const payload = approved.command === "undo" ? { ...approved.input, planDigest: approved.digest } : { input: approved.input, planDigest: approved.digest }
      const result = await api.workerCommand(`${approved.command}-apply`, payload)
      reviewArea.hidden = true
      status.textContent = result.health?.status || result.status
      if (result.activity?.id) activity.value = result.activity.id
      if (result.revision) revision = result.revision
      jsonDetails("Operation result and recovery", result)
    }, true)
    apply.disabled = true
    check.addEventListener("change", () => { apply.disabled = readOnly || !check.checked })
  }
  button("Review intent save", manageActions, async () => {
    const state = await api.workerCommand("history", { worker: name(), limit: 1 })
    revision = state.revision
    return review("intent", { worker: name(), intent: intent(), expectedRevision: revision })
  })
  button("Review schedule change", manageActions, () => review("schedules", { worker: name(), kind: "worker-schedules-update", intent: intent() }))
  button("Review guarded undo", manageActions, () => review("undo", { activityId: activity.value.trim() }))
  button("Verify after change", manageActions, async () => {
    const input = { worker: name(), activityId: activity.value.trim() }
    const result = await api.workerCommand("verify", input)
    renderReport(result.record.report)
  }, true)
  for (const input of [...fields.querySelectorAll("input"), ...manageFields.querySelectorAll("input, select, textarea")]) input.addEventListener("input", () => { pending = null; reviewArea.hidden = true })
  management.append(element("p", "Managed schedules require an owning configuration and a reviewed reconciliation step. An empty Cron array removes triggers; omitting the setting preserves them. Changes can take up to 15 minutes to propagate."), manageFields, manageActions, reviewArea)
  content.append(management)
  if (readOnly) content.append(element("p", "This dashboard is read-only; inspection and history remain available."))
  dialog.append(content)
  opener.addEventListener("click", () => showDialog(dialog, { initialFocus: worker }))
}
