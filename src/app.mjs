import { CloudflareApi } from "./api.mjs"
import {
  CACHE_RECORD_GLOBAL,
  CACHE_SNAPSHOT_GLOBAL,
  createCacheRecord,
  isCacheRecord,
} from "./cache.mjs"
import {
  FLEET_ACTION_KIND,
  HOLE_RESOLUTION_KIND,
  SESSION_TITLE,
  STATIC_LIMITATIONS,
} from "./constants.mjs"
import { emailPolicyExceptionsForZone } from "./fleet-policy.mjs"
import {
  installDismissibleDialogs,
  showDialog,
} from "./dialogs.mjs"
import {
  coverageFor,
  loadInventory,
} from "./inventory.mjs"
import {
  buildMatrix,
  dnsTargetFillBatch,
  matrixRenderKey,
} from "./matrix.mjs"
import {
  matrixNavigationTarget,
  MATRIX_NAVIGATION_KEYS,
} from "./matrix-navigation.mjs"
import {
  DEFAULT_MATRIX_SCOPE,
  DNS_MATRIX_CATEGORIES,
  facetMatchesScope,
  MATRIX_SCOPE,
  matrixRowMatchesFilters,
} from "./matrix-filter.mjs"
import {
  buildDnsRecordCopyPlan,
  buildDnsRecordEditPlan,
  buildEmailAlignmentPlan,
  buildRuleCopyPlans,
  buildRuleEditPlan,
  buildRuleRenamePlans,
  buildWafAlignmentPlan,
  buildZoneSettingPlan,
  deriveEmailDestination,
  deriveEmailDnsPolicy,
  deriveFleetWafPolicies,
  editableDnsRecordPayload,
  editableRulePayload,
  emailIssues,
  executePlans,
  wafIssues,
} from "./policies.mjs"
import {
  actionResourceId,
  executeActionReadPlan,
  READ_ACTION,
  READ_ACTION_SURFACES,
  rulesetPhaseResourceId,
  rulesetResourceId,
} from "./read-composer.mjs"

const auth = window.__CLOUDFLARE_FLEET_AUTH__
delete window.__CLOUDFLARE_FLEET_AUTH__
const injectedCache = window[CACHE_RECORD_GLOBAL]
delete window[CACHE_RECORD_GLOBAL]
delete window[CACHE_SNAPSHOT_GLOBAL]

const fatal = document.querySelector("#fatal")
const application = document.querySelector("#application")

if ((!auth?.apiToken && !auth?.brokerSecret) || !auth?.accountId) {
  fatal.hidden = false
  document.querySelector("#fatal-message").textContent = "Run ./launch.sh so the terminal can create a protected local session from CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID."
  throw new Error("Cloudflare session auth is unavailable")
}

application.hidden = false

const api = new CloudflareApi(auth)
const readOnly = Boolean(auth.readOnly)
const cachedRecord = isCacheRecord(injectedCache, auth.accountId) ? injectedCache : null
const INVENTORY_SOURCE = Object.freeze({
  CACHE: "cache",
  LIVE: "live",
})
const EMAIL_PREFLIGHT_SURFACE_IDS = READ_ACTION_SURFACES[READ_ACTION.EMAIL_ALIGNMENT]
const WAF_PREFLIGHT_SURFACE_IDS = READ_ACTION_SURFACES[READ_ACTION.WAF_ALIGNMENT]
const LIVE_PLAN_SET = Symbol("live-plan-set")
const MATRIX_CONTROL_SELECTOR = "summary, .cell-action"
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"
const SKIP_LINK_SELECTOR = ".skip-links a, .keyboard-skip"
const TOAST_SUCCESS_TIMEOUT_MS = 7000
const DNS_MATRIX_CATEGORY_SET = new Set(DNS_MATRIX_CATEGORIES)
document.title = readOnly ? SESSION_TITLE.READ_ONLY : SESSION_TITLE.READ_WRITE
const state = {
  abortController: null,
  busy: false,
  busyFocus: null,
  editor: null,
  emailDestination: null,
  emailDnsPolicy: null,
  inventory: null,
  inventorySource: null,
  matrix: null,
  matrixRenderKey: null,
  holeResolution: null,
  ruleRename: null,
  selectedZoneIds: new Set(),
  startupCacheLoadedAt: null,
  toastTimer: null,
  transportAvailable: true,
  wafPolicies: null,
}
const editActionByCell = new WeakMap()
const fillActionByCell = new WeakMap()
const bulkFillRowByButton = new WeakMap()
const fleetActionByButton = new WeakMap()

const elements = {
  alignEmail: document.querySelector("#align-email"),
  alignWaf: document.querySelector("#align-waf"),
  category: document.querySelector("#category"),
  chooseTargets: document.querySelector("#choose-targets"),
  clearSelection: document.querySelector("#clear-selection"),
  confirmApply: document.querySelector("#confirm-apply"),
  confirmCheck: document.querySelector("#confirm-check"),
  confirmDialog: document.querySelector("#confirm-dialog"),
  confirmOperations: document.querySelector("#confirm-operations"),
  confirmPreview: document.querySelector("#confirm-preview"),
  confirmSummary: document.querySelector("#confirm-summary"),
  confirmTitle: document.querySelector("#confirm-title"),
  coverageList: document.querySelector("#coverage-list"),
  differenceToggle: document.querySelector("#difference-toggle"),
  dnsType: document.querySelector("#dns-type"),
  driftCount: document.querySelector("#drift-count"),
  emailPolicyDetail: document.querySelector("#email-policy-detail"),
  emailPolicyDrift: document.querySelector("#email-policy-drift"),
  editorChoice: document.querySelector("#editor-choice"),
  editorChoiceRow: document.querySelector("#editor-choice-row"),
  editorDialog: document.querySelector("#editor-dialog"),
  editorError: document.querySelector("#editor-error"),
  editorForm: document.querySelector("#editor-form"),
  editorKind: document.querySelector("#editor-kind"),
  editorReview: document.querySelector("#editor-review"),
  editorTarget: document.querySelector("#editor-target"),
  editorTitle: document.querySelector("#editor-title"),
  editorValue: document.querySelector("#editor-value"),
  editorValueLabel: document.querySelector("#editor-value-label"),
  facetCount: document.querySelector("#facet-count"),
  holeCount: document.querySelector("#hole-count"),
  holeDialog: document.querySelector("#hole-dialog"),
  holeForm: document.querySelector("#hole-form"),
  holePreview: document.querySelector("#hole-preview"),
  holeSource: document.querySelector("#hole-source"),
  holeTarget: document.querySelector("#hole-target"),
  holeTitle: document.querySelector("#hole-title"),
  loadProgress: document.querySelector("#load-progress"),
  matrixBody: document.querySelector("#matrix-body"),
  matrixHead: document.querySelector("#matrix-head"),
  refresh: document.querySelector("#refresh"),
  refreshDetail: document.querySelector("#refresh-detail"),
  renameCurrent: document.querySelector("#rename-current"),
  renameDialog: document.querySelector("#rename-dialog"),
  renameError: document.querySelector("#rename-error"),
  renameForm: document.querySelector("#rename-form"),
  renameReview: document.querySelector("#rename-review"),
  renameTarget: document.querySelector("#rename-target"),
  renameValue: document.querySelector("#rename-value"),
  search: document.querySelector("#search"),
  selectDrifted: document.querySelector("#select-drifted"),
  selectionCount: document.querySelector("#selection-count"),
  sessionMode: document.querySelector("#session-mode"),
  showEditableSettings: document.querySelector("#show-editable-settings"),
  snapshotTime: document.querySelector("#snapshot-time"),
  scope: document.querySelector("#scope"),
  statusDot: document.querySelector("#status-dot"),
  statusText: document.querySelector("#status-text"),
  targetClear: document.querySelector("#target-clear"),
  targetDialog: document.querySelector("#target-dialog"),
  targetHoles: document.querySelector("#target-holes"),
  targetOptions: document.querySelector("#target-options"),
  targetSelectionSummary: document.querySelector("#target-selection-summary"),
  targetSelectAll: document.querySelector("#target-select-all"),
  targetSelectDrifted: document.querySelector("#target-select-drifted"),
  toast: document.querySelector("#toast"),
  toastDismiss: document.querySelector("#toast-dismiss"),
  toastMessage: document.querySelector("#toast-message"),
  visibleCount: document.querySelector("#visible-count"),
  wafPolicyDetail: document.querySelector("#waf-policy-detail"),
  wafPolicyDrift: document.querySelector("#waf-policy-drift"),
  writePanel: document.querySelector("#write-panel"),
  writeReadiness: document.querySelector("#write-readiness"),
  writeSelectionSummary: document.querySelector("#write-selection-summary"),
  zoneCount: document.querySelector("#zone-count"),
}

elements.sessionMode.textContent = readOnly ? "Read-only session" : "Read/write session"
elements.writePanel.hidden = readOnly

function setStatus(message, mode = "loading") {
  elements.statusText.textContent = message
  elements.statusDot.classList.toggle("cached", mode === "cached")
  elements.statusDot.classList.toggle("ready", mode === "ready")
  elements.statusDot.classList.toggle("error", mode === "error")
}

function setRefreshDetail(message = "", mode = "") {
  elements.refreshDetail.textContent = message
  elements.refreshDetail.hidden = message.length === 0
  elements.refreshDetail.classList.toggle("complete", mode === "complete")
  elements.refreshDetail.classList.toggle("error", mode === "error")
  elements.refreshDetail.removeAttribute("title")
}

