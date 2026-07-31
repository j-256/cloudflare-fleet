import { CloudflareApi } from "./api.mjs"
import {
  CACHE_RECORD_GLOBAL,
  CACHE_SNAPSHOT_GLOBAL,
  createCacheRecord,
  isCacheRecord,
} from "./cache.mjs"
import {
  EMAIL_POLICY_COMPONENT,
  FLEET_ACTION_KIND,
  HOLE_RESOLUTION_KIND,
  POLICY_EXCEPTION_STATUS,
  RULESET_ACTION_KIND,
  RULESET_KIND,
  SESSION_TITLE,
  STATIC_LIMITATIONS,
} from "./constants.mjs"
import {
  configuredEmailPolicyExceptions,
  emailPolicyExceptionsForZone,
} from "./fleet-policy.mjs"
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
  buildRuleCreatePlan,
  buildRuleCopyPlans,
  buildRuleDeletePlan,
  buildRuleEditPlan,
  buildRuleRenamePlans,
  buildRuleReorderPlan,
  buildRulesetDeletePlan,
  buildRulesetDescriptionPlan,
  buildWafAlignmentPlan,
  buildZoneSettingPlan,
  deriveEmailDestination,
  deriveEmailDnsPolicy,
  deriveFleetWafPolicies,
  editableDnsRecordPayload,
  editableRulePayload,
  emailIssues,
  evaluateFleetEmailPolicyExceptions,
  executePlans,
  wafIssues,
} from "./policies.mjs"
import {
  presentRule,
  ruleActionLabel,
  rulePhaseLabel,
} from "./rule-presentation.mjs"
import {
  actionResourceId,
  executeActionReadPlan,
  READ_ACTION,
  READ_ACTION_SURFACES,
  rulesetPhaseResourceId,
  rulesetResourceId,
} from "./read-composer.mjs"
import {
  duplicateRuleDefinition,
  findManagedDeployment,
  newRuleDefinition,
  normalizeRulesetDetail,
  RULESET_RULE_PAGE_SIZE,
  rulesetIsEditable,
  rulesetRuleLabel,
  rulesetRulePage,
  rulesetSummary,
} from "./ruleset-workspace.mjs"
import {
  appendArrayItemAtPath,
  defaultValueForKind,
  humanizeValueField,
  JSON_VALUE_KIND,
  jsonValueKind,
  orderedValueEntries,
  parseScalarControl,
  removeArrayItemAtPath,
  renameObjectKeyAtPath,
  replaceValueAtPath,
  valueAtPath,
  valueControlDescriptor,
} from "./value-editor.mjs"

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
const COMPACT_RULE_TEXT_LIMIT = 120
const EDITABLE_OBJECT_KEY_FIELDS = new Set([
  "headers",
])
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const RULESET_RULE_PREVIEW_LIMIT = 220
const TOAST_SUCCESS_TIMEOUT_MS = 7000
const DNS_MATRIX_CATEGORY_SET = new Set(DNS_MATRIX_CATEGORIES)
const POLICY_EXCEPTION_COMPONENT_LABELS = Object.freeze({
  [EMAIL_POLICY_COMPONENT.SPF]: "SPF",
})
const POLICY_EXCEPTION_STATUS_LABELS = Object.freeze({
  [POLICY_EXCEPTION_STATUS.ACTIVE]: "Active",
  [POLICY_EXCEPTION_STATUS.ALIGNED]: "Dormant",
  [POLICY_EXCEPTION_STATUS.UNAVAILABLE]: "Unavailable",
  [POLICY_EXCEPTION_STATUS.VIOLATED]: "Needs review",
})
document.title = readOnly ? SESSION_TITLE.READ_ONLY : SESSION_TITLE.READ_WRITE
const state = {
  abortController: null,
  busy: false,
  busyFocus: null,
  editor: null,
  emailDestination: null,
  emailDnsPolicy: null,
  emailPolicyExceptionStatuses: [],
  inventory: null,
  inventorySource: null,
  matrix: null,
  matrixRenderKey: null,
  holeResolution: null,
  inlineEditor: null,
  ruleRename: null,
  rulesetWorkspace: null,
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
const workspaceActionByButton = new WeakMap()

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
  emailPolicyExceptions: document.querySelector("#email-policy-exceptions"),
  editorChoice: document.querySelector("#editor-choice"),
  editorChoiceRow: document.querySelector("#editor-choice-row"),
  editorDialog: document.querySelector("#editor-dialog"),
  editorError: document.querySelector("#editor-error"),
  editorForm: document.querySelector("#editor-form"),
  editorKind: document.querySelector("#editor-kind"),
  editorJson: document.querySelector("#editor-json"),
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
  holePreviewSummary: document.querySelector("#hole-preview-summary"),
  holeRawPreview: document.querySelector("#hole-raw-preview"),
  holeSource: document.querySelector("#hole-source"),
  holeStructuredPreview: document.querySelector("#hole-structured-preview"),
  holeTarget: document.querySelector("#hole-target"),
  holeTitle: document.querySelector("#hole-title"),
  loadProgress: document.querySelector("#load-progress"),
  matrixBody: document.querySelector("#matrix-body"),
  matrixHead: document.querySelector("#matrix-head"),
  policyExceptionDialog: document.querySelector("#policy-exception-dialog"),
  policyExceptionList: document.querySelector("#policy-exception-list"),
  policyExceptionRaw: document.querySelector("#policy-exception-raw"),
  policyExceptionSummary: document.querySelector("#policy-exception-summary"),
  refresh: document.querySelector("#refresh"),
  refreshDetail: document.querySelector("#refresh-detail"),
  renameCurrent: document.querySelector("#rename-current"),
  renameDialog: document.querySelector("#rename-dialog"),
  renameError: document.querySelector("#rename-error"),
  renameForm: document.querySelector("#rename-form"),
  renameReview: document.querySelector("#rename-review"),
  renameTarget: document.querySelector("#rename-target"),
  renameValue: document.querySelector("#rename-value"),
  rulesetAddRule: document.querySelector("#ruleset-add-rule"),
  rulesetBadges: document.querySelector("#ruleset-badges"),
  rulesetConfigureDeployment: document.querySelector("#ruleset-configure-deployment"),
  rulesetDelete: document.querySelector("#ruleset-delete"),
  rulesetDeployment: document.querySelector("#ruleset-deployment"),
  rulesetDeploymentSummary: document.querySelector("#ruleset-deployment-summary"),
  rulesetDescription: document.querySelector("#ruleset-description"),
  rulesetDescriptionDialog: document.querySelector("#ruleset-description-dialog"),
  rulesetDescriptionError: document.querySelector("#ruleset-description-error"),
  rulesetDescriptionForm: document.querySelector("#ruleset-description-form"),
  rulesetDescriptionReview: document.querySelector("#ruleset-description-review"),
  rulesetDescriptionValue: document.querySelector("#ruleset-description-value"),
  rulesetDialog: document.querySelector("#ruleset-dialog"),
  rulesetEditDescription: document.querySelector("#ruleset-edit-description"),
  rulesetLoadMore: document.querySelector("#ruleset-load-more"),
  rulesetRefresh: document.querySelector("#ruleset-refresh"),
  rulesetRuleList: document.querySelector("#ruleset-rule-list"),
  rulesetSearch: document.querySelector("#ruleset-search"),
  rulesetStatus: document.querySelector("#ruleset-status"),
  rulesetStatusFilter: document.querySelector("#ruleset-status-filter"),
  rulesetTarget: document.querySelector("#ruleset-target"),
  rulesetTitle: document.querySelector("#ruleset-title"),
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
  valueEditor: document.querySelector("#value-editor"),
  valueEditorContext: document.querySelector("#value-editor-context"),
  valueEditorFields: document.querySelector("#value-editor-fields"),
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
elements.alignEmail.hidden = readOnly
elements.alignWaf.hidden = readOnly

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

function updateTransportDependentControls() {
  elements.refresh.disabled = state.busy || !state.transportAvailable
  updateActionButtons()
  updateRulesetActionAvailability()
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
  elements.editorReview.disabled = busy
  elements.renameReview.disabled = busy
  elements.rulesetDescriptionReview.disabled = busy
  updateTransportDependentControls()
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

function structuredValueElement(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return createElement("span", { text: "None" })
    const list = createElement("ul", { className: "structured-list" })
    for (const entry of value) {
      const item = document.createElement("li")
      item.append(structuredValueElement(entry))
      list.append(item)
    }
    return list
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
    if (entries.length === 0) return createElement("span", { text: "None" })
    const fields = createElement("dl", { className: "structured-object" })
    for (const [key, entry] of entries) {
      fields.append(
        createElement("dt", { text: humanizeValueField(key) }),
        createElement("dd"),
      )
      fields.lastElementChild.append(structuredValueElement(entry))
    }
    return fields
  }
  if (typeof value === "boolean") {
    return createElement("span", { text: value ? "Yes" : "No" })
  }
  if (value === null || value === undefined || value === "") {
    return createElement("span", { text: "None" })
  }
  return createElement("code", { text: String(value) })
}

function formattedJson(value) {
  const serialized = JSON.stringify(value, null, 2)
  return serialized === undefined ? String(value) : serialized
}

function createRawValueDetails(value, label = "Raw value JSON") {
  const raw = document.createElement("details")
  raw.className = "raw-value"
  raw.append(
    createElement("summary", { text: label }),
    createElement("pre", { text: formattedJson(value) }),
  )
  return raw
}

function createGenericValueInspection(value) {
  const inspection = createElement("div", { className: "cell-value-inspection" })
  inspection.append(
    structuredValueElement(value),
    createRawValueDetails(value),
  )
  return inspection
}

function createRuleSummary(rule, phase = "", options = {}) {
  const omittedFields = new Set(options.omitFields || [])
  const presentation = presentRule(rule, phase)
  const root = createElement("div", {
    className: `rule-summary${options.compact ? " compact" : ""}`,
  })
  const visibleFields = presentation.fields.filter(
    (field) => !omittedFields.has(field.key),
  )
  if (visibleFields.length > 0) {
    const facts = createElement("dl", { className: "rule-facts" })
    for (const field of visibleFields) {
      const rawValue = String(field.value)
      const fieldValue = options.compact && rawValue.length > COMPACT_RULE_TEXT_LIMIT
        ? `${rawValue.slice(0, COMPACT_RULE_TEXT_LIMIT - 3)}...`
        : rawValue
      const value = createElement("dd", {
        className: `rule-field-${field.key}`,
      })
      value.append(
        createElement(field.kind === "code" ? "code" : "span", {
          text: fieldValue,
        }),
      )
      if (field.token && field.token !== field.value) {
        value.append(
          createElement("code", {
            className: "rule-token",
            text: field.token,
          }),
        )
      }
      facts.append(
        createElement("dt", {
          className: `rule-field-${field.key}`,
          text: field.label,
        }),
        value,
      )
    }
    root.append(facts)
  }
  for (const section of presentation.sections) {
    const container = createElement("section", { className: "rule-section" })
    container.append(
      createElement("h4", { text: section.label }),
      structuredValueElement(section.value),
    )
    root.append(container)
  }
  return root
}

function cachedRulesetForAction(action) {
  const zone = zoneById(action.zoneId)
  if (!zone) return null
  const detail = zone.ruleDetails
    .filter((entry) => entry.ok)
    .map((entry) => entry.result)
    .find((ruleset) => ruleset.id === action.rulesetId)
  if (detail) return normalizeRulesetDetail(detail)
  return (zone.surfaces.rulesets?.result || [])
    .map(normalizeRulesetDetail)
    .find((ruleset) => ruleset.id === action.rulesetId) || null
}

function rulesetWorkspaceTitle(ruleset) {
  if (ruleset?.kind === RULESET_KIND.ZONE) {
    return `${rulePhaseLabel(ruleset.phase)} entrypoint`
  }
  return ruleset?.name || `${rulePhaseLabel(ruleset?.phase)} ruleset`
}

function rulesetBadge(text, className = "") {
  return createElement("span", {
    className: `ruleset-badge${className ? ` ${className}` : ""}`,
    text,
  })
}

function workspaceWriteLocked() {
  return readOnly
    || state.busy
    || !state.transportAvailable
    || Boolean(state.rulesetWorkspace?.loading)
}

function updateRulesetActionAvailability() {
  const workspace = state.rulesetWorkspace
  if (!workspace) return
  const locked = workspaceWriteLocked()
  const lockReason = !state.transportAvailable
    ? "Session broker offline; relaunch to restore live writes"
    : workspace.loading
      ? "Ruleset details are refreshing"
      : state.busy
        ? "Another fleet operation is in progress"
        : ""
  elements.rulesetRefresh.disabled = state.busy
    || workspace.loading
    || !state.transportAvailable
  for (const button of elements.rulesetDialog.querySelectorAll("[data-ruleset-write]")) {
    const available = button.dataset.rulesetAvailable !== "false"
    button.disabled = locked || !available
    button.title = locked && !readOnly
      ? lockReason
      : button.dataset.actionTitle || button.title
  }
}

function workspaceZoneRulesets(zone) {
  return zone?.ruleDetails
    .filter((detail) => detail.ok)
    .map((detail) => detail.result) || []
}

function workspaceManagedDeployment(workspace) {
  if (workspace.ruleset?.kind !== RULESET_KIND.MANAGED) return null
  return findManagedDeployment(
    workspace.ruleset,
    workspaceZoneRulesets(zoneById(workspace.action.zoneId)),
  )
}

function renderRulesetDeployment(workspace) {
  const managed = workspace.ruleset?.kind === RULESET_KIND.MANAGED
  elements.rulesetDeployment.hidden = !managed
  elements.rulesetConfigureDeployment.hidden = true
  if (!managed) return

  const deployment = workspaceManagedDeployment(workspace)
  workspace.deployment = deployment
  if (!deployment) {
    elements.rulesetDeploymentSummary.textContent = "No editable zone deployment rule was found. Cloudflare may attach this managed ruleset automatically."
    return
  }

  const deploymentLabel = rulesetRuleLabel(deployment.rule, deployment.index)
  elements.rulesetDeploymentSummary.textContent = `${deploymentLabel} in ${rulesetWorkspaceTitle(deployment.ruleset)} controls this managed ruleset's deployment and overrides.`
  elements.rulesetConfigureDeployment.hidden = false
  elements.rulesetConfigureDeployment.textContent = readOnly
    ? "Open deployment"
    : "Configure deployment"
  if (!readOnly) {
    elements.rulesetConfigureDeployment.dataset.rulesetWrite = ""
    elements.rulesetConfigureDeployment.dataset.actionTitle = "Edit the deployment rule and its managed overrides"
  } else {
    delete elements.rulesetConfigureDeployment.dataset.rulesetWrite
  }
}

function workspaceHasFlattenedRule(workspace, ruleId) {
  return workspaceZoneRulesets(zoneById(workspace.action.zoneId))
    .some((ruleset) => ruleset.id === workspace.ruleset.id
      && ruleset.rules?.some((rule) => rule.id === ruleId))
}

function workspaceButton(label, className, handler, options = {}) {
  const button = createElement("button", {
    className,
    text: label,
  })
  button.type = "button"
  if (options.write) {
    button.dataset.rulesetWrite = ""
    button.dataset.rulesetAvailable = String(options.available !== false)
  }
  if (options.title) {
    button.title = options.title
    button.dataset.actionTitle = options.title
  }
  if (options.ariaLabel) button.setAttribute("aria-label", options.ariaLabel)
  button.addEventListener("click", handler)
  return button
}

function ruleActionParameterPreview(workspace, rule) {
  const parameters = rule.action_parameters
  if (!parameters || typeof parameters !== "object") return ""
  if (rule.action === "execute" && parameters.id) {
    const zone = zoneById(workspace.action.zoneId)
    const target = (zone?.surfaces.rulesets?.result || [])
      .find((ruleset) => ruleset.id === parameters.id)
    const overrideCount = parameters.overrides?.rules?.length || 0
    return [
      target?.name || `Ruleset ${String(parameters.id).slice(0, 8)}`,
      overrideCount > 0
        ? `${overrideCount} rule override${overrideCount === 1 ? "" : "s"}`
        : "",
    ].filter(Boolean).join(" | ")
  }
  if (rule.action === "redirect") {
    const definition = parameters.from_value || parameters.from_list
    const target = definition?.target_url?.expression
      || definition?.target_url?.value
      || definition?.key
    const status = definition?.status_code
    return [
      status ? `HTTP ${status}` : "",
      target ? `to ${target}` : "",
    ].filter(Boolean).join(" ")
  }
  if (rule.action === "skip") {
    const products = parameters.products || []
    const phases = parameters.phases || []
    return [...products, ...phases].join(", ")
  }
  return Object.keys(parameters).map(humanizeValueField).join(", ")
}

function ruleCardPreview(workspace, rule) {
  const preview = createElement("div", { className: "rule-card-preview" })
  const entries = [
    ["Expression", rule.expression],
    ["Parameters", ruleActionParameterPreview(workspace, rule)],
  ]
  for (const [label, rawValue] of entries) {
    if (rawValue === undefined || rawValue === "") continue
    const value = String(rawValue)
    const shortened = value.length > RULESET_RULE_PREVIEW_LIMIT
      ? `${value.slice(0, RULESET_RULE_PREVIEW_LIMIT - 3)}...`
      : value
    const code = createElement("code", { text: shortened })
    code.title = value
    preview.append(
      createElement("span", { text: label }),
      code,
    )
  }
  return preview
}

function createRulesetRuleCard(workspace, rule) {
  const rules = workspace.ruleset.rules
  const index = rules.indexOf(rule)
  const label = rulesetRuleLabel(rule, index)
  const enabled = rule.enabled !== false
  const item = createElement("li", {
    className: `ruleset-rule-card ${enabled ? "enabled" : "disabled"}`,
  })
  item.dataset.ruleId = rule.id || ""

  const heading = createElement("div", { className: "rule-card-heading" })
  const title = createElement("div", { className: "rule-card-title" })
  title.append(
    createElement("span", {
      className: "rule-card-position",
      text: String(index + 1),
    }),
    createElement("h3", { text: label }),
  )
  const badges = createElement("div", {
    className: "rule-card-badges",
  })
  badges.append(
    createElement("span", {
      className: `rule-card-badge ${enabled ? "enabled" : "disabled"}`,
      text: enabled ? "Enabled" : "Disabled",
    }),
    createElement("span", {
      className: "rule-card-badge",
      text: ruleActionLabel(rule.action),
    }),
  )
  heading.append(title, badges)
  item.append(heading, ruleCardPreview(workspace, rule))
  const inspection = document.createElement("details")
  inspection.className = "rule-card-inspection"
  inspection.append(
    createElement("summary", { text: "View rule details" }),
    createRuleSummary(editableRulePayload(rule), workspace.ruleset.phase, {
      omitFields: ["description", "enabled", "phase"],
    }),
    createRawValueDetails(rule, "Raw rule JSON"),
  )
  item.append(inspection)

  const editable = rulesetIsEditable(workspace.ruleset) && !readOnly
  const comparable = workspaceHasFlattenedRule(workspace, rule.id)
  if (!editable && !comparable) return item

  const actions = createElement("div", { className: "rule-card-actions" })
  if (editable) {
    actions.append(
      workspaceButton(
        "Edit",
        "button button-primary",
        () => openWorkspaceRuleEditor(rule),
        {
          ariaLabel: `Edit ${label}`,
          title: "Edit this rule after an exact live reread",
          write: true,
        },
      ),
      workspaceButton(
        enabled ? "Disable" : "Enable",
        "button button-quiet",
        () => toggleWorkspaceRule(rule.id),
        {
          ariaLabel: `${enabled ? "Disable" : "Enable"} ${label}`,
          title: `${enabled ? "Disable" : "Enable"} this rule after an exact live reread`,
          write: true,
        },
      ),
    )
  }

  if (comparable && !editable) {
    actions.append(
      workspaceButton(
        "Show in matrix",
        "button button-quiet",
        () => showWorkspaceRuleInMatrix(rule.id),
        {
          ariaLabel: `Show ${label} in the fleet matrix`,
          title: "Close this workspace and reveal the flattened fleet comparison",
        },
      ),
    )
  }
  if (editable) {
    const more = document.createElement("details")
    more.className = "rule-card-more"
    more.append(createElement("summary", { text: "More" }))
    const moreActions = createElement("div", { className: "rule-card-more-actions" })
    if (comparable) {
      moreActions.append(
        workspaceButton(
          "Show in matrix",
          "button button-quiet",
          () => showWorkspaceRuleInMatrix(rule.id),
          {
            ariaLabel: `Show ${label} in the fleet matrix`,
            title: "Close this workspace and reveal the flattened fleet comparison",
          },
        ),
      )
    }
    moreActions.append(
      workspaceButton(
        "Duplicate",
        "button button-quiet",
        () => openWorkspaceRuleCreateEditor(duplicateRuleDefinition(rule, index), `Duplicate ${label}`),
        {
          ariaLabel: `Duplicate ${label}`,
          title: "Create a disabled copy after review",
          write: true,
        },
      ),
      workspaceButton(
        "Move up",
        "button button-quiet",
        () => reorderWorkspaceRule(rule.id, -1),
        {
          ariaLabel: `Move ${label} up`,
          available: index > 0,
          title: index > 0 ? "Move this rule one position earlier" : "This rule is already first",
          write: true,
        },
      ),
      workspaceButton(
        "Move down",
        "button button-quiet",
        () => reorderWorkspaceRule(rule.id, 1),
        {
          ariaLabel: `Move ${label} down`,
          available: index < rules.length - 1,
          title: index < rules.length - 1 ? "Move this rule one position later" : "This rule is already last",
          write: true,
        },
      ),
      workspaceButton(
        "Delete",
        "button button-danger",
        () => deleteWorkspaceRule(rule.id),
        {
          ariaLabel: `Delete ${label}`,
          title: "Delete this rule after reviewing its live definition",
          write: true,
        },
      ),
    )
    more.append(moreActions)
    actions.append(more)
  }
  item.append(actions)
  return item
}

function renderRulesetRuleList(workspace) {
  const rules = workspace.ruleset?.rules
  elements.rulesetRuleList.replaceChildren()
  elements.rulesetLoadMore.hidden = true
  if (!Array.isArray(rules)) {
    elements.rulesetRuleList.append(
      createElement("li", {
        className: "ruleset-empty",
        text: workspace.loading
          ? "Loading the live rule catalog"
          : "Rule details are unavailable in the loaded snapshot",
      }),
    )
    return
  }

  const page = rulesetRulePage(rules, {
    limit: workspace.limit,
    query: workspace.query,
    status: workspace.status,
  })
  if (page.visible.length === 0) {
    elements.rulesetRuleList.append(
      createElement("li", {
        className: "ruleset-empty",
        text: rules.length === 0
          ? "This ruleset contains no rules"
          : "No rules match these filters",
      }),
    )
  } else {
    elements.rulesetRuleList.append(
      ...page.visible.map((rule) => createRulesetRuleCard(workspace, rule)),
    )
  }
  elements.rulesetLoadMore.hidden = !page.hasMore
  elements.rulesetLoadMore.textContent = `Load more (${page.filteredCount - page.visible.length} remaining)`
}

function renderRulesetWorkspace() {
  const workspace = state.rulesetWorkspace
  if (!workspace) return
  const ruleset = workspace.ruleset
  const summary = rulesetSummary(ruleset)
  const ruleCount = Array.isArray(ruleset?.rules) ? ruleset.rules.length : null
  const editable = rulesetIsEditable(ruleset) && !readOnly

  elements.rulesetTitle.textContent = rulesetWorkspaceTitle(ruleset)
  elements.rulesetSearch.setAttribute(
    "aria-label",
    `Search rules in ${rulesetWorkspaceTitle(ruleset)}`,
  )
  elements.rulesetTarget.textContent = `${workspace.zoneName} | ${ruleset?.name || "unnamed"}`
  elements.rulesetBadges.replaceChildren(
    rulesetBadge(summary.kind),
    rulesetBadge(summary.phase),
    ...(summary.version ? [rulesetBadge(`Version ${summary.version}`)] : []),
    ...(ruleCount === null
      ? []
      : [rulesetBadge(`${ruleCount} rule${ruleCount === 1 ? "" : "s"}`)]),
  )
  elements.rulesetDescription.textContent = summary.description || "No description"
  elements.rulesetEditDescription.hidden = !editable
  elements.rulesetEditDescription.dataset.rulesetWrite = ""
  elements.rulesetEditDescription.dataset.actionTitle = "Edit this ruleset's description while preserving its ordered rules"

  renderRulesetDeployment(workspace)
  renderRulesetRuleList(workspace)

  const filtered = Array.isArray(ruleset?.rules)
    ? rulesetRulePage(ruleset.rules, {
        limit: workspace.limit,
        query: workspace.query,
        status: workspace.status,
      })
    : null
  if (workspace.loading) {
    elements.rulesetStatus.textContent = filtered
      ? `Showing cached details while refreshing live version ${summary.version || "unknown"}`
      : "Reading live ruleset details"
  } else if (workspace.error) {
    elements.rulesetStatus.textContent = `${workspace.error} Cached details remain available.`
  } else if (filtered) {
    elements.rulesetStatus.textContent = `${filtered.filteredCount} matching of ${filtered.totalCount} total | live version ${summary.version || "unknown"}`
  } else {
    elements.rulesetStatus.textContent = "Ruleset summary loaded; rule details are unavailable"
  }

  const template = newRuleDefinition(ruleset)
  elements.rulesetAddRule.hidden = !editable
  elements.rulesetAddRule.dataset.rulesetWrite = ""
  elements.rulesetAddRule.dataset.rulesetAvailable = String(Boolean(template))
  elements.rulesetAddRule.dataset.actionTitle = template
    ? "Create a disabled rule using this phase's live schema"
    : "No safe starter schema is available for an empty ruleset in this phase"
  elements.rulesetDelete.hidden = !editable || ruleCount !== 0
  elements.rulesetDelete.dataset.rulesetWrite = ""
  elements.rulesetDelete.dataset.actionTitle = "Delete this empty ruleset and all of its versions"
  updateRulesetActionAvailability()
}

async function refreshRulesetWorkspace() {
  const workspace = state.rulesetWorkspace
  if (!workspace || workspace.loading || !state.transportAvailable) return
  workspace.loading = true
  workspace.error = ""
  renderRulesetWorkspace()
  const readAction = {
    rulesetId: workspace.action.rulesetId,
    type: READ_ACTION.RULESET_INSPECT,
    zoneId: workspace.action.zoneId,
  }
  try {
    const resourceId = actionResourceId(readAction)
    const liveData = await executeActionReadPlan(api, [readAction])
    if (state.rulesetWorkspace !== workspace) return
    const liveRuleset = liveData.resources.get(resourceId)
    if (!liveRuleset) throw new Error("Cloudflare returned no ruleset detail")
    workspace.ruleset = normalizeRulesetDetail(liveRuleset)
    workspace.action = {
      ...workspace.action,
      kind: workspace.ruleset.kind,
      name: workspace.ruleset.name,
      phase: workspace.ruleset.phase,
    }
  } catch (error) {
    if (state.rulesetWorkspace !== workspace) return
    workspace.error = error instanceof Error ? error.message : String(error)
  } finally {
    if (state.rulesetWorkspace === workspace) {
      workspace.loading = false
      renderRulesetWorkspace()
    }
  }
}

function rulesetSurfaceSummary(ruleset) {
  const summary = {
    ...ruleset,
  }
  delete summary.rules
  return summary
}

function patchVerifiedRuleset(action, ruleset, options = {}) {
  const inventory = state.inventory
  if (!inventory) throw new Error("The fleet snapshot is unavailable")
  const zones = inventory.zones.map((zone) => {
    if (zone.meta.id !== action.zoneId) return zone
    const summaries = zone.surfaces.rulesets?.result || []
    const nextSummaries = options.deleted
      ? summaries.filter((entry) => entry.id !== action.rulesetId)
      : [
          ...summaries.filter((entry) => entry.id !== action.rulesetId),
          rulesetSurfaceSummary(ruleset),
        ]
    const nextDetails = zone.ruleDetails
      .filter((detail) => !detail.ok || detail.result.id !== action.rulesetId)
    if (!options.deleted && rulesetIsEditable(ruleset)) {
      nextDetails.push({
        ok: true,
        result: ruleset,
        status: 200,
      })
    }
    return {
      ...zone,
      ruleDetails: nextDetails,
      surfaces: {
        ...zone.surfaces,
        rulesets: {
          ...zone.surfaces.rulesets,
          ok: true,
          result: nextSummaries,
          status: 200,
        },
      },
    }
  })
  const patched = {
    ...inventory,
    zones,
  }
  renderInventory(patched, state.inventorySource)
  const workspace = state.rulesetWorkspace
  if (workspace
    && workspace.action.zoneId === action.zoneId
    && workspace.action.rulesetId === action.rulesetId
    && !options.deleted) {
    workspace.ruleset = ruleset
    workspace.error = ""
    workspace.loading = false
    renderRulesetWorkspace()
  }
  return patched
}

async function verifyRulesetAction(action, options = {}) {
  setStatus(`Verifying ${action.phase || "ruleset"} on ${zoneById(action.zoneId)?.meta.name || "zone"}`)
  let ruleset = null
  if (options.deleted) {
    const response = await api.request(
      `zones/${encodeURIComponent(action.zoneId)}/rulesets`,
    )
    if ((response.result || []).some((entry) => entry.id === action.rulesetId)) {
      throw new Error("Cloudflare still reports the deleted ruleset")
    }
  } else {
    const readAction = {
      rulesetId: action.rulesetId,
      type: READ_ACTION.RULESET_INSPECT,
      zoneId: action.zoneId,
    }
    const resourceId = actionResourceId(readAction)
    const liveData = await executeActionReadPlan(api, [readAction])
    ruleset = normalizeRulesetDetail(liveData.resources.get(resourceId))
    if (!ruleset) throw new Error("Ruleset verification returned no live detail")
  }
  const patched = patchVerifiedRuleset(action, ruleset, options)
  const serializedSnapshot = serializeLiveSnapshot(patched)
  window[CACHE_SNAPSHOT_GLOBAL] = serializedSnapshot
  try {
    await api.persistSnapshot(serializedSnapshot)
  } catch (error) {
    setRefreshDetail(
      `Live ruleset verified, but the snapshot was not saved: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    )
  }
  restoreInventoryStatus()
}

function openRulesetWorkspace(action) {
  const zone = zoneById(action.zoneId)
  if (!zone) {
    toast("The selected zone is no longer available", "error")
    return
  }
  const dialogWasOpen = elements.rulesetDialog.open
  const cached = cachedRulesetForAction(action) || {
    id: action.rulesetId,
    kind: action.kind,
    name: action.name,
    phase: action.phase,
  }
  state.rulesetWorkspace = {
    action,
    deployment: null,
    error: "",
    limit: RULESET_RULE_PAGE_SIZE,
    loading: false,
    query: "",
    ruleset: cached,
    status: "all",
    zoneName: zone.meta.name,
  }
  elements.rulesetSearch.value = ""
  elements.rulesetStatusFilter.value = "all"
  renderRulesetWorkspace()
  if (!dialogWasOpen) {
    showDialog(elements.rulesetDialog, {
      initialFocus: elements.rulesetSearch,
    })
  } else {
    elements.rulesetDialog.scrollTop = 0
    elements.rulesetSearch.focus({ preventScroll: true })
  }
  refreshRulesetWorkspace()
}

function showWorkspaceRuleInMatrix(ruleId) {
  const workspace = state.rulesetWorkspace
  if (!workspace) return
  const { ruleset } = workspace
  const zoneId = workspace.action.zoneId
  elements.rulesetDialog.close()
  elements.search.value = ""
  elements.category.value = "Ruleset rules"
  elements.scope.value = MATRIX_SCOPE.ALL
  elements.dnsType.value = ""
  elements.differenceToggle.setAttribute("aria-pressed", "false")
  syncDnsTypeAvailability()
  filterRows()
  const selector = `.matrix-cell[data-zone-id="${CSS.escape(zoneId)}"][data-ruleset-id="${CSS.escape(ruleset.id)}"][data-rule-id="${CSS.escape(ruleId)}"]`
  const cell = elements.matrixBody.querySelector(selector)
  if (!cell) {
    toast("The flattened rule row is unavailable in this matrix snapshot", "error")
    return
  }
  const action = cell.querySelector(MATRIX_CONTROL_SELECTOR)
  cell.scrollIntoView({
    behavior: prefersReducedMotion() ? "auto" : "smooth",
    block: "center",
    inline: "center",
  })
  if (action && !action.disabled) focusMatrixAction(action)
}

function focusRulesetMatrixOpener(action) {
  const button = [...elements.matrixBody.querySelectorAll(".open-ruleset")]
    .find((candidate) => {
      const candidateAction = workspaceActionByButton.get(candidate)
      return candidateAction?.zoneId === action.zoneId
        && candidateAction?.rulesetId === action.rulesetId
    })
  if (button && !button.disabled) focusMatrixAction(button)
}

function policyExceptionComponentLabel(component) {
  return POLICY_EXCEPTION_COMPONENT_LABELS[component]
    || humanizeValueField(component)
}

function dnsPolicyValueElement(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return createElement("span", { text: "No record" })
    const list = createElement("div", { className: "dns-policy-value" })
    for (const entry of value) list.append(dnsPolicyValueElement(entry))
    return list
  }
  if (!value) return createElement("span", { text: "Unavailable" })
  const container = createElement("div", { className: "dns-policy-value" })
  container.append(
    createElement("code", { text: value.content || "No content" }),
    createElement("small", {
      text: Number.isFinite(value.ttl) ? `TTL ${value.ttl} seconds` : "TTL unavailable",
    }),
  )
  return container
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

function matrixActionIsAvailable(action) {
  return !action.disabled
    && !action.closest("tr")?.classList.contains("hidden-row")
    && action.getClientRects().length > 0
}

function visibleEnabledMatrixActions() {
  return [...elements.matrixBody.querySelectorAll(MATRIX_CONTROL_SELECTOR)]
    .filter(matrixActionIsAvailable)
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
        .filter(matrixActionIsAvailable)
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
  if (event.key === "Escape" && state.inlineEditor?.form.contains(event.target)) {
    event.preventDefault()
    closeInlineEditor()
    return
  }
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
  state.emailPolicyExceptionStatuses = evaluateFleetEmailPolicyExceptions(
    state.inventory,
    state.emailDnsPolicy,
    configuredEmailPolicyExceptions(),
  )
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
  elements.emailPolicyDrift.textContent = `${emailDrift.length} drifted`
  const exceptionCount = state.emailPolicyExceptionStatuses.length
  const activeExceptionCount = state.emailPolicyExceptionStatuses.filter(
    (exception) => exception.status === POLICY_EXCEPTION_STATUS.ACTIVE,
  ).length
  const exceptionReviewCount = state.emailPolicyExceptionStatuses.filter(
    (exception) => exception.status === POLICY_EXCEPTION_STATUS.UNAVAILABLE
      || exception.status === POLICY_EXCEPTION_STATUS.VIOLATED,
  ).length
  elements.emailPolicyExceptions.hidden = exceptionCount === 0
  elements.emailPolicyExceptions.textContent = `${exceptionCount} policy exception${exceptionCount === 1 ? "" : "s"}`
  elements.emailPolicyExceptions.classList.toggle(
    "needs-review",
    exceptionReviewCount > 0,
  )
  elements.emailPolicyExceptions.setAttribute(
    "aria-label",
    `Inspect ${exceptionCount} email policy exception${exceptionCount === 1 ? "" : "s"}. ${activeExceptionCount} active and ${exceptionReviewCount} requiring review.`,
  )
  elements.emailPolicyExceptions.title = exceptionReviewCount > 0
    ? `${exceptionReviewCount} configured exception${exceptionReviewCount === 1 ? "" : "s"} requires review`
    : activeExceptionCount > 0
      ? `${activeExceptionCount} configured exception${activeExceptionCount === 1 ? "" : "s"} currently preserves an intentional difference`
      : "The configured email policy exceptions are dormant"

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

function policyExceptionEffect(exception) {
  if (exception.status === POLICY_EXCEPTION_STATUS.ACTIVE) {
    return "This exact variant is excluded from actionable drift and preserved during Email Routing alignment"
  }
  if (exception.status === POLICY_EXCEPTION_STATUS.ALIGNED) {
    return "The zone follows the fleet baseline, so the configured exception has no effect"
  }
  if (exception.status === POLICY_EXCEPTION_STATUS.VIOLATED) {
    return "The current value is not allowed by this exception and remains actionable drift"
  }
  return "The exception cannot be applied until its zone, inventory, and fleet baseline are available"
}

function appendPolicyExceptionField(fields, label, value) {
  const detail = createElement("dd")
  detail.append(value instanceof Node ? value : document.createTextNode(String(value)))
  fields.append(
    createElement("dt", { text: label }),
    detail,
  )
}

function showPolicyExceptionInMatrix(exception) {
  elements.policyExceptionDialog.close()
  requestAnimationFrame(() => {
    elements.search.value = exception.component === EMAIL_POLICY_COMPONENT.SPF
      ? `${exception.zoneName} v=spf1 @`
      : `${exception.zoneName} ${exception.component}`
    elements.category.value = "DNS records"
    elements.scope.value = MATRIX_SCOPE.ALL
    elements.dnsType.value = "TXT"
    elements.differenceToggle.setAttribute("aria-pressed", "false")
    elements.targetHoles.setAttribute("aria-pressed", "false")
    elements.targetHoles.textContent = "Target holes"
    syncDnsTypeAvailability()
    filterRows()

    const rows = [...elements.matrixBody.querySelectorAll("tr:not(.hidden-row)")]
    const targetFacet = exception.component === EMAIL_POLICY_COMPONENT.SPF
      ? "TXT @"
      : ""
    const row = rows.find((candidate) => candidate.dataset.facetKey === targetFacet)
      || rows[0]
    if (!row) {
      elements.search.focus()
      return
    }
    const cell = exception.zoneId
      ? row.querySelector(`[data-zone-id="${CSS.escape(exception.zoneId)}"]`)
      : null
    const action = cell?.querySelector(MATRIX_CONTROL_SELECTOR)
    if (action && !action.disabled) {
      focusMatrixAction(action)
    } else {
      row.scrollIntoView({
        behavior: prefersReducedMotion() ? "auto" : "smooth",
        block: "center",
      })
      elements.search.focus({ preventScroll: true })
    }
  })
}

function openPolicyExceptionDialog() {
  const statuses = state.emailPolicyExceptionStatuses
  if (statuses.length === 0) return
  const activeCount = statuses.filter(
    (exception) => exception.status === POLICY_EXCEPTION_STATUS.ACTIVE,
  ).length
  const reviewCount = statuses.filter(
    (exception) => exception.status === POLICY_EXCEPTION_STATUS.UNAVAILABLE
      || exception.status === POLICY_EXCEPTION_STATUS.VIOLATED,
  ).length
  const dormantCount = statuses.filter(
    (exception) => exception.status === POLICY_EXCEPTION_STATUS.ALIGNED,
  ).length
  const statusParts = [
    activeCount > 0 ? `${activeCount} active` : "",
    dormantCount > 0 ? `${dormantCount} dormant` : "",
    reviewCount > 0 ? `${reviewCount} requiring review` : "",
  ].filter(Boolean)
  elements.policyExceptionSummary.textContent = `${statuses.length} configured exception${statuses.length === 1 ? "" : "s"}: ${statusParts.join(", ")}.`

  const fragment = document.createDocumentFragment()
  for (const exception of statuses) {
    const needsReview = exception.status === POLICY_EXCEPTION_STATUS.UNAVAILABLE
      || exception.status === POLICY_EXCEPTION_STATUS.VIOLATED
    const item = createElement("article", {
      className: `policy-exception${needsReview ? " needs-review" : ""}`,
    })
    const header = createElement("div", { className: "policy-exception-header" })
    header.append(
      createElement("h3", { text: exception.zoneName }),
      createElement("span", {
        className: `exception-status ${exception.status}`,
        text: POLICY_EXCEPTION_STATUS_LABELS[exception.status] || exception.status,
      }),
    )
    const fields = createElement("dl", { className: "policy-exception-fields" })
    appendPolicyExceptionField(
      fields,
      "Component",
      policyExceptionComponentLabel(exception.component),
    )
    appendPolicyExceptionField(fields, "Reason", exception.reason)
    appendPolicyExceptionField(fields, "Allowed variant", dnsPolicyValueElement(exception.expected))
    appendPolicyExceptionField(fields, "Current value", dnsPolicyValueElement(exception.current))
    appendPolicyExceptionField(fields, "Fleet baseline", dnsPolicyValueElement(exception.baseline))
    appendPolicyExceptionField(fields, "Evaluation", exception.detail)
    appendPolicyExceptionField(fields, "Effect", policyExceptionEffect(exception))
    item.append(header, fields)
    if (exception.zoneId) {
      const actions = createElement("div", { className: "policy-exception-actions" })
      const show = createElement("button", {
        className: "button button-quiet",
        text: "Show in matrix",
      })
      show.type = "button"
      show.addEventListener("click", () => showPolicyExceptionInMatrix(exception))
      actions.append(show)
      item.append(actions)
    }
    fragment.append(item)
  }
  elements.policyExceptionList.replaceChildren(fragment)
  elements.policyExceptionRaw.textContent = JSON.stringify(
    configuredEmailPolicyExceptions(),
    null,
    2,
  )
  showDialog(elements.policyExceptionDialog, {
    initialFocus: elements.policyExceptionDialog.querySelector("[data-dialog-close]"),
  })
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

  if (cell.action?.type === "ruleset-rule") {
    td.dataset.ruleId = cell.action.ruleId
    td.dataset.rulesetId = cell.action.rulesetId
  }
  td.classList.add(`variant-${row.variantIndexes.get(cell.canonical) || 0}`)
  const directlyEditable = Boolean(cell.action && !readOnly)
  const structuredValue = cell.inspectionValue !== null
    && typeof cell.inspectionValue === "object"
  if (cell.presentation?.kind === "rule") {
    const details = document.createElement("details")
    details.className = "cell-value-details"
    details.append(
      createElement("summary", { text: cell.display }),
      createRuleSummary(
        cell.presentation.rule,
        cell.presentation.phase,
        {
          compact: true,
          omitFields: ["description", "enabled"],
        },
      ),
      createRawValueDetails(cell.inspectionValue, "Raw rule JSON"),
    )
    td.append(details)
  } else if (structuredValue) {
    const details = document.createElement("details")
    details.className = "cell-value-details"
    details.append(
      createElement("summary", { text: cell.display }),
      createGenericValueInspection(cell.inspectionValue),
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
    td.dataset.editTitle = `${label}; the desired state may expand into multiple API operations`
    editActionByCell.set(td, cell.action)
  }

  const hasWriteSecondaryAction = Boolean(cell.secondaryAction && !readOnly)
  const hasWorkspaceAction = Boolean(cell.workspaceAction || cell.parentAction)
  if (directlyEditable || hasWriteSecondaryAction || hasWorkspaceAction) {
    const actions = createElement("div", { className: "cell-actions" })
    if (cell.workspaceAction) {
      const openButton = createElement("button", {
        className: "cell-action open-ruleset",
        text: "Open",
      })
      openButton.type = "button"
      openButton.setAttribute("aria-label", `Open ${row.label} on ${zone.meta.name}`)
      openButton.title = "Open this ruleset and inspect its ordered rules"
      workspaceActionByButton.set(openButton, cell.workspaceAction)
      actions.append(openButton)
    }
    if (cell.parentAction) {
      const parentButton = createElement("button", {
        className: "cell-action open-ruleset",
        text: "Ruleset",
      })
      parentButton.type = "button"
      parentButton.setAttribute("aria-label", `Open the parent ruleset for ${row.label} on ${zone.meta.name}`)
      parentButton.title = "Open the parent ruleset workspace"
      workspaceActionByButton.set(parentButton, cell.parentAction)
      actions.append(parentButton)
    }
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
    if (hasWriteSecondaryAction) {
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
    tr.dataset.facetKey = row.key
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
  if (state.inlineEditor) {
    setInlineEditorDisabled(state.inlineEditor, writeLocked)
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

function operationRuleDefinitions(operation) {
  if (Array.isArray(operation.body?.rules)) {
    return operation.body.rules.map((rule) => ({
      phase: operation.body.phase || "",
      rule,
    }))
  }
  if (operation.body?.action && operation.body.expression !== undefined) {
    return [
      {
        phase: "",
        rule: operation.body,
      },
    ]
  }
  return []
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
  elements.confirmSummary.textContent = `Live state was validated at ${validationTime}. ${actionable.length} zone${actionable.length === 1 ? "" : "s"} and ${operations.length} API write${operations.length === 1 ? "" : "s"} will be applied, then the affected live state will be re-read for verification.`
  elements.confirmOperations.replaceChildren()
  for (const operation of operations) {
    const item = createElement("div", { className: "operation" })
    item.setAttribute("role", "listitem")
    item.append(
      createElement("code", { text: operation.method }),
      createElement("span", { text: operation.path }),
      createElement("small", { text: `${operation.zone}: ${operation.label}` }),
    )
    const rules = operationRuleDefinitions(operation)
    if (rules.length > 0) {
      const summary = createElement("div", { className: "operation-rule-summary" })
      for (const [index, definition] of rules.entries()) {
        if (rules.length > 1) {
          summary.append(
            createElement("h4", {
              text: `Rule ${index + 1}: ${definition.rule.description || definition.rule.ref || definition.rule.action}`,
            }),
          )
        }
        summary.append(createRuleSummary(definition.rule, definition.phase))
      }
      item.append(summary)
    }
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

async function applyPlans(title, planSet, options = {}) {
  if (!planSet?.[LIVE_PLAN_SET]) {
    toast("This change has not passed live validation", "error")
    return false
  }
  if (!await confirmPlans(title, planSet)) return false
  const plans = planSet.plans
  setBusy(true)
  let writesCompleted = false
  try {
    await executePlans(api, plans, {
      onProgress: ({ completed, total, operation, plan }) => {
        if (operation) setStatus(`Writing ${completed + 1}/${total}: ${plan.zoneName}`)
      },
    })
    writesCompleted = true
    toast("Writes succeeded; re-reading live state for verification")
    if (options.verify) await options.verify()
    else await refreshInventory({ preserveSelection: true })
    toast(options.successMessage || "Writes succeeded and live verification passed")
    return true
  } catch (error) {
    setStatus(writesCompleted ? "Verification failed" : "Write failed", "error")
    toast(error instanceof Error ? error.message : String(error), "error")
    try {
      if (options.verify) await options.verify()
      else await refreshInventory({ preserveSelection: true })
    } catch {
      restoreInventoryStatus()
    }
    return false
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
  elements.holePreview.textContent = candidate
    ? formattedJson(candidate.inspectionValue)
    : "No source value selected"
  const isRule = candidate?.presentation?.kind === "rule"
  elements.holeStructuredPreview.hidden = !candidate
  elements.holeStructuredPreview.replaceChildren()
  elements.holeRawPreview.open = false
  elements.holePreviewSummary.textContent = isRule
    ? "Raw source rule JSON"
    : "Raw source value JSON"
  if (isRule) {
    elements.holeStructuredPreview.append(
      createRuleSummary(
        candidate.presentation.rule,
        candidate.presentation.phase,
      ),
    )
  } else if (candidate) {
    elements.holeStructuredPreview.append(
      structuredValueElement(candidate.inspectionValue),
    )
  }
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

let valueEditorControlSequence = 0

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value))
}

function encodeValuePath(path) {
  return JSON.stringify(path)
}

function decodeValuePath(value) {
  const path = JSON.parse(value)
  if (!Array.isArray(path)) throw new TypeError("The editor field path is invalid")
  return path
}

function valueEditorControlId() {
  valueEditorControlSequence += 1
  return `value-editor-control-${valueEditorControlSequence}`
}

function appendTypeBadge(container, kind) {
  container.append(
    createElement("span", {
      className: "value-type",
      text: kind,
    }),
  )
}

function createScalarValueField(value, path, label, suggestions = []) {
  const descriptor = valueControlDescriptor(value, path.at(-1) || "")
  const field = createElement("div", {
    className: `value-field${descriptor.multiline ? " multiline" : ""}`,
  })
  const controlId = valueEditorControlId()
  let control
  let controlAppended = false

  if (descriptor.kind === JSON_VALUE_KIND.BOOLEAN) {
    const booleanLabel = createElement("label", { className: "value-boolean" })
    control = document.createElement("input")
    control.type = "checkbox"
    control.checked = value
    booleanLabel.htmlFor = controlId
    booleanLabel.append(
      control,
      createElement("span", { text: label }),
    )
    field.append(booleanLabel)
    controlAppended = true
  } else {
    const heading = createElement("label", { text: label })
    heading.htmlFor = controlId
    field.append(heading)
    if (descriptor.kind === JSON_VALUE_KIND.NUMBER) {
      control = document.createElement("input")
      control.type = "number"
      control.step = "any"
      control.required = true
      control.value = String(value)
    } else if (descriptor.multiline) {
      control = document.createElement("textarea")
      control.rows = Math.min(8, Math.max(3, String(value).split("\n").length + 1))
      control.value = value
    } else {
      control = document.createElement("input")
      control.type = "text"
      control.autocomplete = "off"
      control.spellcheck = false
      control.value = value
      if (suggestions.length > 0) {
        const datalist = document.createElement("datalist")
        datalist.id = `${controlId}-suggestions`
        datalist.append(...suggestions.map((suggestion) => {
          const option = document.createElement("option")
          option.value = suggestion
          return option
        }))
        control.setAttribute("list", datalist.id)
        field.append(datalist)
      }
    }
  }

  control.id = controlId
  control.className = "value-control"
  control.dataset.valueKind = descriptor.kind
  control.dataset.valuePath = encodeValuePath(path)
  if (!controlAppended) field.append(control)
  appendTypeBadge(field, descriptor.kind)
  return field
}

function createNullValueField(path, label) {
  const field = createElement("div", { className: "value-field" })
  const controlId = valueEditorControlId()
  const heading = createElement("label", { text: label })
  heading.htmlFor = controlId
  const select = document.createElement("select")
  select.id = controlId
  select.className = "value-control"
  select.dataset.nullPath = encodeValuePath(path)
  select.append(...Object.values(JSON_VALUE_KIND).map((kind) => {
    const option = createElement("option", {
      text: kind === JSON_VALUE_KIND.NULL
        ? "Null"
        : `Change to ${kind}`,
    })
    option.value = kind
    option.selected = kind === JSON_VALUE_KIND.NULL
    return option
  }))
  field.append(heading, select)
  appendTypeBadge(field, JSON_VALUE_KIND.NULL)
  return field
}

function createObjectValueField(value, path, label, options) {
  const group = createElement("fieldset", { className: "value-group value-object" })
  const legend = createElement("legend", { text: label })
  appendTypeBadge(legend, JSON_VALUE_KIND.OBJECT)
  group.append(legend)
  const entries = orderedValueEntries(value)
  if (entries.length === 0) {
    group.append(
      createElement("p", {
        className: "empty-value",
        text: "No cached fields. Use Advanced JSON to add a field.",
      }),
    )
    return group
  }
  const fields = createElement("div", { className: "value-group-fields" })
  const editableKeys = EDITABLE_OBJECT_KEY_FIELDS.has(String(path.at(-1)))
  for (const [key, entry] of entries) {
    const valueField = createValueField(
      entry,
      [...path, key],
      humanizeValueField(key),
      options,
    )
    if (!editableKeys) {
      fields.append(valueField)
      continue
    }
    const mapEntry = createElement("div", {
      className: "value-map-entry",
    })
    const keyField = createElement("div", {
      className: "value-field value-map-key",
    })
    const controlId = valueEditorControlId()
    const keyLabel = createElement("label", {
      text: "Header name",
    })
    keyLabel.htmlFor = controlId
    const keyControl = document.createElement("input")
    keyControl.id = controlId
    keyControl.type = "text"
    keyControl.autocomplete = "off"
    keyControl.spellcheck = false
    keyControl.className = "value-control value-object-key-control"
    keyControl.value = key
    keyControl.dataset.objectKeyOriginal = key
    keyControl.dataset.objectKeyPath = encodeValuePath(path)
    keyField.append(keyLabel, keyControl)
    mapEntry.append(keyField, valueField)
    fields.append(mapEntry)
  }
  group.append(fields)
  return group
}

function createArrayValueField(value, path, label, options) {
  const group = createElement("fieldset", { className: "value-group value-array" })
  const legend = createElement("legend", { text: label })
  appendTypeBadge(legend, JSON_VALUE_KIND.ARRAY)
  group.append(legend)
  const items = createElement("div", { className: "value-array-items" })
  if (value.length === 0) {
    items.append(
      createElement("p", {
        className: "empty-value",
        text: "No items",
      }),
    )
  }
  for (const [index, entry] of value.entries()) {
    const row = createElement("div", { className: "value-array-item" })
    row.append(
      createValueField(
        entry,
        [...path, index],
        `Item ${index + 1}`,
        options,
      ),
    )
    const remove = createElement("button", {
      className: "button button-quiet value-array-remove",
      text: "Remove",
    })
    remove.type = "button"
    remove.dataset.arrayIndex = String(index)
    remove.dataset.arrayPath = encodeValuePath(path)
    remove.setAttribute("aria-label", `Remove ${label} item ${index + 1}`)
    row.append(remove)
    items.append(row)
  }
  const add = createElement("button", {
    className: "button button-quiet value-array-add",
    text: "Add item",
  })
  add.type = "button"
  add.dataset.arrayPath = encodeValuePath(path)
  add.setAttribute("aria-label", `Add ${label} item`)
  group.append(items, add)
  return group
}

function createValueField(value, path, label, options = {}) {
  const kind = jsonValueKind(value)
  if (kind === JSON_VALUE_KIND.NULL) return createNullValueField(path, label)
  if (kind === JSON_VALUE_KIND.OBJECT) {
    return createObjectValueField(value, path, label, options)
  }
  if (kind === JSON_VALUE_KIND.ARRAY) {
    return createArrayValueField(value, path, label, options)
  }
  const suggestions = options.suggestions?.get(encodeValuePath(path)) || []
  return createScalarValueField(value, path, label, suggestions)
}

function renderValueEditor() {
  const editor = state.editor
  if (!editor) return
  const draft = editor.draft
  const kind = jsonValueKind(draft)
  const fragment = document.createDocumentFragment()
  if (kind === JSON_VALUE_KIND.OBJECT) {
    const entries = orderedValueEntries(draft)
    if (entries.length === 0) {
      fragment.append(
        createElement("p", {
          className: "empty-value",
          text: "No cached fields. Use Advanced JSON to add a field.",
        }),
      )
    }
    for (const [key, value] of entries) {
      fragment.append(
        createValueField(
          value,
          [key],
          humanizeValueField(key),
          editor,
        ),
      )
    }
  } else {
    fragment.append(createValueField(draft, [], "Value", editor))
  }
  elements.valueEditorFields.replaceChildren(fragment)
}

function syncEditorJson() {
  if (!state.editor) return
  elements.editorValue.value = formattedJson(state.editor.draft)
  elements.editorValue.removeAttribute("aria-invalid")
  clearFieldError(elements.editorValue, elements.editorError)
}

function replaceEditorDraft(draft, options = {}) {
  if (!state.editor) return
  state.editor.draft = draft
  syncEditorJson()
  if (options.render !== false) renderValueEditor()
}

function selectedEditorEntry() {
  return state.editor?.entries.find(
    (candidate) => candidate.id === elements.editorChoice.value,
  ) || state.editor?.entries[0] || null
}

function renderSelectedEditorEntry() {
  const entry = selectedEditorEntry()
  if (!entry || !state.editor) return
  elements.editorChoice.value = entry.id
  state.editor.draft = cloneJsonValue(entry.value)
  elements.valueEditorContext.textContent = entry.presentation?.kind === "rule"
    ? `${rulePhaseLabel(entry.presentation.phase)} phase`
    : `${humanizeValueField(jsonValueKind(entry.value))} value`
  elements.editorJson.open = false
  syncEditorJson()
  renderValueEditor()
}

function syncEditorFromJson() {
  if (!state.editor) return
  try {
    const draft = JSON.parse(elements.editorValue.value)
    jsonValueKind(draft)
    state.editor.draft = draft
    elements.editorValue.removeAttribute("aria-invalid")
    clearFieldError(elements.editorValue, elements.editorError)
    renderValueEditor()
  } catch {
    elements.editorValue.setAttribute("aria-invalid", "true")
  }
}

function focusValueEditorPath(path) {
  const encoded = encodeValuePath(path)
  const control = [...elements.valueEditorFields.querySelectorAll(".value-control")]
    .find((candidate) => candidate.dataset.valuePath === encoded)
  control?.focus()
}

function updateGeneratedEditorControl(event) {
  const control = event.target.closest("[data-value-path]")
  if (!control || !state.editor) return
  const path = decodeValuePath(control.dataset.valuePath)
  try {
    const value = parseScalarControl(
      control.dataset.valueKind,
      control.value,
      control.checked,
    )
    control.setCustomValidity("")
    replaceEditorDraft(
      replaceValueAtPath(state.editor.draft, path, value),
      { render: false },
    )
  } catch (error) {
    control.setCustomValidity(error instanceof Error ? error.message : String(error))
  }
}

function remapEditorObjectKeyPaths(mapEntry, path, currentKey, desiredKey) {
  const pathAttributes = [
    "arrayPath",
    "nullPath",
    "objectKeyPath",
    "valuePath",
  ]
  for (const attribute of pathAttributes) {
    for (const candidate of mapEntry.querySelectorAll(`[data-${attribute.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}]`)) {
      const currentPath = decodeValuePath(candidate.dataset[attribute])
      const sameParent = path.every(
        (segment, index) => currentPath[index] === segment,
      )
      if (sameParent && currentPath[path.length] === currentKey) {
        currentPath[path.length] = desiredKey
        candidate.dataset[attribute] = encodeValuePath(currentPath)
      }
    }
  }
}

function renameGeneratedEditorObjectKey(event) {
  const control = event.target.closest("[data-object-key-path]")
  if (!control || !state.editor) return
  const path = decodeValuePath(control.dataset.objectKeyPath)
  const currentKey = control.dataset.objectKeyOriginal
  const desiredKey = control.value.trim()
  try {
    if (!HTTP_HEADER_NAME_PATTERN.test(desiredKey)) {
      throw new TypeError("Enter a valid HTTP header name")
    }
    const object = valueAtPath(state.editor.draft, path)
    const collision = Object.keys(object).find(
      (key) => key !== currentKey
        && key.toLowerCase() === desiredKey.toLowerCase(),
    )
    if (collision) throw new Error(`Header ${collision} already exists`)
    control.setCustomValidity("")
    const mapEntry = control.closest(".value-map-entry")
    const nextDraft = renameObjectKeyAtPath(
      state.editor.draft,
      path,
      currentKey,
      desiredKey,
    )
    replaceEditorDraft(
      nextDraft,
      { render: false },
    )
    control.dataset.objectKeyOriginal = desiredKey
    remapEditorObjectKeyPaths(mapEntry, path, currentKey, desiredKey)
    const legend = mapEntry.querySelector(":scope > .value-group > legend")
    if (legend?.firstChild) {
      legend.firstChild.textContent = humanizeValueField(desiredKey)
    }
  } catch (error) {
    control.setCustomValidity(error instanceof Error ? error.message : String(error))
    control.reportValidity()
    control.focus()
  }
}

function changeNullEditorType(event) {
  const control = event.target.closest("[data-null-path]")
  if (!control || !state.editor) return
  const path = decodeValuePath(control.dataset.nullPath)
  const replacement = defaultValueForKind(control.value)
  replaceEditorDraft(
    replaceValueAtPath(state.editor.draft, path, replacement),
  )
  requestAnimationFrame(() => focusValueEditorPath(path))
}

function handleValueEditorAction(event) {
  const add = event.target.closest(".value-array-add")
  if (add && state.editor) {
    const path = decodeValuePath(add.dataset.arrayPath)
    const nextIndex = valueAtPath(state.editor.draft, path).length
    replaceEditorDraft(appendArrayItemAtPath(state.editor.draft, path))
    requestAnimationFrame(() => focusValueEditorPath([...path, nextIndex]))
    return
  }
  const remove = event.target.closest(".value-array-remove")
  if (!remove || !state.editor) return
  const path = decodeValuePath(remove.dataset.arrayPath)
  replaceEditorDraft(
    removeArrayItemAtPath(
      state.editor.draft,
      path,
      Number(remove.dataset.arrayIndex),
    ),
  )
  requestAnimationFrame(() => {
    const encoded = encodeValuePath(path)
    const addButton = [...elements.valueEditorFields.querySelectorAll(".value-array-add")]
      .find((candidate) => candidate.dataset.arrayPath === encoded)
    addButton?.focus()
  })
}

function collectValueSuggestions(values) {
  const suggestions = new Map()
  const visit = (value, path) => {
    const kind = jsonValueKind(value)
    if (kind === JSON_VALUE_KIND.STRING) {
      const key = encodeValuePath(path)
      if (!suggestions.has(key)) suggestions.set(key, new Set())
      suggestions.get(key).add(value)
      return
    }
    if (kind === JSON_VALUE_KIND.OBJECT) {
      for (const [field, entry] of Object.entries(value)) {
        visit(entry, [...path, field])
      }
      return
    }
    if (kind === JSON_VALUE_KIND.ARRAY) {
      for (const [index, entry] of value.entries()) {
        visit(entry, [...path, index])
      }
    }
  }
  for (const value of values) visit(value, [])
  return new Map(
    [...suggestions].map(([path, entries]) => [
      path,
      [...entries].sort((left, right) => left.localeCompare(right)),
    ]),
  )
}

function zoneSettingValues(settingId) {
  return state.inventory.zones.flatMap((zone) => {
    const setting = zone.surfaces.settings?.result?.find(
      (entry) => entry.id === settingId,
    )
    return setting ? [setting.value] : []
  })
}

function setInlineEditorDisabled(editor, disabled) {
  for (const control of editor.form.querySelectorAll("button, input, select, textarea")) {
    control.disabled = disabled
  }
}

function closeInlineEditor(options = {}) {
  const editor = state.inlineEditor
  if (!editor) return
  const focusTarget = editor.cell.querySelector(".edit-cell")
  editor.form.remove()
  editor.cell.classList.remove("inline-editing")
  state.inlineEditor = null
  if (options.restoreFocus !== false && focusTarget?.isConnected) {
    focusTarget.focus({ preventScroll: true })
  }
}

function updateInlineEditorDraft(editor) {
  try {
    editor.draft = parseScalarControl(
      editor.kind,
      editor.control.value,
      editor.control.checked,
    )
    editor.control.setCustomValidity("")
    clearFieldError(editor.control, editor.error)
  } catch (error) {
    editor.control.setCustomValidity(error instanceof Error ? error.message : String(error))
  }
}

async function reviewInlineSetting(event) {
  event.preventDefault()
  const editor = state.inlineEditor
  if (!editor || editor.form !== event.currentTarget) return
  updateInlineEditorDraft(editor)
  if (!editor.form.checkValidity()) {
    editor.form.reportValidity()
    editor.control.focus()
    requestAnimationFrame(() => editor.control.focus())
    return
  }

  setInlineEditorDisabled(editor, true)
  let plan
  try {
    plan = await planSettingEdit(editor, editor.draft)
  } catch (error) {
    if (state.inlineEditor !== editor) return
    setInlineEditorDisabled(editor, false)
    showFieldError(editor.control, editor.error, error)
    editor.control.focus()
    return
  }
  if (state.inlineEditor !== editor) return
  closeInlineEditor({ restoreFocus: false })
  await applyPlans("Update zone setting", createLivePlanSet([plan]))
}

function openInlineSettingEditor(cell, action, zone, setting) {
  closeInlineEditor({ restoreFocus: false })
  const suggestions = collectValueSuggestions(
    zoneSettingValues(action.settingId),
  ).get(encodeValuePath([])) || []
  const field = createScalarValueField(
    setting.value,
    [],
    "Desired value",
    suggestions,
  )
  const control = field.querySelector(".value-control")
  const form = createElement("form", { className: "inline-value-editor" })
  const error = createElement("p", {
    className: "field-error inline-editor-error",
  })
  error.hidden = true
  error.id = `inline-editor-error-${valueEditorControlSequence}`
  error.setAttribute("role", "alert")
  error.setAttribute("aria-live", "assertive")
  control.setAttribute("aria-errormessage", error.id)

  const cancel = createElement("button", {
    className: "button button-quiet",
    text: "Cancel",
  })
  cancel.type = "button"
  const review = createElement("button", {
    className: "button button-primary",
    text: "Review",
  })
  review.type = "submit"
  const actions = createElement("div", { className: "inline-editor-actions" })
  actions.append(cancel, review)
  form.append(field, error, actions)

  const kind = jsonValueKind(setting.value)
  state.inlineEditor = {
    action,
    cell,
    control,
    draft: cloneJsonValue(setting.value),
    error,
    form,
    kind,
    zone,
  }
  const editor = state.inlineEditor
  cell.classList.add("inline-editing")
  cell.append(form)
  control.addEventListener("input", () => updateInlineEditorDraft(editor))
  control.addEventListener("change", () => updateInlineEditorDraft(editor))
  cancel.addEventListener("click", () => closeInlineEditor())
  form.addEventListener("submit", reviewInlineSetting)
  control.focus()
  if (control instanceof HTMLInputElement && control.type === "text") control.select()
}

function openDesiredStateEditor(options) {
  const {
    action,
    afterApply = null,
    entries,
    kind,
    suggestions = collectValueSuggestions(entries.map((entry) => entry.value)),
    target,
    title,
    valueLabel,
    verify = null,
    zone,
  } = options
  state.editor = {
    action,
    afterApply,
    entries,
    suggestions,
    verify,
    zone,
  }
  elements.editorKind.textContent = kind
  elements.editorTitle.textContent = title
  elements.editorTarget.textContent = target
    || `${zone.meta.name} | cached state shown; only the live facts needed for this change will be reread before confirmation`
  elements.editorValueLabel.textContent = valueLabel
  clearFieldError(elements.editorValue, elements.editorError)
  elements.editorChoice.replaceChildren(...entries.map((entry) => {
    const option = createElement("option", { text: entry.label })
    option.value = entry.id
    return option
  }))
  elements.editorChoiceRow.hidden = entries.length <= 1
  renderSelectedEditorEntry()
  const initialFocus = elements.valueEditorFields.querySelector(".value-control")
    || elements.editorChoice
  showDialog(elements.editorDialog, {
    initialFocus,
  })
}

function openCellEditor(cell) {
  if (state.busy || readOnly || !state.transportAvailable) return
  const action = editActionByCell.get(cell)
  const zone = zoneById(cell.dataset.zoneId)
  if (!action || !zone) {
    toast("The selected resource is no longer available", "error")
    return
  }
  closeInlineEditor({ restoreFocus: false })

  let entries
  let kind
  let suggestions = new Map()
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
    const settingKind = jsonValueKind(setting.value)
    if (
      settingKind === JSON_VALUE_KIND.BOOLEAN
      || settingKind === JSON_VALUE_KIND.NUMBER
      || settingKind === JSON_VALUE_KIND.STRING
    ) {
      openInlineSettingEditor(cell, action, zone, setting)
      return
    }
    entries = [
      {
        id: setting.id,
        label: setting.id,
        value: setting.value,
      },
    ]
    suggestions = collectValueSuggestions(zoneSettingValues(action.settingId))
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
    suggestions = collectValueSuggestions(entries.map((entry) => entry.value))
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
        presentation: {
          kind: "rule",
          phase: action.phase,
        },
        value: editableRulePayload(cached.rule),
      },
    ]
    suggestions = collectValueSuggestions(entries.map((entry) => entry.value))
    kind = "Ruleset rule"
    title = entries[0].label
    valueLabel = "Desired rule definition"
  } else {
    toast(`Editor support is unavailable for ${action.type}`, "error")
    return
  }

  openDesiredStateEditor({
    action,
    entries,
    kind,
    suggestions,
    title,
    valueLabel,
    zone,
  })
}

function workspaceEditorTarget(zone, ruleset) {
  return `${zone.meta.name} | ${rulesetWorkspaceTitle(ruleset)} | cached definition shown; the exact ruleset will be reread before confirmation`
}

async function refreshWorkspaceAfterApply(applied) {
  if (!applied || !elements.rulesetDialog.open || !state.rulesetWorkspace) return
  renderRulesetWorkspace()
}

function openWorkspaceRuleEditor(rule, targetRuleset = null) {
  const workspace = state.rulesetWorkspace
  const zone = workspace ? zoneById(workspace.action.zoneId) : null
  const ruleset = targetRuleset || workspace?.ruleset
  if (!workspace || !zone || !ruleset || !rule) {
    toast("The selected rule is no longer available", "error")
    return
  }
  const index = ruleset.rules?.findIndex((entry) => entry.id === rule.id) ?? -1
  const label = rulesetRuleLabel(rule, Math.max(index, 0))
  const action = {
    phase: ruleset.phase,
    ruleId: rule.id,
    rulesetId: ruleset.id,
    type: READ_ACTION.RULE_EDIT,
    zoneId: zone.meta.id,
  }
  openDesiredStateEditor({
    action,
    afterApply: refreshWorkspaceAfterApply,
    entries: [
      {
        id: rule.id,
        label,
        presentation: {
          kind: "rule",
          phase: ruleset.phase,
        },
        value: editableRulePayload(rule),
      },
    ],
    kind: "Ruleset rule",
    target: workspaceEditorTarget(zone, ruleset),
    title: label,
    valueLabel: "Desired rule definition",
    verify: () => verifyRulesetAction(action),
    zone,
  })
}

function openWorkspaceRuleCreateEditor(definition, title = "Add rule") {
  const workspace = state.rulesetWorkspace
  const zone = workspace ? zoneById(workspace.action.zoneId) : null
  if (!workspace || !zone || !definition || !rulesetIsEditable(workspace.ruleset)) {
    toast("A safe starter definition is unavailable for this ruleset", "error")
    return
  }
  const action = {
    phase: workspace.ruleset.phase,
    rulesetId: workspace.ruleset.id,
    type: READ_ACTION.RULE_CREATE,
    zoneId: zone.meta.id,
  }
  openDesiredStateEditor({
    action,
    afterApply: refreshWorkspaceAfterApply,
    entries: [
      {
        id: "new-rule",
        label: definition.description || "New rule",
        presentation: {
          kind: "rule",
          phase: workspace.ruleset.phase,
        },
        value: definition,
      },
    ],
    kind: "New ruleset rule",
    target: workspaceEditorTarget(zone, workspace.ruleset),
    title,
    valueLabel: "New rule definition",
    verify: () => verifyRulesetAction(action),
    zone,
  })
}

async function liveRulesetContext(action, readType, label) {
  const zone = zoneById(action.zoneId)
  if (!zone) throw new Error("The selected zone is no longer available")
  const readAction = {
    phase: action.phase,
    rulesetId: action.rulesetId,
    type: readType,
    zoneId: action.zoneId,
  }
  const liveData = await runWritePreflight(
    `${label} on ${zone.meta.name}`,
    () => executePreflightRead([readAction]),
  )
  if (liveData.inventory) {
    assertSurfaceReads(liveData.inventory, ["rulesets"], `${label} rulesets`)
    const liveZone = selectedLiveZones(liveData.inventory, [action.zoneId])[0]
    const detail = liveZone.ruleDetails.find(
      (entry) => entry.result?.id === action.rulesetId,
    )
    if (!detail?.ok) throw new Error("Live validation returned no ruleset detail")
    return {
      ruleset: detail.result,
      zone: liveZone,
    }
  }
  const resourceId = actionResourceId(readAction)
  const ruleset = liveData.resources.get(resourceId)
  if (!ruleset) throw new Error("Live validation returned no ruleset detail")
  const otherDetails = workspaceZoneRulesets(zone)
    .filter((entry) => entry.id !== ruleset.id)
    .map((entry) => ({
      ok: true,
      result: entry,
    }))
  return {
    ruleset,
    zone: {
      meta: zone.meta,
      ruleDetails: [
        ...otherDetails,
        {
          ok: true,
          result: ruleset,
        },
      ],
      surfaces: {},
    },
  }
}

async function planRuleCreate(editor, desiredDefinition) {
  const context = await liveRulesetContext(
    editor.action,
    READ_ACTION.RULE_CREATE,
    "new rule",
  )
  return buildRuleCreatePlan(context.zone, context.ruleset, desiredDefinition)
}

async function applyWorkspaceMutation(title, readType, label, buildPlan, options = {}) {
  const workspace = state.rulesetWorkspace
  if (!workspace || workspaceWriteLocked()) return false
  const action = {
    phase: workspace.ruleset.phase,
    rulesetId: workspace.ruleset.id,
    zoneId: workspace.action.zoneId,
  }
  try {
    const context = await liveRulesetContext(action, readType, label)
    const plan = buildPlan(context)
    const applied = await applyPlans(
      title,
      createLivePlanSet([plan]),
      {
        verify: () => verifyRulesetAction(action, {
          deleted: options.closeWorkspace,
        }),
      },
    )
    if (!applied) return false
    if (options.closeWorkspace) {
      if (elements.rulesetDialog.open) elements.rulesetDialog.close()
    } else if (elements.rulesetDialog.open && state.rulesetWorkspace) {
      renderRulesetWorkspace()
    }
    return true
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error")
    return false
  }
}

function toggleWorkspaceRule(ruleId) {
  const workspace = state.rulesetWorkspace
  if (!workspace) return
  applyWorkspaceMutation(
    "Update rule status",
    READ_ACTION.RULE_EDIT,
    "rule status",
    ({ ruleset, zone }) => {
      const rule = ruleset.rules?.find((entry) => entry.id === ruleId)
      if (!rule) throw new Error("The rule is no longer available")
      const desired = editableRulePayload(rule)
      desired.enabled = rule.enabled === false
      return buildRuleEditPlan(zone, {
        phase: ruleset.phase,
        ruleId,
        rulesetId: ruleset.id,
      }, desired)
    },
  )
}

function reorderWorkspaceRule(ruleId, direction) {
  applyWorkspaceMutation(
    "Reorder ruleset rule",
    READ_ACTION.RULE_REORDER,
    "rule order",
    ({ ruleset, zone }) => {
      const currentIndex = ruleset.rules?.findIndex((entry) => entry.id === ruleId) ?? -1
      if (currentIndex === -1) throw new Error("The rule is no longer available")
      return buildRuleReorderPlan(
        zone,
        ruleset,
        ruleId,
        currentIndex + direction,
      )
    },
  )
}

function deleteWorkspaceRule(ruleId) {
  applyWorkspaceMutation(
    "Delete ruleset rule",
    READ_ACTION.RULE_DELETE,
    "rule deletion",
    ({ ruleset, zone }) => buildRuleDeletePlan(zone, ruleset, ruleId),
  )
}

function deleteWorkspaceRuleset() {
  applyWorkspaceMutation(
    "Delete empty ruleset",
    READ_ACTION.RULESET_DELETE,
    "ruleset deletion",
    ({ ruleset, zone }) => buildRulesetDeletePlan(zone, ruleset),
    {
      closeWorkspace: true,
    },
  )
}

function openRulesetDescriptionEditor() {
  const workspace = state.rulesetWorkspace
  if (!workspace || workspaceWriteLocked()) return
  elements.rulesetDescriptionValue.value = workspace.ruleset.description || ""
  clearFieldError(
    elements.rulesetDescriptionValue,
    elements.rulesetDescriptionError,
  )
  showDialog(elements.rulesetDescriptionDialog, {
    initialFocus: elements.rulesetDescriptionValue,
  })
  elements.rulesetDescriptionValue.select()
}

async function reviewRulesetDescription(event) {
  if (event.submitter?.value === "cancel") return
  event.preventDefault()
  const workspace = state.rulesetWorkspace
  if (!workspace) {
    showFieldError(
      elements.rulesetDescriptionValue,
      elements.rulesetDescriptionError,
      "The ruleset workspace is unavailable",
    )
    return
  }
  try {
    const context = await liveRulesetContext(
      workspace.action,
      READ_ACTION.RULESET_EDIT,
      "ruleset description",
    )
    const plan = buildRulesetDescriptionPlan(
      context.zone,
      context.ruleset,
      elements.rulesetDescriptionValue.value,
    )
    if (!elements.rulesetDescriptionDialog.open) return
    elements.rulesetDescriptionDialog.close()
    const applied = await applyPlans(
      "Update ruleset description",
      createLivePlanSet([plan]),
      {
        verify: () => verifyRulesetAction(workspace.action),
      },
    )
    await refreshWorkspaceAfterApply(applied)
  } catch (error) {
    if (!elements.rulesetDescriptionDialog.open) return
    showFieldError(
      elements.rulesetDescriptionValue,
      elements.rulesetDescriptionError,
      error,
    )
  }
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
  const invalidControl = elements.valueEditorFields.querySelector(":invalid")
  if (invalidControl) {
    elements.editorError.textContent = invalidControl.validationMessage
    elements.editorError.hidden = false
    invalidControl.focus()
    invalidControl.reportValidity()
    return
  }

  let desired
  try {
    desired = JSON.parse(elements.editorValue.value)
  } catch (error) {
    elements.editorJson.open = true
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
    } else if (editor.action.type === READ_ACTION.RULE_CREATE) {
      plan = await planRuleCreate(editor, desired)
      confirmationTitle = "Create ruleset rule"
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
  const applied = await applyPlans(
    confirmationTitle,
    createLivePlanSet([plan]),
    editor.verify
      ? {
          verify: editor.verify,
        }
      : {},
  )
  await editor.afterApply?.(applied)
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
    closeInlineEditor({ restoreFocus: false })
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
    updateTransportDependentControls()
  },
  onDisconnected: () => {
    state.transportAvailable = false
    setStatus("Session broker offline", "error")
    setRefreshDetail("The loaded matrix remains available; relaunch to restore live reads and writes", "error")
    setWriteReadiness("Session broker offline; the loaded dashboard is read-only")
    updateTransportDependentControls()
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
  const rulesetButton = event.target.closest(".open-ruleset")
  if (rulesetButton) {
    const action = workspaceActionByButton.get(rulesetButton)
    if (!action || action.type !== RULESET_ACTION_KIND.OPEN) {
      toast("The selected ruleset is no longer available", "error")
      return
    }
    openRulesetWorkspace(action)
    return
  }
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
  }
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
  syncEditorFromJson()
})
elements.valueEditorFields.addEventListener("input", updateGeneratedEditorControl)
elements.valueEditorFields.addEventListener("change", changeNullEditorType)
elements.valueEditorFields.addEventListener("change", renameGeneratedEditorObjectKey)
elements.valueEditorFields.addEventListener("click", handleValueEditorAction)
elements.editorDialog.addEventListener("close", () => {
  state.editor = null
})
elements.editorForm.addEventListener("submit", reviewEditorChange)
elements.rulesetSearch.addEventListener("input", () => {
  if (!state.rulesetWorkspace) return
  state.rulesetWorkspace.query = elements.rulesetSearch.value
  state.rulesetWorkspace.limit = RULESET_RULE_PAGE_SIZE
  renderRulesetWorkspace()
})
elements.rulesetStatusFilter.addEventListener("change", () => {
  if (!state.rulesetWorkspace) return
  state.rulesetWorkspace.status = elements.rulesetStatusFilter.value
  state.rulesetWorkspace.limit = RULESET_RULE_PAGE_SIZE
  renderRulesetWorkspace()
})
elements.rulesetLoadMore.addEventListener("click", () => {
  if (!state.rulesetWorkspace) return
  state.rulesetWorkspace.limit += RULESET_RULE_PAGE_SIZE
  renderRulesetWorkspace()
})
elements.rulesetRefresh.addEventListener("click", refreshRulesetWorkspace)
elements.rulesetAddRule.addEventListener("click", () => {
  const workspace = state.rulesetWorkspace
  if (!workspace) return
  openWorkspaceRuleCreateEditor(
    newRuleDefinition(workspace.ruleset),
    `Add rule to ${rulesetWorkspaceTitle(workspace.ruleset)}`,
  )
})
elements.rulesetEditDescription.addEventListener("click", openRulesetDescriptionEditor)
elements.rulesetDelete.addEventListener("click", deleteWorkspaceRuleset)
elements.rulesetConfigureDeployment.addEventListener("click", () => {
  const workspace = state.rulesetWorkspace
  const deployment = workspace?.deployment
  if (!workspace || !deployment) return
  if (readOnly) {
    openRulesetWorkspace({
      kind: deployment.ruleset.kind,
      name: deployment.ruleset.name,
      phase: deployment.ruleset.phase,
      rulesetId: deployment.ruleset.id,
      type: RULESET_ACTION_KIND.OPEN,
      zoneId: workspace.action.zoneId,
    })
    return
  }
  openWorkspaceRuleEditor(deployment.rule, deployment.ruleset)
})
elements.rulesetDialog.addEventListener("close", () => {
  const action = state.rulesetWorkspace?.action
  state.rulesetWorkspace = null
  if (!action) return
  requestAnimationFrame(() => {
    const activeElement = document.activeElement
    if (activeElement === document.body
      || !activeElement?.isConnected
      || elements.rulesetDialog.contains(activeElement)) {
      focusRulesetMatrixOpener(action)
    }
  })
})
elements.rulesetDescriptionDialog.addEventListener("close", () => {
  clearFieldError(
    elements.rulesetDescriptionValue,
    elements.rulesetDescriptionError,
  )
})
elements.rulesetDescriptionForm.addEventListener("submit", reviewRulesetDescription)
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
elements.emailPolicyExceptions.addEventListener("click", openPolicyExceptionDialog)
document.addEventListener("click", followSkipLink)
document.addEventListener("keydown", handleGlobalShortcut)

initialize()