function setBusy(busy) {
  if (busy && !state.busy) {
    const activeElement = document.activeElement
    if (activeElement && activeElement !== document.body) {
      state.busyFocus = activeElement
    }
  }
  state.busy = busy
  application.setAttribute("aria-busy", String(busy))
  elements.refresh.disabled = busy || !state.transportAvailable
  elements.editorReview.disabled = busy
  elements.renameReview.disabled = busy
  updateActionButtons()
  if (!busy) {
    const focusTarget = state.busyFocus
    state.busyFocus = null
    if (focusTarget?.isConnected
      && !focusTarget.disabled
      && document.activeElement === document.body) {
      focusTarget.focus({ preventScroll: true })
    }
  }
}

function setWriteReadiness(message, mode = "") {
  if (readOnly) return
  elements.writeReadiness.textContent = message
  elements.writeReadiness.classList.toggle("ready", mode === "ready")
  elements.writeReadiness.classList.toggle("cached", mode === "cached")
}

function restoreInventoryStatus() {
  if (!state.transportAvailable) {
    setStatus("Session broker offline", "error")
    setRefreshDetail("The loaded matrix remains available; relaunch to restore live reads and writes", "error")
    setWriteReadiness("Session broker offline; the loaded dashboard is read-only")
    return
  }
  if (!state.inventory) {
    setStatus("Loading fleet")
    setRefreshDetail()
    setWriteReadiness("Loading live state; writes are unavailable")
    return
  }

  if (state.inventorySource === INVENTORY_SOURCE.CACHE) {
    setStatus("Cached fleet ready", "cached")
    setRefreshDetail("Writes validate live on use; Refresh full fleet runs a complete audit")
    setWriteReadiness(
      "Cached fleet ready; every change is live-validated before confirmation",
      "cached",
    )
    return
  }

  setStatus("Fleet loaded", "ready")
  setRefreshDetail(
    state.startupCacheLoadedAt
      ? "Opened from cache; full live audit completed"
      : "",
    "complete",
  )
  setWriteReadiness(
    "Full live audit loaded; every change is revalidated before confirmation",
    "ready",
  )
}

function hideToast() {
  clearTimeout(state.toastTimer)
  state.toastTimer = null
  elements.toast.hidden = true
  elements.toastMessage.textContent = ""
}

function pauseToastTimer() {
  clearTimeout(state.toastTimer)
  state.toastTimer = null
}

function resumeToastTimer() {
  if (elements.toast.hidden || elements.toast.classList.contains("error")) return
  pauseToastTimer()
  state.toastTimer = setTimeout(hideToast, TOAST_SUCCESS_TIMEOUT_MS)
}

function toast(message, mode = "success") {
  hideToast()
  const isError = mode === "error"
  elements.toastMessage.setAttribute("role", isError ? "alert" : "status")
  elements.toastMessage.setAttribute("aria-live", isError ? "assertive" : "polite")
  elements.toastMessage.textContent = message
  elements.toast.classList.toggle("error", mode === "error")
  elements.toast.hidden = false
  if (!isError) resumeToastTimer()
}

function clearFieldError(input, errorElement) {
  input.removeAttribute("aria-invalid")
  errorElement.hidden = true
  errorElement.textContent = ""
}

function showFieldError(input, errorElement, error) {
  errorElement.textContent = error instanceof Error ? error.message : String(error)
  errorElement.hidden = false
  input.setAttribute("aria-invalid", "true")
  input.focus()
}

function zoneById(zoneId) {
  return state.inventory?.zones.find((zone) => zone.meta.id === zoneId) || null
}

function policyDriftZoneIds() {
  return JSON.parse(elements.selectDrifted.dataset.zoneIds || "[]")
}

function isNewZone(zone) {
  const created = Date.parse(zone.meta.created_on)
  if (!Number.isFinite(created)) return false
  return Date.now() - created < 7 * 24 * 60 * 60 * 1000
}

function createElement(tag, options = {}) {
  const node = document.createElement(tag)
  if (options.className) node.className = options.className
  if (options.text !== undefined) node.textContent = options.text
  return node
}

function prefersReducedMotion() {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches
}

function followSkipLink(event) {
  const link = event.target.closest(SKIP_LINK_SELECTOR)
  if (!link) return
  const targetId = new URL(link.href).hash.slice(1)
  const target = document.getElementById(decodeURIComponent(targetId))
  if (!target) return
  event.preventDefault()
  target.focus({ preventScroll: true })
  target.scrollIntoView({
    behavior: "auto",
    block: "start",
  })
  window.history.replaceState(null, "", `#${targetId}`)
}

function visibleEnabledMatrixActions() {
  return [...elements.matrixBody.querySelectorAll(MATRIX_CONTROL_SELECTOR)]
    .filter((button) => !button.disabled)
    .filter((button) => !button.closest("tr")?.classList.contains("hidden-row"))
}

function syncMatrixActionTabStop(preferred = null) {
  const allActions = [...elements.matrixBody.querySelectorAll(MATRIX_CONTROL_SELECTOR)]
  const available = visibleEnabledMatrixActions()
  const target = available.includes(preferred)
    ? preferred
    : available.find((button) => button.tabIndex === 0) || available[0] || null
  for (const button of allActions) {
    button.tabIndex = button === target ? 0 : -1
  }
}

function focusMatrixAction(action) {
  if (!action) return
  syncMatrixActionTabStop(action)
  action.focus({ preventScroll: true })
  action.scrollIntoView({
    behavior: "auto",
    block: "nearest",
    inline: "nearest",
  })
}

function matrixActionDescriptors() {
  return [...elements.matrixBody.querySelectorAll("tr:not(.hidden-row)")]
    .flatMap((row, rowIndex) => [...row.children].flatMap(
      (cell, cellIndex) => [...cell.querySelectorAll(MATRIX_CONTROL_SELECTOR)]
        .filter((button) => !button.disabled)
        .map((button, actionIndex) => ({
          actionIndex,
          cellIndex,
          rowIndex,
          value: button,
        })),
    ))
}

function handleMatrixActionKeydown(event) {
  const current = event.target.closest(MATRIX_CONTROL_SELECTOR)
  if (!current || !MATRIX_NAVIGATION_KEYS.has(event.key)) return
  const target = matrixNavigationTarget(
    matrixActionDescriptors(),
    current,
    event.key,
    {
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
    },
  )
  if (!target) return
  event.preventDefault()
  focusMatrixAction(target)
}

function isTextEntry(element) {
  return element instanceof HTMLInputElement
    || element instanceof HTMLTextAreaElement
    || element.isContentEditable
}

function handleGlobalShortcut(event) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
  if (event.key === "/" && !isTextEntry(event.target)
    && !document.querySelector("dialog[open]")) {
    event.preventDefault()
    elements.search.focus()
    elements.search.select()
    return
  }
  if (event.key === "Escape" && document.activeElement === elements.search
    && elements.search.value.length > 0) {
    event.preventDefault()
    elements.search.value = ""
    filterRows()
  }
}

function renderSummary() {
  const summary = state.matrix.summary
  elements.zoneCount.textContent = String(summary.zones)
  elements.facetCount.textContent = String(summary.facets)
  elements.driftCount.textContent = String(summary.differences)
  elements.holeCount.textContent = String(summary.missingCells)
  const source = state.inventorySource === INVENTORY_SOURCE.CACHE
    ? "Cached snapshot"
    : "Live snapshot"
  const current = `${source} ${state.inventory.loadedAt}`
  elements.snapshotTime.textContent = state.inventorySource === INVENTORY_SOURCE.LIVE
    && state.startupCacheLoadedAt
    ? `${current} | opened from cache ${state.startupCacheLoadedAt}`
    : current
}

function renderCategories() {
  const previous = elements.category.value
  const counts = new Map()
  for (const row of state.matrix.rows) {
    counts.set(row.category, (counts.get(row.category) || 0) + 1)
  }
  elements.category.replaceChildren(createElement("option", {
    text: `All categories (${state.matrix.rows.length})`,
  }))
  elements.category.firstElementChild.value = ""
  for (const category of state.matrix.categories) {
    const option = createElement("option", {
      text: `${category} (${counts.get(category) || 0})`,
    })
    option.value = category
    elements.category.append(option)
  }
  if (state.matrix.categories.includes(previous)) elements.category.value = previous
}

function renderScopes() {
  const previous = elements.scope.value || DEFAULT_MATRIX_SCOPE
  const zoneCount = state.inventory.zones.length
  const scopes = [
    [MATRIX_SCOPE.FLEET_PATTERNS, "Fleet patterns", "Present in at least two zones"],
    [MATRIX_SCOPE.FLEET_WIDE, "Fleet-wide", "Present in every zone"],
    [MATRIX_SCOPE.ZONE_SPECIFIC, "Zone-specific", "Present in one zone"],
    [MATRIX_SCOPE.ALL, "Everything", "No coverage filter"],
  ]
  elements.scope.replaceChildren(...scopes.map(([value, label, title]) => {
    const count = state.matrix.rows.filter(
      (row) => facetMatchesScope(row.presentCount, zoneCount, value),
    ).length
    const option = createElement("option", {
      text: `${label} (${count})`,
    })
    option.value = value
    option.title = title
    return option
  }))
  elements.scope.value = scopes.some(([value]) => value === previous)
    ? previous
    : DEFAULT_MATRIX_SCOPE
}

function renderDnsTypes() {
  const previous = elements.dnsType.value
  const counts = new Map()
  for (const row of state.matrix.rows) {
    if (!row.recordType) continue
    counts.set(row.recordType, (counts.get(row.recordType) || 0) + 1)
  }
  elements.dnsType.replaceChildren(createElement("option", {
    text: "All DNS types",
  }))
  elements.dnsType.firstElementChild.value = ""
  for (const [recordType, count] of [...counts].sort(([left], [right]) => left.localeCompare(right))) {
    const option = createElement("option", {
      text: `${recordType} (${count})`,
    })
    option.value = recordType
    elements.dnsType.append(option)
  }
  if (counts.has(previous)) elements.dnsType.value = previous
}

function syncDnsTypeAvailability() {
  const category = elements.category.value
  const available = !category || DNS_MATRIX_CATEGORY_SET.has(category)
  elements.dnsType.disabled = !available
  elements.dnsType.title = available
    ? "Limit DNS rows to one record type"
    : "DNS type applies only to DNS categories"
  if (!available) elements.dnsType.value = ""
}

function renderMatrixFilters() {
  renderCategories()
  renderScopes()
  renderDnsTypes()
  syncDnsTypeAvailability()
}

function renderPolicyCards() {
  state.emailDestination = deriveEmailDestination(state.inventory)
  state.emailDnsPolicy = deriveEmailDnsPolicy(state.inventory)
  state.wafPolicies = deriveFleetWafPolicies(state.inventory)
  const zoneCount = state.inventory.zones.length

  const emailPolicyReady = state.emailDestination.available && state.emailDnsPolicy.available
  const emailDrift = emailPolicyReady
    ? state.inventory.zones.filter(
        (zone) => emailIssues(
          zone,
          state.emailDestination.email,
          state.emailDnsPolicy,
          {
            exceptions: emailPolicyExceptionsForZone(zone.meta.name),
          },
        ).length > 0,
      )
    : []
  const acknowledgedEmailZones = emailPolicyReady
    ? state.inventory.zones.filter((zone) => {
        const rawIssues = emailIssues(
          zone,
          state.emailDestination.email,
          state.emailDnsPolicy,
        )
        const actionableIssues = emailIssues(
          zone,
          state.emailDestination.email,
          state.emailDnsPolicy,
          {
            exceptions: emailPolicyExceptionsForZone(zone.meta.name),
          },
        )
        return rawIssues.length > actionableIssues.length
      })
    : []
  const wafPolicyReady = [...state.wafPolicies.values()].every((policy) => policy.available)
  const wafDrift = wafPolicyReady
    ? state.inventory.zones.filter((zone) => wafIssues(zone, state.wafPolicies).length > 0)
    : []

  if (emailPolicyReady) {
    elements.emailPolicyDetail.textContent = `Forward ${state.emailDestination.email} | SPF ${state.emailDnsPolicy.spf.count}/${zoneCount} | DMARC ${state.emailDnsPolicy.dmarc.count}/${zoneCount}`
  } else {
    elements.emailPolicyDetail.textContent = [
      state.emailDestination.available ? "" : state.emailDestination.reason,
      state.emailDnsPolicy.available ? "" : state.emailDnsPolicy.reason,
    ].filter(Boolean).join("; ")
  }
  elements.emailPolicyDrift.textContent = acknowledgedEmailZones.length === 0
    ? `${emailDrift.length} drifted`
    : `${emailDrift.length} drifted | ${acknowledgedEmailZones.length} acknowledged`

  if (wafPolicyReady) {
    const counts = [...state.wafPolicies.values()].map((policy) => policy.count)
    const policyCount = state.wafPolicies.size
    const consensusCount = counts.length > 0 ? Math.min(...counts) : 0
    elements.wafPolicyDetail.textContent = `${policyCount} named fleet rule${policyCount === 1 ? "" : "s"} | consensus ${consensusCount}/${zoneCount} zones`
  } else {
    const reasons = [...state.wafPolicies.values()].filter((policy) => !policy.available).map((policy) => policy.reason)
    elements.wafPolicyDetail.textContent = reasons.join("; ")
  }
  elements.wafPolicyDrift.textContent = `${wafDrift.length} drifted`

  elements.selectDrifted.dataset.zoneIds = JSON.stringify(
    [...new Set([...emailDrift, ...wafDrift].map((zone) => zone.meta.id))],
  )
}

function zoneHeading(zone) {
  const th = createElement("th", { className: "zone-heading" })
  th.scope = "col"
  th.dataset.zoneId = zone.meta.id

  const label = createElement("label")
  const checkbox = document.createElement("input")
  checkbox.type = "checkbox"
  checkbox.checked = state.selectedZoneIds.has(zone.meta.id)
  checkbox.dataset.zoneId = zone.meta.id
  checkbox.setAttribute("aria-label", `Select ${zone.meta.name}`)

  const text = createElement("span", { text: zone.meta.name })
  const created = createElement("time", { text: new Date(zone.meta.created_on).toLocaleDateString() })
  created.dateTime = zone.meta.created_on
  created.className = "zone-created"
  text.append(created)
  if (isNewZone(zone)) text.append(createElement("span", { className: "new-badge", text: "New" }))

  label.append(checkbox, text)
  th.append(label)
  th.classList.toggle("selected", checkbox.checked)
  return th
}

function editActionLabel(action, row, zone) {
  if (action.type === "zone-setting") {
    return `Edit ${action.settingId} on ${zone.meta.name}`
  }
  if (action.type === "dns-records") {
    return `Edit ${row.label} records on ${zone.meta.name}`
  }
  if (action.type === "ruleset-rule") {
    return `Edit ${row.label} on ${zone.meta.name}`
  }
  return `Edit ${row.label} on ${zone.meta.name}`
}

function matrixCell(row, zone) {
  const cell = row.cells.get(zone.meta.name)
  const td = createElement("td", { className: "matrix-cell" })
  td.dataset.zoneId = zone.meta.id
  td.classList.toggle("selected-column", state.selectedZoneIds.has(zone.meta.id))

  if (!cell) {
    td.classList.add("missing")
    td.append(createElement("span", { className: "cell-state", text: "Missing" }))
    const resolution = row.missingResolutions.get(zone.meta.name)
    if (resolution?.available && !readOnly) {
      const action = {
        category: row.category,
        key: row.key,
        label: row.label,
        resolution,
      }
      const label = `Fill ${row.label} on ${zone.meta.name}`
      td.classList.add("actionable-cell", "fillable-hole")
      td.title = `${label}; live state and the complete API plan will be reviewed first`
      td.dataset.editTitle = td.title
      fillActionByCell.set(td, action)
      const fillButton = createElement("button", {
        className: "cell-action fill-hole",
        text: "Fill",
      })
      fillButton.type = "button"
      fillButton.setAttribute("aria-label", label)
      fillButton.title = "Build a live plan from the fleet value"
      fillButton.disabled = state.busy
      td.append(fillButton)
    } else if (resolution?.reason) {
      td.title = resolution.reason
      td.setAttribute(
        "aria-label",
        `Missing ${row.label} on ${zone.meta.name}. ${resolution.reason}`,
      )
    }
    return td
  }

  td.classList.add(`variant-${row.variantIndexes.get(cell.canonical) || 0}`)
  const directlyEditable = Boolean(cell.action && !readOnly)
  if (cell.full !== cell.display && !directlyEditable) {
    const details = document.createElement("details")
    details.append(
      createElement("summary", { text: cell.display }),
      createElement("pre", { text: cell.full }),
    )
    td.append(details)
  } else {
    td.append(createElement("span", {
      className: directlyEditable ? "cell-display" : "",
      text: cell.display,
    }))
  }

  if (directlyEditable) {
    const label = editActionLabel(cell.action, row, zone)
    td.classList.add("actionable-cell", "editable-cell")
    td.title = `${label}; the desired state may expand into multiple API operations`
    td.dataset.editTitle = td.title
    editActionByCell.set(td, cell.action)
  }

  if (directlyEditable || (cell.secondaryAction && !readOnly)) {
    const actions = createElement("div", { className: "cell-actions" })
    if (directlyEditable) {
      const editButton = createElement("button", {
        className: "cell-action edit-cell",
        text: "Edit",
      })
      editButton.type = "button"
      editButton.setAttribute("aria-label", editActionLabel(cell.action, row, zone))
      editButton.title = "Open the desired-state editor; live state is checked before confirmation"
      editButton.disabled = state.busy
      actions.append(editButton)
    }
    if (cell.secondaryAction && !readOnly) {
      td.classList.add("has-secondary-action")
      const button = createElement("button", {
        className: "cell-action copy-rule",
        text: "Copy",
      })
      button.type = "button"
      button.dataset.phase = cell.secondaryAction.phase
      button.dataset.ruleId = cell.secondaryAction.ruleId
      button.dataset.rulesetId = cell.secondaryAction.rulesetId
      button.dataset.sourceZoneId = cell.secondaryAction.sourceZoneId
      button.setAttribute(
        "aria-label",
        `Copy ${row.label} from ${zone.meta.name} to selected zones`,
      )
      button.title = `Copy this rule from ${zone.meta.name} to the selected zones after live validation`
      button.disabled = state.busy
      actions.append(button)
    }
    td.append(actions)
  }

  const showCapability = cell.capability
    && (readOnly
      || !cell.action
      || (cell.capability.kind === "not-copyable" && !cell.secondaryAction))
  if (showCapability) {
    const capability = createElement("small", {
      className: `cell-capability ${cell.capability.kind}`,
      text: cell.capability.label,
    })
    if (cell.capability.reason) capability.title = cell.capability.reason
    capability.setAttribute(
      "aria-label",
      cell.capability.reason
        ? `${cell.capability.label}. ${cell.capability.reason}`
        : cell.capability.label,
    )
    td.append(capability)
  }

  return td
}

function renderMatrix() {
  const headerRow = document.createElement("tr")
  const categoryHeading = createElement("th", { className: "category-heading", text: "Category" })
  const facetHeading = createElement("th", { className: "facet-heading", text: "Facet" })
  categoryHeading.scope = "col"
  facetHeading.scope = "col"
  headerRow.append(categoryHeading, facetHeading)
  for (const zone of state.inventory.zones) headerRow.append(zoneHeading(zone))
  elements.matrixHead.replaceChildren(headerRow)

  const fragment = document.createDocumentFragment()
  for (const row of state.matrix.rows) {
    const tr = document.createElement("tr")
    tr.dataset.category = row.category
    tr.dataset.different = String(row.different)
    tr.dataset.missingZoneIds = row.missingZoneIds.join(" ")
    tr.dataset.presentCount = String(row.presentCount)
    tr.dataset.recordType = row.recordType
    tr.dataset.search = row.search

    const categoryCell = createElement("th", { className: "category-cell", text: row.category })
    categoryCell.scope = "row"
    const facetCell = createElement("th", { className: "facet-cell" })
    facetCell.scope = "row"
    facetCell.append(createElement("span", { text: row.label }))
    if (row.description) facetCell.append(createElement("small", { text: row.description }))
    const facetActions = createElement("div", { className: "facet-actions" })
    const actionTypes = new Set(
      [...row.cells.values()].map((cell) => cell.action?.type).filter(Boolean),
    )
    const secondaryActionTypes = new Set(
      [...row.cells.values()].map((cell) => cell.secondaryAction?.type).filter(Boolean),
    )
    if (actionTypes.has("zone-setting")) {
      facetActions.append(createElement("small", { className: "capability-badge", text: "Edit settings" }))
    }
    if (actionTypes.has("ruleset-rule")) {
      facetActions.append(createElement("small", { className: "capability-badge rule", text: "Edit rules" }))
    }
    if (actionTypes.has("dns-records")) {
      facetActions.append(createElement("small", { className: "capability-badge dns", text: "Edit DNS" }))
    }
    if (secondaryActionTypes.has("ruleset-rule-copy")) {
      facetActions.append(createElement("small", { className: "capability-badge copy", text: "Copy rules" }))
    }
    if (row.resolutionKind === HOLE_RESOLUTION_KIND.DNS_RECORDS && !readOnly) {
      const bulkFillButton = createElement("button", {
        className: "cell-action bulk-fill",
        text: "Fill targets",
      })
      bulkFillButton.type = "button"
      bulkFillButton.hidden = true
      bulkFillButton.disabled = true
      bulkFillRowByButton.set(bulkFillButton, row)
      facetActions.append(bulkFillButton)
    }
    if (row.fleetAction?.type === FLEET_ACTION_KIND.RULE_RENAME && !readOnly) {
      const renameButton = createElement("button", {
        className: "cell-action rename-rule",
        text: "Rename fleet",
      })
      renameButton.type = "button"
      renameButton.setAttribute("aria-label", `Rename ${row.label} across fleet`)
      renameButton.title = `Rename ${row.fleetAction.rules.length} live rule instance${row.fleetAction.rules.length === 1 ? "" : "s"} after live validation`
      renameButton.dataset.actionTitle = renameButton.title
      renameButton.disabled = state.busy
      fleetActionByButton.set(renameButton, row.fleetAction)
      facetActions.append(renameButton)
    } else if (row.fleetActionReason) {
      const unavailable = createElement("small", {
        className: "capability-badge unavailable",
        text: "Rename blocked",
      })
      unavailable.title = row.fleetActionReason
      unavailable.setAttribute(
        "aria-label",
        `Fleet rename unavailable. ${row.fleetActionReason}`,
      )
      facetActions.append(unavailable)
    }
    if (facetActions.children.length > 0) facetCell.append(facetActions)
    tr.append(categoryCell, facetCell)
    for (const zone of state.inventory.zones) tr.append(matrixCell(row, zone))
    fragment.append(tr)
  }
  elements.matrixBody.replaceChildren(fragment)
  filterRows()
}

function renderCoverage() {
  const fragment = document.createDocumentFragment()
  for (const coverage of coverageFor(state.inventory)) {
    const item = createElement("li", { className: coverage.ok ? "" : "failed" })
    item.append(
      createElement("span", { text: coverage.label }),
      createElement("small", { text: coverage.detail }),
    )
    fragment.append(item)
  }
  for (const limitation of STATIC_LIMITATIONS) {
    const item = createElement("li", { className: "blocked" })
    item.append(
      createElement("span", { text: limitation.label }),
      createElement("small", { text: limitation.detail }),
    )
    fragment.append(item)
  }
  elements.coverageList.replaceChildren(fragment)
}

function filterRows() {
  const rows = [...elements.matrixBody.querySelectorAll("tr")]
  const filters = {
    category: elements.category.value,
    differencesOnly: elements.differenceToggle.getAttribute("aria-pressed") === "true",
    query: elements.search.value,
    recordType: elements.dnsType.value,
    scope: elements.scope.value,
    targetHolesOnly: elements.targetHoles.getAttribute("aria-pressed") === "true",
    targetZoneIds: state.selectedZoneIds,
    zoneCount: state.inventory?.zones.length || 0,
  }
  let visible = 0

  for (const row of rows) {
    const show = matrixRowMatchesFilters({
      category: row.dataset.category,
      different: row.dataset.different === "true",
      missingZoneIds: row.dataset.missingZoneIds.split(" ").filter(Boolean),
      presentCount: Number(row.dataset.presentCount),
      recordType: row.dataset.recordType,
      search: row.dataset.search,
    }, filters)
    row.classList.toggle("hidden-row", !show)
    if (show) visible += 1
  }

  elements.visibleCount.textContent = `${visible} / ${rows.length} facets`
  syncMatrixActionTabStop()
}

function updateSelectionStyles() {
  const count = state.selectedZoneIds.size
  const targetHolesWasActive = elements.targetHoles.getAttribute("aria-pressed") === "true"
  const driftCount = policyDriftZoneIds().length
  const zoneCount = state.inventory?.zones.length || 0
  elements.selectionCount.textContent = String(count)
  elements.writeSelectionSummary.textContent = count === 0
    ? "No target zones selected"
    : `${count} target zone${count === 1 ? "" : "s"} selected`
  for (const element of document.querySelectorAll("[data-zone-id]")) {
    const selected = state.selectedZoneIds.has(element.dataset.zoneId)
    if (element.classList.contains("zone-heading")) element.classList.toggle("selected", selected)
    if (element.classList.contains("matrix-cell")) element.classList.toggle("selected-column", selected)
  }
  elements.clearSelection.disabled = count === 0
  elements.selectDrifted.disabled = driftCount === 0
  elements.targetClear.disabled = count === 0
  elements.targetHoles.disabled = count === 0
  elements.targetSelectAll.disabled = zoneCount > 0 && count === zoneCount
  elements.targetSelectDrifted.disabled = driftCount === 0
  if (count === 0 && targetHolesWasActive) {
    elements.targetHoles.setAttribute("aria-pressed", "false")
    elements.targetHoles.textContent = "Target holes"
  }
  if (elements.targetDialog.open) updateTargetSelectionSummary()
  updateActionButtons()
  if (targetHolesWasActive) filterRows()
}

function syncSelectionControls() {
  for (const checkbox of document.querySelectorAll("input[data-zone-id]")) {
    checkbox.checked = state.selectedZoneIds.has(checkbox.dataset.zoneId)
  }
  updateSelectionStyles()
}

function selectZoneIds(zoneIds) {
  state.selectedZoneIds = new Set(zoneIds)
  syncSelectionControls()
}

function updateActionButtons() {
  const hasSelection = state.selectedZoneIds.size > 0
  const writeLocked = state.busy
    || readOnly
    || !state.inventory
    || !state.transportAvailable
  const writeLockReason = !state.transportAvailable
    ? "Session broker offline; relaunch to restore live writes"
    : "Another fleet operation is in progress"
  elements.alignEmail.disabled = writeLocked || !hasSelection
  elements.alignWaf.disabled = writeLocked || !hasSelection
  elements.alignEmail.title = !hasSelection && !readOnly
    ? "Choose at least one target zone first"
    : "Live-validates Email Routing and DNS state before confirmation"
  elements.alignWaf.title = !hasSelection && !readOnly
    ? "Choose at least one target zone first"
    : "Live-validates shared WAF rules before confirmation"
  elements.chooseTargets.disabled = state.busy || !state.inventory
  elements.showEditableSettings.disabled = !state.matrix

  for (const cell of document.querySelectorAll(".editable-cell, .fillable-hole")) {
    cell.classList.toggle("write-locked", writeLocked)
    cell.title = writeLocked
      ? writeLockReason
      : cell.dataset.editTitle
  }
  for (const button of document.querySelectorAll(".edit-cell")) {
    button.disabled = writeLocked
  }
  for (const button of document.querySelectorAll(".fill-hole")) {
    button.disabled = writeLocked
    if (writeLocked) button.title = writeLockReason
  }
  for (const button of document.querySelectorAll(".bulk-fill")) {
    const row = bulkFillRowByButton.get(button)
    const batch = row
      ? dnsTargetFillBatch(row, state.inventory, state.selectedZoneIds)
      : {
          available: false,
          reason: "The DNS facet is unavailable",
          targetZoneIds: [],
        }
    const targetCount = batch.targetZoneIds.length
    button.hidden = targetCount === 0
    button.disabled = writeLocked || !batch.available
    button.textContent = batch.available
      ? `Fill ${targetCount} target${targetCount === 1 ? "" : "s"}`
      : "Choose per cell"
    button.title = writeLocked
      ? writeLockReason
      : batch.available
        ? `Build one live DNS plan for ${targetCount} selected target zone${targetCount === 1 ? "" : "s"}`
        : batch.reason
    button.setAttribute(
      "aria-label",
      batch.available
        ? `Fill ${row.label} on ${targetCount} selected target zone${targetCount === 1 ? "" : "s"}`
        : `Bulk fill unavailable for ${row?.label || "this DNS facet"}. ${batch.reason}`,
    )
  }
  for (const button of document.querySelectorAll(".copy-rule")) {
    const targetCount = state.selectedZoneIds.size
      - (state.selectedZoneIds.has(button.dataset.sourceZoneId) ? 1 : 0)
    button.disabled = writeLocked || targetCount === 0
    button.title = writeLocked
      ? writeLockReason
      : targetCount === 0
        ? "Choose at least one destination zone other than the source"
        : `Copy this rule to ${targetCount} selected destination zone${targetCount === 1 ? "" : "s"} after live validation`
  }
  for (const button of document.querySelectorAll(".rename-rule")) {
    button.disabled = writeLocked
    button.title = writeLocked ? writeLockReason : button.dataset.actionTitle
  }
  syncMatrixActionTabStop()
}

function updateTargetSelectionSummary() {
  const count = state.selectedZoneIds.size
  elements.targetSelectionSummary.textContent = count === 0
    ? "No target zones selected"
    : `${count} target zone${count === 1 ? "" : "s"} selected`
}

function renderTargetOptions() {
  const drifted = new Set(policyDriftZoneIds())
  const fragment = document.createDocumentFragment()

  for (const zone of state.inventory.zones) {
    const label = createElement("label", { className: "target-option" })
    const checkbox = document.createElement("input")
    checkbox.type = "checkbox"
    checkbox.checked = state.selectedZoneIds.has(zone.meta.id)
    checkbox.dataset.zoneId = zone.meta.id

    const copy = createElement("span")
    copy.append(createElement("strong", { text: zone.meta.name }))
    copy.append(createElement("small", {
      text: drifted.has(zone.meta.id) ? "Policy drift detected" : "Policy aligned",
    }))
    label.append(checkbox, copy)
    fragment.append(label)
  }

  elements.targetOptions.replaceChildren(fragment)
  updateTargetSelectionSummary()
}

function showTargetDialog() {
  renderTargetOptions()
  showDialog(elements.targetDialog, {
    initialFocus: elements.targetOptions.querySelector("input"),
  })
}

function showEditableSettings() {
  elements.search.value = ""
  elements.category.value = "Zone settings"
  elements.dnsType.value = ""
  elements.differenceToggle.setAttribute("aria-pressed", "false")
  elements.differenceToggle.textContent = "All rows"
  syncDnsTypeAvailability()
  filterRows()

  const firstEdit = [...elements.matrixBody.querySelectorAll(".editable-cell")]
    .find((cell) => cell.offsetParent !== null)
  firstEdit?.scrollIntoView({
    behavior: prefersReducedMotion() ? "auto" : "smooth",
    block: "center",
    inline: "center",
  })
  firstEdit?.querySelector(".edit-cell")?.focus({ preventScroll: true })
}

function operationPreview(plans) {
  return plans.flatMap((plan) => plan.operations.map((operation) => {
    const preview = {
      body: operation.body,
      label: operation.label,
      method: operation.method,
      path: operation.path,
      zone: plan.zoneName,
    }
    if (Object.hasOwn(operation, "currentValue")) {
      preview.currentValue = operation.currentValue
    }
    return preview
  }))
}

function createLivePlanSet(plans) {
  return Object.freeze({
    [LIVE_PLAN_SET]: true,
    plans,
    validatedAt: new Date().toISOString(),
  })
}

function confirmPlans(title, planSet) {
  if (!planSet?.[LIVE_PLAN_SET]) {
    toast("This change has not passed live validation", "error")
    return Promise.resolve(false)
  }
  const plans = planSet.plans
  const actionable = plans.filter((plan) => plan.operations.length > 0)
  if (actionable.length === 0) {
    toast("Live validation found that the selected zones already match")
    return Promise.resolve(false)
  }

  elements.confirmTitle.textContent = title
  const operations = operationPreview(actionable)
  const validationTime = new Date(planSet.validatedAt).toLocaleTimeString()
  elements.confirmSummary.textContent = `Live state was validated at ${validationTime}. ${actionable.length} zone${actionable.length === 1 ? "" : "s"} and ${operations.length} API write${operations.length === 1 ? "" : "s"} will be applied, then the full fleet will be re-read.`
  elements.confirmOperations.replaceChildren()
  for (const operation of operations) {
    const item = createElement("div", { className: "operation" })
    item.setAttribute("role", "listitem")
    item.append(
      createElement("code", { text: operation.method }),
      createElement("span", { text: operation.path }),
      createElement("small", { text: `${operation.zone}: ${operation.label}` }),
    )
    elements.confirmOperations.append(item)
  }
  elements.confirmPreview.textContent = JSON.stringify(operations, null, 2)
  elements.confirmCheck.checked = false
  elements.confirmApply.disabled = true

  return new Promise((resolve) => {
    elements.confirmDialog.addEventListener("close", () => {
      resolve(elements.confirmDialog.returnValue === "apply")
    }, { once: true })
    showDialog(elements.confirmDialog, {
      initialFocus: elements.confirmDialog.querySelector("[value='cancel']"),
    })
  })
}

async function applyPlans(title, planSet) {
  if (!planSet?.[LIVE_PLAN_SET]) {
    toast("This change has not passed live validation", "error")
    return
  }
  if (!await confirmPlans(title, planSet)) return
  const plans = planSet.plans
  setBusy(true)
  try {
    await executePlans(api, plans, {
      onProgress: ({ completed, total, operation, plan }) => {
        if (operation) setStatus(`Writing ${completed + 1}/${total}: ${plan.zoneName}`)
      },
    })
    toast("Writes succeeded; re-reading the fleet for verification")
    await refreshInventory({ preserveSelection: true })
  } catch (error) {
    setStatus("Write failed", "error")
    toast(error instanceof Error ? error.message : String(error), "error")
    await refreshInventory({ preserveSelection: true })
  } finally {
    setBusy(false)
  }
}

async function runWritePreflight(label, reader) {
  setBusy(true)
  setStatus(`Validating ${label}`)
  setRefreshDetail("Reading only the live data required for this change")
  setWriteReadiness("Live-validating this change before confirmation")
  try {
    return await reader()
  } finally {
    setBusy(false)
    restoreInventoryStatus()
  }
}

function assertSurfaceReads(inventory, surfaceIds, label) {
  const failures = inventory.zones.flatMap((zone) => surfaceIds
    .filter((surfaceId) => !zone.surfaces[surfaceId]?.ok)
    .map((surfaceId) => `${zone.meta.name}: ${surfaceId}`))
  if (failures.length > 0) {
    throw new Error(`${label} live validation could not read ${failures.join(", ")}`)
  }
}

function selectedLiveZones(inventory, zoneIds) {
  const byId = new Map(inventory.zones.map((zone) => [zone.meta.id, zone]))
  const missing = zoneIds.filter((zoneId) => !byId.has(zoneId))
  if (missing.length > 0) {
    throw new Error("One or more selected zones no longer exist in the account")
  }
  return zoneIds.map((zoneId) => byId.get(zoneId))
}

function executePreflightRead(actions) {
  return executeActionReadPlan(api, actions, {
    onProgress: ({ message }) => {
      elements.refreshDetail.title = message
    },
  })
}

async function alignEmailZoneIds(zoneIds, title = "Align Email Routing") {
  try {
    const liveData = await runWritePreflight(
      "Email Routing",
      () => executePreflightRead([
        {
          type: READ_ACTION.EMAIL_ALIGNMENT,
        },
      ]),
    )
    const liveInventory = liveData.inventory
    assertSurfaceReads(liveInventory, EMAIL_PREFLIGHT_SURFACE_IDS, "Email Routing")
    if (!liveInventory.account.emailAddresses.ok) {
      throw new Error("Email Routing live validation could not read verified account addresses")
    }
    const destination = deriveEmailDestination(liveInventory)
    const dnsPolicy = deriveEmailDnsPolicy(liveInventory)
    if (!destination.available) throw new Error(destination.reason)
    if (!dnsPolicy.available) throw new Error(dnsPolicy.reason)
    const plans = selectedLiveZones(liveInventory, zoneIds).map(
      (zone) => buildEmailAlignmentPlan(
        zone,
        destination.email,
        dnsPolicy,
        {
          exceptions: emailPolicyExceptionsForZone(zone.meta.name),
        },
      ),
    )
    await applyPlans(title, createLivePlanSet(plans))
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error")
  }
}

async function alignEmail() {
  await alignEmailZoneIds([...state.selectedZoneIds])
}

async function alignWaf() {
  const zoneIds = [...state.selectedZoneIds]
  try {
    const liveData = await runWritePreflight(
      "shared WAF rules",
      () => executePreflightRead([
        {
          type: READ_ACTION.WAF_ALIGNMENT,
        },
      ]),
    )
    const liveInventory = liveData.inventory
    assertSurfaceReads(liveInventory, WAF_PREFLIGHT_SURFACE_IDS, "Shared WAF")
    const detailFailures = liveInventory.zones.flatMap((zone) => zone.ruleDetails
      .filter((detail) => !detail.ok)
      .map(() => zone.meta.name))
    if (detailFailures.length > 0) {
      throw new Error(`Shared WAF live validation could not read rule details for ${detailFailures.join(", ")}`)
    }
    const policies = deriveFleetWafPolicies(liveInventory)
    const unavailable = [...policies.values()].find((policy) => !policy.available)
    if (unavailable) throw new Error(unavailable.reason)
    const plans = selectedLiveZones(liveInventory, zoneIds)
      .map((zone) => buildWafAlignmentPlan(zone, policies))
    await applyPlans("Align shared WAF rules", createLivePlanSet(plans))
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error")
  }
}

async function copyRule(source, targetZoneIds, title = "") {
  const sourceZoneId = source.sourceZoneId
  const sourceZone = zoneById(sourceZoneId)
  const phase = source.phase
  try {
    const liveData = await runWritePreflight(
      `${phase} rule copy`,
      () => executePreflightRead([
        {
          phase,
          rulesetId: source.rulesetId,
          sourceZoneId,
          targetZoneIds,
          type: READ_ACTION.RULE_COPY,
        },
      ]),
    )
    const liveInventory = liveData.inventory
    const liveMetadata = selectedLiveZones(
      liveInventory,
      [sourceZoneId, ...targetZoneIds],
    )
    const metadataById = new Map(
      liveMetadata.map((zone) => [zone.meta.id, zone]),
    )
    const sourceRuleset = liveData.resources.get(
      rulesetResourceId(sourceZoneId, source.rulesetId),
    )
    if (!sourceRuleset) {
      throw new Error(`Rule copy live validation could not read the source ${phase} ruleset`)
    }
    const liveSource = {
      ...metadataById.get(sourceZoneId),
      ruleDetails: [
        {
          ok: true,
          result: sourceRuleset,
        },
      ],
    }
    const liveTargets = targetZoneIds.map((zoneId) => {
      const phaseData = liveData.rulePhases.get(
        rulesetPhaseResourceId(zoneId, phase),
      )
      if (!phaseData) {
        throw new Error(`Rule copy live validation could not read ${phase} on ${metadataById.get(zoneId).meta.name}`)
      }
      return {
        ...metadataById.get(zoneId),
        ruleDetails: phaseData.details.map((ruleset) => ({
          ok: true,
          result: ruleset,
        })),
      }
    })
    const plans = buildRuleCopyPlans(liveSource, liveTargets, {
      phase,
      ruleId: source.ruleId,
      rulesetId: source.rulesetId,
    })
    await applyPlans(
      title || `Copy ${phase} rule from ${sourceZone?.meta.name || liveSource.meta.name}`,
      createLivePlanSet(plans),
    )
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error")
  }
}

async function copyRuleToSelected(button) {
  const sourceZoneId = button.dataset.sourceZoneId
  const targetZoneIds = [...state.selectedZoneIds].filter((zoneId) => zoneId !== sourceZoneId)
  if (targetZoneIds.length === 0) {
    toast("Choose at least one destination zone other than the source", "error")
    return
  }
  await copyRule(
    {
      phase: button.dataset.phase,
      ruleId: button.dataset.ruleId,
      rulesetId: button.dataset.rulesetId,
      sourceZoneId,
    },
    targetZoneIds,
  )
}

function openRuleRename(button) {
  if (state.busy || readOnly || !state.transportAvailable) return
  const action = fleetActionByButton.get(button)
  if (!action) {
    toast("The fleet rename action is unavailable", "error")
    return
  }
  state.ruleRename = { action }
  elements.renameCurrent.textContent = action.currentName
  elements.renameTarget.textContent = `${action.rules.length} existing rule instance${action.rules.length === 1 ? "" : "s"} will be reread and renamed. ${action.missingZoneCount === 0 ? "Every zone has this rule." : `${action.missingZoneCount} missing zone${action.missingZoneCount === 1 ? "" : "s"} will remain unchanged and can be filled from the renamed row.`}`
  elements.renameValue.value = action.currentName
  clearFieldError(elements.renameValue, elements.renameError)
  showDialog(elements.renameDialog, {
    initialFocus: elements.renameValue,
  })
  elements.renameValue.select()
}

async function renameRuleAcrossFleet(action, desiredName) {
  try {
    const liveData = await runWritePreflight(
      `fleet rename for ${action.currentName}`,
      () => executePreflightRead([
        {
          rules: action.rules,
          type: READ_ACTION.RULE_RENAME,
        },
      ]),
    )
    const zoneIds = [...new Set(action.rules.map((rule) => rule.zoneId))]
    const liveMetadata = selectedLiveZones(liveData.inventory, zoneIds)
    const rulesByZone = new Map()
    for (const source of action.rules) {
      if (!rulesByZone.has(source.zoneId)) rulesByZone.set(source.zoneId, [])
      rulesByZone.get(source.zoneId).push(source)
    }
    const liveZones = liveMetadata.map((zone) => {
      const rulesetIds = [...new Set(
        rulesByZone.get(zone.meta.id).map((source) => source.rulesetId),
      )]
      const ruleDetails = rulesetIds.map((rulesetId) => {
        const ruleset = liveData.resources.get(
          rulesetResourceId(zone.meta.id, rulesetId),
        )
        if (!ruleset) {
          throw new Error(`Fleet rename could not read ruleset ${rulesetId} on ${zone.meta.name}`)
        }
        return {
          ok: true,
          result: ruleset,
        }
      })
      return {
        ...zone,
        ruleDetails,
      }
    })
    const plans = buildRuleRenamePlans(liveZones, action.rules, desiredName)
    await applyPlans(
      `Rename ${action.currentName} across fleet`,
      createLivePlanSet(plans),
    )
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error")
  }
}

async function reviewRuleRename(event) {
  if (event.submitter?.value === "cancel") return
  event.preventDefault()
  const action = state.ruleRename?.action
  const desiredName = elements.renameValue.value.trim()
  if (!action) {
    showFieldError(
      elements.renameValue,
      elements.renameError,
      "The fleet rename state is unavailable",
    )
    return
  }
  if (desiredName.length === 0) {
    showFieldError(elements.renameValue, elements.renameError, "Enter a rule name")
    return
  }
  if (desiredName === action.currentName) {
    showFieldError(
      elements.renameValue,
      elements.renameError,
      "Enter a different rule name",
    )
    return
  }
  clearFieldError(elements.renameValue, elements.renameError)
  elements.renameDialog.close()
  state.ruleRename = null
  await renameRuleAcrossFleet(action, desiredName)
}

async function fillDnsTargets(label, candidate, targetZoneIds, title) {
  const sourceZoneId = candidate.sourceZoneId
  try {
    const liveData = await runWritePreflight(
      `${label} on ${targetZoneIds.length} target zone${targetZoneIds.length === 1 ? "" : "s"}`,
      () => executePreflightRead(targetZoneIds.map((targetZoneId) => ({
        sourceZoneId,
        targetZoneId,
        type: READ_ACTION.DNS_RECORD_COPY,
      }))),
    )
    const liveInventory = liveData.inventory
    assertSurfaceReads(liveInventory, ["dns"], "DNS record copy")
    const liveZones = selectedLiveZones(
      liveInventory,
      [sourceZoneId, ...targetZoneIds],
    )
    const zonesById = new Map(liveZones.map((zone) => [zone.meta.id, zone]))
    const sourceZone = zonesById.get(sourceZoneId)
    const plans = targetZoneIds.map(
      (targetZoneId) => buildDnsRecordCopyPlan(
        sourceZone,
        zonesById.get(targetZoneId),
        candidate.sourceAction.recordIds,
      ),
    )
    await applyPlans(
      title,
      createLivePlanSet(plans),
    )
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error")
  }
}

async function fillDnsHole(action, candidate) {
  await fillDnsTargets(
    action.label,
    candidate,
    [action.resolution.targetZoneId],
    `Fill ${action.label} on ${action.resolution.targetZoneName}`,
  )
}

async function fillDnsTargetsFromRow(button) {
  if (state.busy || readOnly || !state.transportAvailable) return
  const row = bulkFillRowByButton.get(button)
  if (!row) {
    toast("The DNS facet is no longer available", "error")
    return
  }
  const batch = dnsTargetFillBatch(row, state.inventory, state.selectedZoneIds)
  if (!batch.available) {
    toast(batch.reason, "error")
    return
  }
  await fillDnsTargets(
    row.label,
    batch.candidate,
    batch.targetZoneIds,
    `Fill ${row.label} on selected targets`,
  )
}

async function fillHole(action, candidate = null) {
  if (action.resolution.kind === HOLE_RESOLUTION_KIND.EMAIL_POLICY) {
    await alignEmailZoneIds(
      [action.resolution.targetZoneId],
      `Fill ${action.label} by aligning Email Routing`,
    )
    return
  }
  if (!candidate) {
    toast("Choose a source fleet value first", "error")
    return
  }
  if (action.resolution.kind === HOLE_RESOLUTION_KIND.DNS_RECORDS) {
    await fillDnsHole(action, candidate)
    return
  }
  if (action.resolution.kind === HOLE_RESOLUTION_KIND.RULESET_RULE) {
    await copyRule(
      candidate.sourceAction,
      [action.resolution.targetZoneId],
      `Fill ${action.label} on ${action.resolution.targetZoneName}`,
    )
    return
  }
  toast(`No fill planner is registered for ${action.resolution.kind}`, "error")
}

function selectedHoleCandidate() {
  return state.holeResolution?.action.resolution.candidates.find(
    (candidate) => candidate.id === elements.holeSource.value,
  ) || null
}

function renderHoleCandidate() {
  const candidate = selectedHoleCandidate()
  elements.holePreview.textContent = candidate?.full || "No source value selected"
}

function openHoleResolution(cell) {
  if (state.busy || readOnly || !state.transportAvailable) return
  const action = fillActionByCell.get(cell)
  if (!action?.resolution?.available) {
    toast(action?.resolution?.reason || "This missing value cannot be filled automatically", "error")
    return
  }
  if (action.resolution.kind === HOLE_RESOLUTION_KIND.EMAIL_POLICY) {
    fillHole(action)
    return
  }
  const recommended = action.resolution.candidates.find(
    (candidate) => candidate.id === action.resolution.recommendedCandidateId,
  )
  if (recommended) {
    fillHole(action, recommended)
    return
  }

  state.holeResolution = { action }
  elements.holeTitle.textContent = `Fill ${action.label}`
  elements.holeTarget.textContent = `${action.resolution.targetZoneName} has multiple equally common fleet variants. Choose the value to live-validate and preview.`
  elements.holeSource.replaceChildren(...action.resolution.candidates.map((candidate) => {
    const option = createElement("option", {
      text: `${candidate.sourceZoneName} | ${candidate.count} zone${candidate.count === 1 ? "" : "s"} | ${candidate.display}`,
    })
    option.value = candidate.id
    return option
  }))
  renderHoleCandidate()
  showDialog(elements.holeDialog, {
    initialFocus: elements.holeSource,
  })
}

function reviewHoleResolution(event) {
  if (event.submitter?.value === "cancel") return
  event.preventDefault()
  const action = state.holeResolution?.action
  const candidate = selectedHoleCandidate()
  if (!action || !candidate) {
    toast("The selected fleet value is unavailable", "error")
    return
  }
  elements.holeDialog.close()
  state.holeResolution = null
  fillHole(action, candidate)
}

function cachedRule(zone, rulesetId, ruleId) {
  const ruleset = zone.ruleDetails
    .filter((detail) => detail.ok)
    .map((detail) => detail.result)
    .find((entry) => entry.id === rulesetId)
  const rule = ruleset?.rules?.find((entry) => entry.id === ruleId)
  return rule ? { rule, ruleset } : null
}

function editorRecordLabel(record) {
  const definition = record.content ?? record.data ?? ""
  const detail = typeof definition === "string"
    ? definition
    : JSON.stringify(definition)
  const shortened = detail.length > 90 ? `${detail.slice(0, 87)}...` : detail
  return `${record.type} ${record.name}${shortened ? ` | ${shortened}` : ""}`
}

function renderSelectedEditorEntry() {
  const entry = state.editor?.entries.find(
    (candidate) => candidate.id === elements.editorChoice.value,
  ) || state.editor?.entries[0]
  if (!entry) return
  elements.editorChoice.value = entry.id
  elements.editorValue.value = JSON.stringify(entry.value, null, 2)
  clearFieldError(elements.editorValue, elements.editorError)
}

function openCellEditor(cell) {
  if (state.busy || readOnly || !state.transportAvailable) return
  const action = editActionByCell.get(cell)
  const zone = zoneById(cell.dataset.zoneId)
  if (!action || !zone) {
    toast("The selected resource is no longer available", "error")
    return
  }

  let entries
  let kind
  let title
  let valueLabel
  if (action.type === "zone-setting") {
    const setting = zone.surfaces.settings?.result?.find(
      (entry) => entry.id === action.settingId,
    )
    if (!setting) {
      toast("The selected setting is no longer available", "error")
      return
    }
    entries = [
      {
        id: setting.id,
        label: setting.id,
        value: setting.value,
      },
    ]
    kind = "Zone setting"
    title = action.settingId
    valueLabel = "Desired value"
  } else if (action.type === "dns-records") {
    const records = (zone.surfaces.dns?.result || []).filter(
      (record) => action.recordIds.includes(record.id),
    )
    if (records.length === 0) {
      toast("The selected DNS records are no longer available", "error")
      return
    }
    entries = records.map((record) => ({
      id: record.id,
      label: editorRecordLabel(record),
      value: editableDnsRecordPayload(record),
    }))
    kind = "DNS record"
    title = cell.closest("tr")?.querySelector(".facet-cell span")?.textContent || "Edit DNS record"
    valueLabel = "Desired record definition"
  } else if (action.type === "ruleset-rule") {
    const cached = cachedRule(zone, action.rulesetId, action.ruleId)
    if (!cached) {
      toast("The selected rule is no longer available", "error")
      return
    }
    const rowLabel = cell.closest("tr")?.querySelector(".facet-cell span")?.textContent
    entries = [
      {
        id: cached.rule.id,
        label: rowLabel || cached.rule.description || cached.rule.ref || cached.rule.id,
        value: editableRulePayload(cached.rule),
      },
    ]
    kind = "Ruleset rule"
    title = entries[0].label
    valueLabel = "Desired rule definition"
  } else {
    toast(`Editor support is unavailable for ${action.type}`, "error")
    return
  }

  state.editor = {
    action,
    entries,
    zone,
  }
  elements.editorKind.textContent = kind
  elements.editorTitle.textContent = title
  elements.editorTarget.textContent = `${zone.meta.name} | cached state shown; only the live facts needed for this change will be reread before confirmation`
  elements.editorValueLabel.textContent = valueLabel
  clearFieldError(elements.editorValue, elements.editorError)
  elements.editorChoice.replaceChildren(...entries.map((entry) => {
    const option = createElement("option", { text: entry.label })
    option.value = entry.id
    return option
  }))
  elements.editorChoiceRow.hidden = entries.length <= 1
  renderSelectedEditorEntry()
  showDialog(elements.editorDialog, {
    initialFocus: elements.editorValue,
  })
}

function editorError(error) {
  showFieldError(elements.editorValue, elements.editorError, error)
}

async function planSettingEdit(editor, desiredValue) {
  const settingId = editor.action.settingId
  const readAction = {
    settingId,
    type: READ_ACTION.ZONE_SETTING_EDIT,
    zoneId: editor.zone.meta.id,
  }
  const resourceId = actionResourceId(readAction)
  const liveData = await runWritePreflight(
    `${settingId} on ${editor.zone.meta.name}`,
    () => executePreflightRead([
      readAction,
    ]),
  )
  const liveZone = {
    meta: editor.zone.meta,
    ruleDetails: [],
    surfaces: {
      settings: {
        ok: true,
        result: [liveData.resources.get(resourceId)],
        status: 200,
      },
    },
  }
  return buildZoneSettingPlan(liveZone, settingId, desiredValue)
}

async function planDnsRecordEdit(editor, entry, desiredDefinition) {
  const readAction = {
    recordId: entry.id,
    type: READ_ACTION.DNS_RECORD_EDIT,
    zoneId: editor.zone.meta.id,
  }
  const resourceId = actionResourceId(readAction)
  const liveData = await runWritePreflight(
    `${entry.label} on ${editor.zone.meta.name}`,
    () => executePreflightRead([
      readAction,
    ]),
  )
  return buildDnsRecordEditPlan(
    editor.zone,
    liveData.resources.get(resourceId),
    desiredDefinition,
  )
}

async function planRuleEdit(editor, desiredDefinition) {
  const action = editor.action
  const readAction = {
    ...action,
    type: READ_ACTION.RULE_EDIT,
  }
  const resourceId = actionResourceId(readAction)
  const liveData = await runWritePreflight(
    `${action.phase} rule on ${editor.zone.meta.name}`,
    () => executePreflightRead([
      readAction,
    ]),
  )
  const ruleset = liveData.resources.get(resourceId)
  if (!ruleset) {
    throw new Error(`Rule edit live validation could not read ${action.phase} details`)
  }
  const liveZone = {
    meta: editor.zone.meta,
    ruleDetails: [
      {
        ok: true,
        result: ruleset,
      },
    ],
    surfaces: {},
  }
  return buildRuleEditPlan(liveZone, action, desiredDefinition)
}

async function reviewEditorChange(event) {
  if (event.submitter?.value === "cancel") {
    state.editor = null
    return
  }
  event.preventDefault()
  const editor = state.editor
  const entry = editor?.entries.find(
    (candidate) => candidate.id === elements.editorChoice.value,
  ) || editor?.entries[0]
  if (!editor || !entry) {
    editorError("The editor state is unavailable")
    return
  }

  let desired
  try {
    desired = JSON.parse(elements.editorValue.value)
  } catch (error) {
    editorError(`Invalid JSON: ${error.message}`)
    return
  }

  let plan
  let confirmationTitle
  try {
    if (editor.action.type === "zone-setting") {
      plan = await planSettingEdit(editor, desired)
      confirmationTitle = "Update zone setting"
    } else if (editor.action.type === "dns-records") {
      plan = await planDnsRecordEdit(editor, entry, desired)
      confirmationTitle = "Update DNS record"
    } else if (editor.action.type === "ruleset-rule") {
      plan = await planRuleEdit(editor, desired)
      confirmationTitle = "Update ruleset rule"
    } else {
      throw new Error(`Editor support is unavailable for ${editor.action.type}`)
    }
  } catch (error) {
    editorError(error)
    return
  }

  if (state.editor !== editor || !elements.editorDialog.open) return
  clearFieldError(elements.editorValue, elements.editorError)
  elements.editorDialog.close()
  state.editor = null
  await applyPlans(confirmationTitle, createLivePlanSet([plan]))
}

function renderInventory(inventory, source) {
  const nextMatrix = buildMatrix(inventory)
  const nextMatrixRenderKey = matrixRenderKey(inventory, nextMatrix)
  const matrixChanged = nextMatrixRenderKey !== state.matrixRenderKey
  state.inventory = inventory
  state.inventorySource = source
  state.matrix = nextMatrix
  state.matrixRenderKey = nextMatrixRenderKey

  const liveZoneIds = new Set(inventory.zones.map((zone) => zone.meta.id))
  state.selectedZoneIds = new Set([...state.selectedZoneIds].filter((zoneId) => liveZoneIds.has(zoneId)))

  renderSummary()
  renderPolicyCards()
  if (matrixChanged) {
    renderMatrixFilters()
    renderMatrix()
  }
  renderCoverage()
  updateSelectionStyles()
  return matrixChanged
}

function serializeLiveSnapshot(inventory) {
  return JSON.stringify(createCacheRecord(auth.accountId, inventory))
}

async function refreshInventory(options = {}) {
  if (state.abortController) state.abortController.abort()
  const controller = new AbortController()
  state.abortController = controller
  if (!options.preserveSelection) state.selectedZoneIds.clear()

  setBusy(true)
  setRefreshDetail()
  setWriteReadiness("Running a complete live fleet audit")
  setStatus(state.inventory ? "Refreshing full fleet" : "Loading fleet")
  elements.loadProgress.hidden = false
  elements.loadProgress.value = 2

  try {
    const inventory = await loadInventory(api, {
      signal: controller.signal,
      onProgress: ({ completed, total, message }) => {
        const percent = total === 0 ? 100 : Math.max(2, Math.round((completed / total) * 100))
        elements.loadProgress.value = percent
        setStatus(message)
      },
    })
    const serializedSnapshot = serializeLiveSnapshot(inventory)
    const matrixChanged = renderInventory(inventory, INVENTORY_SOURCE.LIVE)
    window[CACHE_SNAPSHOT_GLOBAL] = serializedSnapshot
    try {
      await api.persistSnapshot(serializedSnapshot, {
        signal: controller.signal,
      })
    } catch (error) {
      toast(`Fleet loaded, but its snapshot was not saved: ${error instanceof Error ? error.message : String(error)}`, "error")
    }
    elements.loadProgress.value = 100
    restoreInventoryStatus()
    if (!matrixChanged && state.startupCacheLoadedAt) {
      setRefreshDetail("Opened from cache; full live audit found no matrix changes", "complete")
    }
  } catch (error) {
    if (controller.signal.aborted) return
    const message = state.inventory
      ? `${state.inventorySource === INVENTORY_SOURCE.CACHE ? "Cached" : "Previous"} snapshot shown; full refresh failed`
      : "Load failed"
    setStatus(message, "error")
    setRefreshDetail(
      state.inventory
        ? "The existing snapshot remains available; writes still validate live on use"
        : "",
      "error",
    )
    setWriteReadiness(
      state.inventory
        ? "Snapshot available; every change still requires live validation"
        : "No fleet inventory is available",
      state.inventory ? "cached" : "",
    )
    toast(error instanceof Error ? error.message : String(error), "error")
  } finally {
    if (state.abortController === controller) {
      state.abortController = null
      setBusy(false)
      setTimeout(() => {
        elements.loadProgress.hidden = true
        elements.loadProgress.value = 0
      }, 350)
    }
  }
}

async function initialize() {
  if (cachedRecord) {
    state.startupCacheLoadedAt = cachedRecord.loadedAt
    renderInventory(cachedRecord.inventory, INVENTORY_SOURCE.CACHE)
    restoreInventoryStatus()
    return
  }
  await refreshInventory()
}

api.startSessionMonitor({
  onConnected: () => {
    state.transportAvailable = true
    restoreInventoryStatus()
    updateActionButtons()
  },
  onDisconnected: () => {
    state.transportAvailable = false
    setStatus("Session broker offline", "error")
    setRefreshDetail("The loaded matrix remains available; relaunch to restore live reads and writes", "error")
    setWriteReadiness("Session broker offline; the loaded dashboard is read-only")
    updateActionButtons()
  },
})

installDismissibleDialogs(document)
elements.refresh.addEventListener("click", () => refreshInventory({ preserveSelection: true }))
elements.search.addEventListener("input", filterRows)
elements.category.addEventListener("change", () => {
  syncDnsTypeAvailability()
  filterRows()
})
elements.scope.addEventListener("change", filterRows)
elements.dnsType.addEventListener("change", filterRows)
elements.targetHoles.addEventListener("click", () => {
  const next = elements.targetHoles.getAttribute("aria-pressed") !== "true"
  elements.targetHoles.setAttribute("aria-pressed", String(next))
  elements.targetHoles.textContent = next ? "Target holes only" : "Target holes"
  filterRows()
})
elements.differenceToggle.addEventListener("click", () => {
  const next = elements.differenceToggle.getAttribute("aria-pressed") !== "true"
  elements.differenceToggle.setAttribute("aria-pressed", String(next))
  elements.differenceToggle.textContent = next ? "Differences only" : "All rows"
  filterRows()
})
elements.matrixHead.addEventListener("change", (event) => {
  const checkbox = event.target.closest("input[data-zone-id]")
  if (!checkbox) return
  if (checkbox.checked) state.selectedZoneIds.add(checkbox.dataset.zoneId)
  else state.selectedZoneIds.delete(checkbox.dataset.zoneId)
  updateSelectionStyles()
})
elements.matrixBody.addEventListener("click", (event) => {
  const bulkFillButton = event.target.closest(".bulk-fill")
  if (bulkFillButton) {
    fillDnsTargetsFromRow(bulkFillButton)
    return
  }
  const renameButton = event.target.closest(".rename-rule")
  if (renameButton) {
    openRuleRename(renameButton)
    return
  }
  const fillButton = event.target.closest(".fill-hole")
  if (fillButton) {
    openHoleResolution(fillButton.closest(".fillable-hole"))
    return
  }
  const editButton = event.target.closest(".edit-cell")
  if (editButton) {
    openCellEditor(editButton.closest(".editable-cell"))
    return
  }
  const copyButton = event.target.closest(".copy-rule")
  if (copyButton) {
    copyRuleToSelected(copyButton)
    return
  }
  if (event.target.closest("summary, pre, button, input, select, textarea, a")) return
  const fillableHole = event.target.closest(".fillable-hole")
  if (fillableHole) {
    openHoleResolution(fillableHole)
    return
  }
  const editableCell = event.target.closest(".editable-cell")
  if (editableCell) openCellEditor(editableCell)
})
elements.matrixBody.addEventListener("focusin", (event) => {
  const action = event.target.closest(MATRIX_CONTROL_SELECTOR)
  if (action) syncMatrixActionTabStop(action)
})
elements.matrixBody.addEventListener("keydown", handleMatrixActionKeydown)
elements.clearSelection.addEventListener("click", () => {
  selectZoneIds([])
})
elements.selectDrifted.addEventListener("click", () => {
  selectZoneIds(policyDriftZoneIds())
})
elements.chooseTargets.addEventListener("click", showTargetDialog)
elements.showEditableSettings.addEventListener("click", showEditableSettings)
elements.targetOptions.addEventListener("change", (event) => {
  const checkbox = event.target.closest("input[data-zone-id]")
  if (!checkbox) return
  if (checkbox.checked) state.selectedZoneIds.add(checkbox.dataset.zoneId)
  else state.selectedZoneIds.delete(checkbox.dataset.zoneId)
  syncSelectionControls()
})
elements.targetSelectAll.addEventListener("click", () => {
  selectZoneIds(state.inventory.zones.map((zone) => zone.meta.id))
})
elements.targetSelectDrifted.addEventListener("click", () => {
  selectZoneIds(policyDriftZoneIds())
})
elements.targetClear.addEventListener("click", () => {
  selectZoneIds([])
})
elements.alignEmail.addEventListener("click", alignEmail)
elements.alignWaf.addEventListener("click", alignWaf)
elements.confirmCheck.addEventListener("change", () => {
  elements.confirmApply.disabled = !elements.confirmCheck.checked
})
elements.toastDismiss.addEventListener("click", hideToast)
elements.toast.addEventListener("mouseenter", pauseToastTimer)
elements.toast.addEventListener("mouseleave", resumeToastTimer)
elements.toast.addEventListener("focusin", pauseToastTimer)
elements.toast.addEventListener("focusout", resumeToastTimer)
elements.editorChoice.addEventListener("change", renderSelectedEditorEntry)
elements.editorValue.addEventListener("input", () => {
  clearFieldError(elements.editorValue, elements.editorError)
})
elements.editorDialog.addEventListener("close", () => {
  state.editor = null
})
elements.editorForm.addEventListener("submit", reviewEditorChange)
elements.holeSource.addEventListener("change", renderHoleCandidate)
elements.holeDialog.addEventListener("close", () => {
  state.holeResolution = null
})
elements.holeForm.addEventListener("submit", reviewHoleResolution)
elements.renameDialog.addEventListener("close", () => {
  state.ruleRename = null
})
elements.renameValue.addEventListener("input", () => {
  clearFieldError(elements.renameValue, elements.renameError)
})
elements.renameForm.addEventListener("submit", reviewRuleRename)
document.addEventListener("click", followSkipLink)
document.addEventListener("keydown", handleGlobalShortcut)

initialize()
