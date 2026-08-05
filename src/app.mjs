import { contextualActionLabel } from "./accessibility.mjs"
import {
  MATRIX_CAPABILITY,
  MATRIX_CAPABILITY_PRESENTATION,
  matrixCapabilityCounts,
  matrixCategoryCapabilities,
  matrixRowSupportsChanges,
} from "./capabilities.mjs"
import {
  CloudflareApi,
  FleetIntentApiConflictError,
} from "./api.mjs"
import {
  CACHE_MAX_AGE_HOURS,
  CACHE_RECORD_GLOBAL,
  CACHE_SNAPSHOT_GLOBAL,
  cacheRecordIsFresh,
  createCacheRecord,
  isCacheRecord,
} from "./cache.mjs"
import {
  DNSSEC_STATUS,
  EMAIL_POLICY_COMPONENT,
  EMAIL_ROUTING_RULE_IDENTIFIER,
  FLEET_ACTION_KIND,
  HOLE_RESOLUTION_KIND,
  INVENTORY_COVERAGE_KIND,
  MATRIX_CATEGORY,
  matrixCategoryLabel,
  POLICY_EXCEPTION_STATUS,
  RULESET_ACTION_KIND,
  RULESET_KIND,
  SESSION_TITLE,
  STATIC_LIMITATIONS,
  SURFACES,
} from "./constants.mjs"
import {
  configuredEmailPolicyExceptions,
  emailPolicyExceptionsForZone,
} from "./fleet-policy.mjs"
import {
  createAuthoredFleetIntentExpected,
  createEmptyFleetIntentDocument,
  evaluateFleetIntent,
  evaluateFleetIntentCoverage,
  FLEET_INTENT_ACKNOWLEDGEMENT_STATUS,
  FLEET_INTENT_ALL_ZONES_GROUP_ID,
  FLEET_INTENT_CELL_STATUS,
  FLEET_INTENT_COVERAGE_EXPECTATION_STATUS,
  FLEET_INTENT_DOCUMENT_GLOBAL,
  FLEET_INTENT_EXPECTED_ORIGIN,
  FLEET_INTENT_GROUP_MODE,
  FLEET_INTENT_LABEL_MAX_LENGTH,
  FLEET_INTENT_MISSING_CANONICAL,
  FLEET_INTENT_PRESENCE_CONSTRAINT,
  FLEET_INTENT_REASON_MAX_LENGTH,
  FLEET_INTENT_VALUE_CONSTRAINT,
  fleetIntentFacetId,
  fleetIntentCoverageTargetKey,
  fleetIntentExpectedIsAuthored,
  fleetIntentPolicyPresenceConstraint,
  fleetIntentPolicyValueConstraint,
  isFleetIntentDocument,
  removeFleetIntentAcknowledgement,
  removeFleetIntentCoverageExpectation,
  removeFleetIntentGroup,
  removeFleetIntentPolicy,
  replaceFleetIntentAcknowledgement,
  replaceFleetIntentCoverageExpectation,
  replaceFleetIntentGroup,
  replaceFleetIntentPolicy,
} from "./fleet-intent.mjs"
import {
  installDismissibleDialogs,
  showDialog,
} from "./dialogs.mjs"
import {
  dnssecIntentCorrection,
  rowSupportsDnssecIntentCorrection,
} from "./dnssec-intent.mjs"
import {
  coverageFor,
  loadInventory,
  staticCoverageIssues,
} from "./inventory.mjs"
import {
  buildMatrix,
  dnsTargetFillBatch,
  matrixRenderKey,
} from "./matrix.mjs"
import {
  buildIntentAdoptionCandidates,
  INTENT_ADOPTION_CLASSIFICATION,
  INTENT_ADOPTION_CONFIDENCE,
  previewIntentAdoption,
  selectIntentAdoptionGroup,
} from "./intent-adoption.mjs"
import {
  defaultFleetIntentPolicyConstraints,
  fleetIntentPolicyForGroup,
  fleetIntentPolicyGroupSelection,
  firstFleetIntentObservedCanonical,
} from "./intent-defaults.mjs"
import {
  FLEET_INTENT_POLICY_LAYER_PRESENTATION,
  FLEET_INTENT_POLICY_LAYER_ROLE,
  fleetIntentPolicyLayers,
} from "./intent-layering.mjs"
import {
  INTENT_REMEDIATION_KIND,
  INTENT_REMEDIATION_PRESENTATION,
  intentPolicyRemediation,
} from "./intent-remediation.mjs"
import {
  matrixNavigationTarget,
  MATRIX_NAVIGATION_KEYS,
} from "./matrix-navigation.mjs"
import {
  buildInversePlans,
  compareVerificationGuards,
  completeOperationActivity,
  createEmptyOperationActivityDocument,
  createPendingOperationActivity,
  createVerificationGuards,
  isOperationActivityDocument,
  OPERATION_ACTIVITY_STATUS,
} from "./operation-history.mjs"
import {
  DEFAULT_MATRIX_FILTERS,
  DEFAULT_MATRIX_SCOPE,
  DNS_MATRIX_CATEGORIES,
  facetMatchesScope,
  MATRIX_SCOPE,
  matrixColumnIsVisible,
  matrixEmptyMessage,
  matrixFilterChangeCount,
  matrixRowMatchesFilters,
} from "./matrix-filter.mjs"
import {
  buildDnssecStatusPlan,
  buildDnsRecordCopyPlan,
  buildDnsRecordEditPlan,
  buildEmailAlignmentPlan,
  buildEmailRoutingRuleEditPlan,
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
  editableEmailRoutingRulePayload,
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
  redirectTargetKindLabel,
  REDIRECT_STATUS_OPTIONS,
  REDIRECT_TARGET_KIND,
  REDIRECT_TARGET_KIND_ORDER,
} from "./redirect-presentation.mjs"
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
  compareDetailedRulesetRow,
  rulesetParentRowIsReviewable,
  rulesetRowPhase,
} from "./ruleset-comparison.mjs"
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
import {
  compareFleetValueVariants,
  compareFleetRowValues,
  diffValueText,
  groupFleetRowIntentValues,
  VALUE_TEXT_DIFF_KIND,
} from "./value-comparison.mjs"
import {
  assertWriteVerificationResponse,
  verificationTargetsForPlans,
  verificationTargetsForResults,
  WRITE_VERIFICATION_KIND,
} from "./write-verification.mjs"

const auth = window.__CLOUDFLARE_FLEET_AUTH__
delete window.__CLOUDFLARE_FLEET_AUTH__
const injectedCache = window[CACHE_RECORD_GLOBAL]
delete window[CACHE_RECORD_GLOBAL]
delete window[CACHE_SNAPSHOT_GLOBAL]
const injectedIntent = window[FLEET_INTENT_DOCUMENT_GLOBAL]
delete window[FLEET_INTENT_DOCUMENT_GLOBAL]

const fatal = document.querySelector("#fatal")
const application = document.querySelector("#application")

if ((!auth?.apiToken && !auth?.brokerSecret) || !auth?.accountId) {
  fatal.hidden = false
  document.querySelector("#fatal-message").textContent = "Run ./launch.sh so the terminal can create a protected local session from CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID."
  throw new Error("Cloudflare session auth is unavailable")
}

application.dataset.initializing = "true"
application.hidden = false

const api = new CloudflareApi(auth)
const readOnly = Boolean(auth.readOnly)
const cachedRecord = isCacheRecord(injectedCache, auth.accountId) ? injectedCache : null
const initialIntent = isFleetIntentDocument(injectedIntent, auth.accountId)
  ? injectedIntent
  : createEmptyFleetIntentDocument(auth.accountId)
const INVENTORY_SOURCE = Object.freeze({
  CACHE: "cache",
  LIVE: "live",
})
const EMAIL_PREFLIGHT_SURFACE_IDS = READ_ACTION_SURFACES[READ_ACTION.EMAIL_ALIGNMENT]
const DNSSEC_PREFLIGHT_SURFACE_IDS = READ_ACTION_SURFACES[READ_ACTION.DNSSEC_ALIGNMENT]
const WAF_PREFLIGHT_SURFACE_IDS = READ_ACTION_SURFACES[READ_ACTION.WAF_ALIGNMENT]
const LIVE_PLAN_SET = Symbol("live-plan-set")
const MATRIX_CONTROL_SELECTOR = "summary, .cell-action"
const CATEGORY_CHANGE_CAPABILITY_ORDER = Object.freeze([
  MATRIX_CAPABILITY.DIRECT_EDIT,
  MATRIX_CAPABILITY.WORKSPACE_EDIT,
  MATRIX_CAPABILITY.COPY_FILL,
  MATRIX_CAPABILITY.FLEET_RENAME,
  MATRIX_CAPABILITY.INTENT_FIX,
])
const VALUE_COMPARISON_CONTEXT_LENGTH = 84
const VALUE_COMPARISON_ELLIPSIS = "..."
const MATRIX_COMPARISON_STATE = Object.freeze({
  MATCH: "match",
  NO_CONSENSUS: "no-consensus",
  VARIANT: "variant",
})
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"
const COMPACT_FILTER_MEDIA_QUERY = "(max-width: 1179px)"
const COMPACT_TOOLBAR_MEDIA_QUERY = "(max-width: 620px)"
const MATRIX_FOCUS_CLASS = "matrix-focus"
const MATRIX_COLUMN_HIDDEN_CLASS = "matrix-column-hidden"
const COVERAGE_SECTION = Object.freeze({
  EXPECTED: "expected",
  HEALTHY: "healthy",
  UNEXPECTED: "unexpected",
})
const SKIP_LINK_SELECTOR = ".skip-links a, .keyboard-skip"
const COMPACT_RULE_TEXT_LIMIT = 120
const EDITABLE_OBJECT_KEY_FIELDS = new Set([
  "headers",
])
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const RULESET_RULE_PREVIEW_LIMIT = 220
const TOAST_SUCCESS_TIMEOUT_MS = 7000
const INTENT_SYNC_INTERVAL_MS = 5000
const ACTIVITY_FILTER = Object.freeze({
  ALL: "all",
  FAILED: "failed",
  PENDING: "pending",
  UNDOABLE: "undoable",
})
const ACTIVITY_STATUS_LABEL = Object.freeze({
  [OPERATION_ACTIVITY_STATUS.PENDING]: "Incomplete",
  [OPERATION_ACTIVITY_STATUS.VERIFICATION_FAILED]: "Verification failed",
  [OPERATION_ACTIVITY_STATUS.VERIFIED]: "Verified",
  [OPERATION_ACTIVITY_STATUS.WRITE_FAILED]: "Write failed",
})
const INTENT_ZONE_SUMMARY_LIMIT = 3
const INTENT_POLICY_LAYER_ORDER = Object.freeze({
  [FLEET_INTENT_POLICY_LAYER_ROLE.BASELINE]: 0,
  [FLEET_INTENT_POLICY_LAYER_ROLE.STANDALONE]: 0,
  [FLEET_INTENT_POLICY_LAYER_ROLE.OVERLAP]: 1,
  [FLEET_INTENT_POLICY_LAYER_ROLE.REFINEMENT]: 1,
})
const INTENT_POLICY_VALUE_MODE = Object.freeze({
  CUSTOM: "custom",
  OBSERVED: "observed",
})
const INTENT_ADOPTION_FILTER = Object.freeze({
  HIGH: "high",
  MISSING: "missing",
  REVIEW: "review",
  ZONE_SPECIFIC: "zone-specific",
})
const INTENT_ADOPTION_CREATE_GROUP_VALUE = ""
const INTENT_ADOPTION_CLASSIFICATION_PRESENTATION = Object.freeze({
  [INTENT_ADOPTION_CLASSIFICATION.MISSING_COVERAGE]: Object.freeze({
    label: "Sparse coverage",
    status: "allowance",
  }),
  [INTENT_ADOPTION_CLASSIFICATION.SPLIT_CONSENSUS]: Object.freeze({
    label: "Close split",
    status: "compare-only",
  }),
  [INTENT_ADOPTION_CLASSIFICATION.STRONG_CONSENSUS]: Object.freeze({
    label: "Clear present consensus",
    status: "aligned",
  }),
  [INTENT_ADOPTION_CLASSIFICATION.TIED_VARIANTS]: Object.freeze({
    label: "Tied variants",
    status: "compare-only",
  }),
  [INTENT_ADOPTION_CLASSIFICATION.ZONE_SPECIFIC]: Object.freeze({
    label: "Zone-specific values",
    status: "compare-only",
  }),
})
const INTENT_ADOPTION_CONSTRAINT_LABEL = Object.freeze({
  [FLEET_INTENT_VALUE_CONSTRAINT.EXACT]: "Exact value",
  [FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER]: "May differ",
  [FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER]: "Must differ",
})
const INTENT_ADOPTION_PRESENCE_LABEL = Object.freeze({
  [FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN]: "Forbidden",
  [FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL]: "Optional by zone",
  [FLEET_INTENT_PRESENCE_CONSTRAINT.REQUIRED]: "Required",
})
const INTENT_PRESENCE_OPTIONS = Object.freeze([
  FLEET_INTENT_PRESENCE_CONSTRAINT.REQUIRED,
  FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL,
  FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN,
])
const REDIRECT_FROM_VALUE_PATH = Object.freeze([
  "action_parameters",
  "from_value",
])
const REDIRECT_QUERY_CHOICE = Object.freeze({
  DROP: "drop",
  KEEP: "keep",
  UNSPECIFIED: "unspecified",
})
const REDIRECT_PRIMARY_RULE_FIELDS = new Set([
  "action",
  "action_parameters",
  "description",
  "enabled",
  "expression",
  "ref",
])
const SURFACE_BY_ID = new Map(SURFACES.map((surface) => [surface.id, surface]))
const DNS_MATRIX_CATEGORY_SET = new Set(DNS_MATRIX_CATEGORIES)
const compactFilterMedia = window.matchMedia(COMPACT_FILTER_MEDIA_QUERY)
const compactToolbarMedia = window.matchMedia(COMPACT_TOOLBAR_MEDIA_QUERY)
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
  activity: createEmptyOperationActivityDocument(),
  activityGuardFailures: new Map(),
  activityLoading: false,
  busy: false,
  busyFocus: null,
  coverageEvaluation: null,
  coverageExpanded: {
    [COVERAGE_SECTION.EXPECTED]: false,
    [COVERAGE_SECTION.HEALTHY]: false,
    [COVERAGE_SECTION.UNEXPECTED]: true,
  },
  coverageIntentDraft: null,
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
  intent: initialIntent,
  intentAcknowledgementDraft: null,
  intentAdoptionDraft: null,
  intentDeleteDraft: null,
  intentEvaluation: null,
  intentGroupDraft: null,
  intentPolicyDraft: null,
  intentSaving: false,
  intentSyncing: false,
  filterPanelExpanded: false,
  matrixFocusScrollY: 0,
  ruleRename: null,
  rulesetComparisonRowKey: null,
  rulesetWorkspace: null,
  selectedColumnsOnly: false,
  selectedZoneIds: new Set(),
  startupCacheLoadedAt: null,
  toastTimer: null,
  transportAvailable: true,
  valueComparisonRowKey: null,
  wafPolicies: null,
}
const editActionByCell = new WeakMap()
const fillActionByCell = new WeakMap()
const bulkFillRowByButton = new WeakMap()
const fleetActionByButton = new WeakMap()
const workspaceActionByButton = new WeakMap()
const intentCellActionByButton = new WeakMap()
const intentCorrectionByButton = new WeakMap()
const intentPolicyRowByButton = new WeakMap()
const rulesetComparisonRowByButton = new WeakMap()
const valueComparisonRowByButton = new WeakMap()
const activityEntryByButton = new WeakMap()

const elements = {
  activityCount: document.querySelector("#activity-count"),
  activityDialog: document.querySelector("#activity-dialog"),
  activityFilter: document.querySelector("#activity-filter"),
  activityList: document.querySelector("#activity-list"),
  activityLoadError: document.querySelector("#activity-load-error"),
  activityRefresh: document.querySelector("#activity-refresh"),
  activitySummary: document.querySelector("#activity-summary"),
  activityVisibleCount: document.querySelector("#activity-visible-count"),
  alignEmail: document.querySelector("#align-email"),
  alignWaf: document.querySelector("#align-waf"),
  category: document.querySelector("#category"),
  categoryCapabilityBadges: document.querySelector("#category-capability-badges"),
  categoryCapabilityDetail: document.querySelector("#category-capability-detail"),
  categoryCapabilityTitle: document.querySelector("#category-capability-title"),
  changeSupportToggle: document.querySelector("#change-support-toggle"),
  chooseTargets: document.querySelector("#choose-targets"),
  clearSelection: document.querySelector("#clear-selection"),
  confirmApply: document.querySelector("#confirm-apply"),
  confirmCheck: document.querySelector("#confirm-check"),
  confirmDialog: document.querySelector("#confirm-dialog"),
  confirmOperations: document.querySelector("#confirm-operations"),
  confirmPreview: document.querySelector("#confirm-preview"),
  confirmSummary: document.querySelector("#confirm-summary"),
  confirmTitle: document.querySelector("#confirm-title"),
  configurationHeading: document.querySelector("#configuration-heading"),
  coverageExpectedCount: document.querySelector("#coverage-expected-count"),
  coverageExpectedList: document.querySelector("#coverage-expected-list"),
  coverageExpectedToggle: document.querySelector("#coverage-expected-toggle"),
  coverageGroups: document.querySelector("#coverage-groups"),
  coverageHealthyCount: document.querySelector("#coverage-healthy-count"),
  coverageHealthyList: document.querySelector("#coverage-healthy-list"),
  coverageHealthyToggle: document.querySelector("#coverage-healthy-toggle"),
  coverageIntentDialog: document.querySelector("#coverage-intent-dialog"),
  coverageIntentError: document.querySelector("#coverage-intent-error"),
  coverageIntentForm: document.querySelector("#coverage-intent-form"),
  coverageIntentPreview: document.querySelector("#coverage-intent-preview"),
  coverageIntentReason: document.querySelector("#coverage-intent-reason"),
  coverageIntentRemove: document.querySelector("#coverage-intent-remove"),
  coverageIntentSave: document.querySelector("#coverage-intent-save"),
  coverageIntentTarget: document.querySelector("#coverage-intent-target"),
  coverageIntentTitle: document.querySelector("#coverage-intent-title"),
  coverageSummary: document.querySelector("#coverage-summary"),
  coverageUnexpectedCount: document.querySelector("#coverage-unexpected-count"),
  coverageUnexpectedList: document.querySelector("#coverage-unexpected-list"),
  coverageUnexpectedToggle: document.querySelector("#coverage-unexpected-toggle"),
  differenceToggle: document.querySelector("#difference-toggle"),
  dnsType: document.querySelector("#dns-type"),
  dnssecWorkflowDetail: document.querySelector("#dnssec-workflow-detail"),
  dnssecWorkflowState: document.querySelector("#dnssec-workflow-state"),
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
  filterPanelToggle: document.querySelector("#filter-panel-toggle"),
  filterReset: document.querySelector("#filter-reset"),
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
  intentAcknowledgementDialog: document.querySelector("#intent-acknowledgement-dialog"),
  intentAcknowledgementError: document.querySelector("#intent-acknowledgement-error"),
  intentAcknowledgementForm: document.querySelector("#intent-acknowledgement-form"),
  intentAcknowledgementPreview: document.querySelector("#intent-acknowledgement-preview"),
  intentAcknowledgementReason: document.querySelector("#intent-acknowledgement-reason"),
  intentAcknowledgementTarget: document.querySelector("#intent-acknowledgement-target"),
  intentAcknowledgementList: document.querySelector("#intent-acknowledgement-list"),
  intentAdoptionAddGroup: document.querySelector("#intent-adoption-add-group"),
  intentAdoptionCategory: document.querySelector("#intent-adoption-category"),
  intentAdoptionClear: document.querySelector("#intent-adoption-clear"),
  intentAdoptionDialog: document.querySelector("#intent-adoption-dialog"),
  intentAdoptionError: document.querySelector("#intent-adoption-error"),
  intentAdoptionImpactMetrics: document.querySelector("#intent-adoption-impact-metrics"),
  intentAdoptionImpactSummary: document.querySelector("#intent-adoption-impact-summary"),
  intentAdoptionImpactTitle: document.querySelector("#intent-adoption-impact-title"),
  intentAdoptionList: document.querySelector("#intent-adoption-list"),
  intentAdoptionPattern: document.querySelector("#intent-adoption-pattern"),
  intentAdoptionSave: document.querySelector("#intent-adoption-save"),
  intentAdoptionSearch: document.querySelector("#intent-adoption-search"),
  intentAdoptionSelectClear: document.querySelector("#intent-adoption-select-clear"),
  intentAdoptionVisible: document.querySelector("#intent-adoption-visible"),
  intentAddGroup: document.querySelector("#intent-add-group"),
  intentDeleteApply: document.querySelector("#intent-delete-apply"),
  intentDeleteDialog: document.querySelector("#intent-delete-dialog"),
  intentDeleteForm: document.querySelector("#intent-delete-form"),
  intentDeleteSummary: document.querySelector("#intent-delete-summary"),
  intentDeleteTitle: document.querySelector("#intent-delete-title"),
  intentDialog: document.querySelector("#intent-dialog"),
  intentGroupClear: document.querySelector("#intent-group-clear"),
  intentGroupDialog: document.querySelector("#intent-group-dialog"),
  intentGroupError: document.querySelector("#intent-group-error"),
  intentGroupForm: document.querySelector("#intent-group-form"),
  intentGroupList: document.querySelector("#intent-group-list"),
  intentGroupMembers: document.querySelector("#intent-group-members"),
  intentGroupName: document.querySelector("#intent-group-name"),
  intentGroupSelectAll: document.querySelector("#intent-group-select-all"),
  intentGroupSelectionAnnouncement: document.querySelector("#intent-group-selection-announcement"),
  intentGroupSelectionSummary: document.querySelector("#intent-group-selection-summary"),
  intentGroupTitle: document.querySelector("#intent-group-title"),
  intentCoverageList: document.querySelector("#intent-coverage-list"),
  intentMetrics: document.querySelector("#intent-metrics"),
  intentPolicyDetail: document.querySelector("#intent-policy-detail"),
  intentPolicyDialog: document.querySelector("#intent-policy-dialog"),
  intentPolicyCustomEditor: document.querySelector("#intent-policy-custom-editor"),
  intentPolicyCustomFields: document.querySelector("#intent-policy-custom-fields"),
  intentPolicyCustomJson: document.querySelector("#intent-policy-custom-json"),
  intentPolicyCustomKind: document.querySelector("#intent-policy-custom-kind"),
  intentPolicyCustomRaw: document.querySelector("#intent-policy-custom-raw"),
  intentPolicyConstraintExact: document.querySelector("#intent-policy-constraint-exact"),
  intentPolicyConstraintMayDiffer: document.querySelector("#intent-policy-constraint-may-differ"),
  intentPolicyConstraintMustDiffer: document.querySelector("#intent-policy-constraint-must-differ"),
  intentPolicyDrift: document.querySelector("#intent-policy-drift"),
  intentPolicyError: document.querySelector("#intent-policy-error"),
  intentPolicyExactFields: document.querySelector("#intent-policy-exact-fields"),
  intentPolicyForm: document.querySelector("#intent-policy-form"),
  intentPolicyAddGroup: document.querySelector("#intent-policy-add-group"),
  intentPolicyGroup: document.querySelector("#intent-policy-group"),
  intentPolicyList: document.querySelector("#intent-policy-list"),
  intentPolicyModeCustom: document.querySelector("#intent-policy-mode-custom"),
  intentPolicyModeObserved: document.querySelector("#intent-policy-mode-observed"),
  intentPolicyComplete: document.querySelector("#intent-policy-complete"),
  intentPolicyDifferences: document.querySelector("#intent-policy-differences"),
  intentPolicyObservedFields: document.querySelector("#intent-policy-observed-fields"),
  intentPolicyOverlap: document.querySelector("#intent-policy-overlap"),
  intentPolicyPreview: document.querySelector("#intent-policy-preview"),
  intentPolicyPresenceForbidden: document.querySelector("#intent-policy-presence-forbidden"),
  intentPolicyPresenceOptional: document.querySelector("#intent-policy-presence-optional"),
  intentPolicyPresenceRequired: document.querySelector("#intent-policy-presence-required"),
  intentPolicyRaw: document.querySelector("#intent-policy-raw"),
  intentPolicyRemediation: document.querySelector("#intent-policy-remediation"),
  intentPolicyReview: document.querySelector("#intent-policy-review"),
  intentPolicySave: document.querySelector("#intent-policy-save"),
  intentPolicyScope: document.querySelector("#intent-policy-scope"),
  intentPolicyTarget: document.querySelector("#intent-policy-target"),
  intentPolicyTitle: document.querySelector("#intent-policy-title"),
  intentPolicyValues: document.querySelector("#intent-policy-values"),
  intentPolicyValueRelationship: document.querySelector("#intent-policy-value-relationship"),
  intentReviewUngoverned: document.querySelector("#intent-review-ungoverned"),
  intentSummary: document.querySelector("#intent-summary"),
  loadProgress: document.querySelector("#load-progress"),
  manageIntent: document.querySelector("#manage-intent"),
  matrixBody: document.querySelector("#matrix-body"),
  matrixChooseTargets: document.querySelector("#matrix-choose-targets"),
  matrixEmpty: document.querySelector("#matrix-empty"),
  matrixFocus: document.querySelector("#matrix-focus"),
  matrixGuide: document.querySelector(".matrix-guide"),
  matrixShell: document.querySelector("#matrix-shell"),
  matrixTable: document.querySelector("#matrix"),
  mobileMatrixFocus: document.querySelector("#mobile-matrix-focus"),
  matrixHead: document.querySelector("#matrix-head"),
  policyExceptionDialog: document.querySelector("#policy-exception-dialog"),
  policyExceptionList: document.querySelector("#policy-exception-list"),
  policyExceptionRaw: document.querySelector("#policy-exception-raw"),
  policyExceptionSummary: document.querySelector("#policy-exception-summary"),
  refresh: document.querySelector("#refresh"),
  refreshDetail: document.querySelector("#refresh-detail"),
  redirectType: document.querySelector("#redirect-type"),
  reviewNeedsAttention: document.querySelector("#review-needs-attention"),
  reviewTaskCount: document.querySelector("#review-task-count"),
  reviewTaskLabel: document.querySelector("#review-task-label"),
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
  rulesetComparisonAllowDifferences: document.querySelector("#ruleset-comparison-allow-differences"),
  rulesetComparisonDialog: document.querySelector("#ruleset-comparison-dialog"),
  rulesetComparisonGroups: document.querySelector("#ruleset-comparison-groups"),
  rulesetComparisonIntent: document.querySelector("#ruleset-comparison-intent"),
  rulesetComparisonMetrics: document.querySelector("#ruleset-comparison-metrics"),
  rulesetComparisonShowRules: document.querySelector("#ruleset-comparison-show-rules"),
  rulesetComparisonSummary: document.querySelector("#ruleset-comparison-summary"),
  rulesetComparisonTitle: document.querySelector("#ruleset-comparison-title"),
  rulesetComparisonUseBaseline: document.querySelector("#ruleset-comparison-use-baseline"),
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
  selectedColumnsOnly: document.querySelector("#selected-columns-only"),
  selectionCount: document.querySelector("#selection-count"),
  sessionMode: document.querySelector("#session-mode"),
  showDnssecWorkflow: document.querySelector("#show-dnssec-workflow"),
  showSupportedChanges: document.querySelector("#show-supported-changes"),
  showActivity: document.querySelector("#show-activity"),
  snapshotTime: document.querySelector("#snapshot-time"),
  scope: document.querySelector("#scope"),
  statusDot: document.querySelector("#status-dot"),
  statusText: document.querySelector("#status-text"),
  supportedChangeCount: document.querySelector("#supported-change-count"),
  supportedChangeLabel: document.querySelector("#supported-change-label"),
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
  toolbarSecondary: document.querySelector("#toolbar-secondary"),
  valueEditor: document.querySelector("#value-editor"),
  valueEditorContext: document.querySelector("#value-editor-context"),
  valueEditorFields: document.querySelector("#value-editor-fields"),
  valueComparisonComplete: document.querySelector("#value-comparison-complete"),
  valueComparisonCompleteGrid: document.querySelector("#value-comparison-complete-grid"),
  valueComparisonDifferences: document.querySelector("#value-comparison-differences"),
  valueComparisonDifferenceSummary: document.querySelector("#value-comparison-difference-summary"),
  valueComparisonDialog: document.querySelector("#value-comparison-dialog"),
  valueComparisonGroups: document.querySelector("#value-comparison-groups"),
  valueComparisonMetrics: document.querySelector("#value-comparison-metrics"),
  valueComparisonSummary: document.querySelector("#value-comparison-summary"),
  valueComparisonTitle: document.querySelector("#value-comparison-title"),
  visibleCount: document.querySelector("#visible-count"),
  wafPolicyDetail: document.querySelector("#waf-policy-detail"),
  wafPolicyDrift: document.querySelector("#waf-policy-drift"),
  writePanel: document.querySelector("#write-panel"),
  writeReadiness: document.querySelector("#write-readiness"),
  writeSelectionSummary: document.querySelector("#write-selection-summary"),
  zoneCount: document.querySelector("#zone-count"),
}

elements.intentGroupName.maxLength = FLEET_INTENT_LABEL_MAX_LENGTH
elements.intentAcknowledgementReason.maxLength = FLEET_INTENT_REASON_MAX_LENGTH
elements.coverageIntentReason.maxLength = FLEET_INTENT_REASON_MAX_LENGTH
elements.intentPolicyCustomKind.replaceChildren(...Object.values(JSON_VALUE_KIND).map((kind) => {
  const option = createElement("option", { text: humanizeValueField(kind) })
  option.value = kind
  return option
}))
elements.sessionMode.textContent = readOnly ? "Read-only session" : "Read/write session"
elements.writePanel.classList.toggle("read-only", readOnly)
elements.writeReadiness.textContent = readOnly
  ? "Read-only session; relaunch with write access to apply changes"
  : "Loading live state; writes are locked"
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
  if (elements.activityDialog.open) renderOperationActivity()
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
    setRefreshDetail()
    setWriteReadiness(
      "Writes live-validated before confirmation",
      "cached",
    )
    return
  }

  setStatus("Fleet loaded", "ready")
  setRefreshDetail()
  setWriteReadiness(
    "Writes revalidated live before confirmation",
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

function intentMutationSupported() {
  return !readOnly && api.usesBroker
}

function intentWritable() {
  return intentMutationSupported()
    && !state.busy
    && state.transportAvailable
    && !state.intentSaving
}

function intentId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`
}

function intentGroupById(groupId) {
  return state.intent.groups.find((group) => group.id === groupId) || null
}

function intentGroupScope(group) {
  const loadedZones = (state.inventory?.zones || []).map((zone) => ({
    unavailable: false,
    zoneId: zone.meta.id,
    zoneName: zone.meta.name,
  }))
  if (!group) {
    return {
      applies: [],
      excludes: loadedZones,
    }
  }
  if (group.mode === FLEET_INTENT_GROUP_MODE.ALL) {
    return {
      applies: loadedZones,
      excludes: [],
    }
  }
  const loadedById = new Map(loadedZones.map((zone) => [zone.zoneId, zone]))
  const memberIds = new Set(group.members.map((member) => member.zoneId))
  const applies = group.members.map((member) => loadedById.get(member.zoneId) || {
    unavailable: true,
    zoneId: member.zoneId,
    zoneName: member.zoneName,
  })
  applies.sort((left, right) => left.zoneName.localeCompare(right.zoneName))
  return {
    applies,
    excludes: loadedZones.filter((zone) => !memberIds.has(zone.zoneId)),
  }
}

function intentZoneName(zone) {
  return zone.unavailable
    ? `${zone.zoneName} (unavailable)`
    : zone.zoneName
}

function intentZoneSummary(zones) {
  if (zones.length === 0) return "No zones"
  const visible = zones.slice(0, INTENT_ZONE_SUMMARY_LIMIT).map(intentZoneName)
  const remainder = zones.length - visible.length
  return remainder > 0
    ? `${visible.join(", ")} +${remainder} more`
    : visible.join(", ")
}

function intentGroupPrimaryText(group, scope = intentGroupScope(group)) {
  return group?.mode === FLEET_INTENT_GROUP_MODE.ALL
    ? "Every loaded zone"
    : intentZoneSummary(scope.applies)
}

function intentZoneScopeRow(label, zones, emptyText) {
  const row = createElement("div", { className: "intent-zone-scope-row" })
  row.append(
    createElement("strong", { text: label }),
    createElement("span", {
      text: zones.length > 0
        ? zones.map(intentZoneName).join(", ")
        : emptyText,
    }),
  )
  return row
}

function renderIntentZoneScope(container, scope, options = {}) {
  const rows = [
    intentZoneScopeRow("Applies to", scope.applies, "No zones selected"),
    intentZoneScopeRow("Does not apply to", scope.excludes, "None"),
  ]
  if (options.groupName) {
    const label = createElement("div", { className: "intent-zone-group-label" })
    label.append(
      createElement("strong", { text: "Group label" }),
      createElement("span", { text: options.groupName }),
    )
    rows.push(label)
  }
  container.replaceChildren(...rows)
}

function renderIntentPolicyGroupScope() {
  const group = intentGroupById(elements.intentPolicyGroup.value)
  renderIntentZoneScope(elements.intentPolicyScope, intentGroupScope(group), {
    groupName: group?.name || "Missing group",
  })
}

function renderIntentPolicyGroupOptions(selectedGroupId, policies = []) {
  elements.intentPolicyGroup.replaceChildren(...state.intent.groups.map((group) => {
    const scope = intentGroupScope(group)
    const policy = fleetIntentPolicyForGroup(policies, group.id)
    const option = createElement("option", {
      text: [
        intentGroupPrimaryText(group, scope),
        `Group: ${group.name}`,
        policy
          ? `Configured: ${intentPolicyConstraintLabel(policy)}`
          : "Not configured",
      ].join(" | "),
    })
    option.value = group.id
    return option
  }))
  const fallbackGroupId = state.intent.groups.some(
    (group) => group.id === selectedGroupId,
  )
    ? selectedGroupId
    : FLEET_INTENT_ALL_ZONES_GROUP_ID
  elements.intentPolicyGroup.value = fallbackGroupId
  renderIntentPolicyGroupScope()
}

function intentPolicyById(policyId) {
  return state.intent.policies.find((policy) => policy.id === policyId) || null
}

function intentRowState(row) {
  return state.intentEvaluation?.rowStates.get(
    fleetIntentFacetId(row.category, row.key),
  ) || null
}

function workflowOrIntentDriftZoneIds() {
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

function createRawValueDetails(value, label = "Show raw JSON") {
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

function createRedirectBadge(text, className = "", title = "") {
  const badge = createElement("span", {
    className: `redirect-badge${className ? ` ${className}` : ""}`,
    text,
  })
  if (title) badge.title = title
  return badge
}

function createRedirectBadges(redirect, options = {}) {
  const badges = createElement("span", { className: "redirect-badges" })
  const responseText = options.compact && redirect.statusCode !== null
    ? String(redirect.statusCode)
    : redirect.responseLabel
  badges.append(
    ...(redirect.position === null
      ? []
      : [createRedirectBadge(`Order ${redirect.position}`, "position")]),
    createRedirectBadge(
      redirect.targetKindLabel,
      `target-${redirect.targetKind}`,
    ),
    createRedirectBadge(responseText, "response", redirect.responseLabel),
    createRedirectBadge(redirect.queryLabel, "query"),
  )
  if (!redirect.enabled || !options.compact) {
    badges.append(createRedirectBadge(
      redirect.enabledLabel,
      redirect.enabled ? "enabled" : "disabled",
    ))
  }
  return badges
}

function createRedirectFlow(redirect, options = {}) {
  const root = createElement("div", {
    className: `redirect-flow${options.compact ? " compact" : ""}`,
  })
  const route = createElement("div", { className: "redirect-route" })
  const match = createElement("div", { className: "redirect-node match" })
  const target = createElement("div", {
    className: `redirect-node target target-${redirect.targetKind}`,
  })
  const matchValue = createElement("code", { text: redirect.match || "Every request" })
  const targetValue = createElement("code", { text: redirect.target })
  matchValue.title = redirect.match || "Every request"
  targetValue.title = redirect.target
  match.append(
    createElement("span", { text: "When request matches" }),
    matchValue,
  )
  target.append(
    createElement("span", { text: redirect.targetKindLabel }),
    targetValue,
  )
  const arrow = createElement("span", {
    className: "redirect-arrow",
    text: "\u2192",
  })
  arrow.setAttribute("aria-hidden", "true")
  route.append(
    match,
    arrow,
    target,
  )
  root.append(route, createRedirectBadges(redirect, options))
  return root
}

function createRedirectCellSummary(redirect, ruleName = "", rowName = "") {
  const summary = document.createElement("summary")
  summary.className = "redirect-cell-summary"
  const target = createElement("span", { className: "redirect-cell-target" })
  target.append(
    createElement("span", { text: "To" }),
    createElement("code", { text: redirect.target }),
  )
  target.lastElementChild.title = redirect.target
  summary.append(target)
  if (ruleName && ruleName !== rowName) {
    const name = createElement("span", { className: "redirect-cell-name" })
    name.append(
      createElement("span", { text: "Rule name" }),
      createElement("strong", { text: ruleName }),
    )
    summary.append(name)
  }
  summary.append(createRedirectBadges(redirect, { compact: true }))
  return summary
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
  if (presentation.redirect) {
    root.append(createRedirectFlow(presentation.redirect, options))
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
  const redirect = presentRule(rule, workspace.ruleset.phase).redirect
  if (redirect) {
    preview.classList.add("redirect-preview")
    preview.append(createRedirectFlow(redirect, { compact: true }))
    return preview
  }
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
    createRawValueDetails(rule),
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

function zoneApiPath(zoneId, ...segments) {
  return ["zones", zoneId, ...segments].map(encodeURIComponent).join("/")
}

function updateInventoryZone(inventory, zoneId, update) {
  let found = false
  const zones = inventory.zones.map((zone) => {
    if (zone.meta.id !== zoneId) return zone
    found = true
    return update(zone)
  })
  if (!found) throw new Error(`Verified zone ${zoneId} is absent from the fleet snapshot`)
  return {
    ...inventory,
    zones,
  }
}

function verifiedSurface(previous, response) {
  return {
    ...previous,
    ok: true,
    result: response.result,
    status: response.status,
  }
}

function inventoryWithVerifiedSurface(inventory, target, response) {
  return updateInventoryZone(inventory, target.zoneId, (zone) => ({
    ...zone,
    surfaces: {
      ...zone.surfaces,
      [target.surfaceId]: verifiedSurface(
        zone.surfaces[target.surfaceId],
        response,
      ),
    },
  }))
}

function inventoryWithVerifiedSetting(inventory, target, response) {
  const setting = response.result
  if (!setting || setting.id !== target.settingId) {
    throw new Error(`Setting verification returned no ${target.settingId} definition`)
  }
  return updateInventoryZone(inventory, target.zoneId, (zone) => {
    const settings = zone.surfaces.settings?.result
    if (!Array.isArray(settings)) {
      throw new Error("The cached zone settings surface is unavailable")
    }
    const found = settings.some((candidate) => candidate.id === target.settingId)
    if (!found) throw new Error(`The cached ${target.settingId} setting is unavailable`)
    return {
      ...zone,
      surfaces: {
        ...zone.surfaces,
        settings: verifiedSurface(
          zone.surfaces.settings,
          {
            result: settings.map((candidate) => (
              candidate.id === target.settingId ? setting : candidate
            )),
            status: response.status,
          },
        ),
      },
    }
  })
}

function inventoryWithVerifiedDnsRecord(inventory, target, response) {
  const record = response.result
  if (!record || record.id !== target.recordId) {
    throw new Error(`DNS verification returned no ${target.recordId} record`)
  }
  return updateInventoryZone(inventory, target.zoneId, (zone) => {
    const records = zone.surfaces.dns?.result
    if (!Array.isArray(records)) {
      throw new Error("The cached DNS surface is unavailable")
    }
    const found = records.some((candidate) => candidate.id === target.recordId)
    const nextRecords = found
      ? records.map((candidate) => (
          candidate.id === target.recordId ? record : candidate
        ))
      : [...records, record]
    return {
      ...zone,
      surfaces: {
        ...zone.surfaces,
        dns: verifiedSurface(
          zone.surfaces.dns,
          {
            result: nextRecords,
            status: response.status,
          },
        ),
      },
    }
  })
}

function inventoryWithVerifiedEmailRule(inventory, target, response) {
  const rule = response.result
  if (!rule || typeof rule !== "object") {
    throw new Error("Email Routing verification returned no rule definition")
  }
  const catchAll = target.ruleIdentifier === EMAIL_ROUTING_RULE_IDENTIFIER.CATCH_ALL
  return updateInventoryZone(inventory, target.zoneId, (zone) => {
    const surfaces = {
      ...zone.surfaces,
    }
    if (catchAll) {
      surfaces["email-catch-all"] = verifiedSurface(
        zone.surfaces["email-catch-all"],
        response,
      )
    }
    const rulesSurface = zone.surfaces["email-rules"]
    if (rulesSurface?.ok && Array.isArray(rulesSurface.result)) {
      const matches = (candidate) => catchAll
        ? candidate.id === rule.id
          || candidate.matchers?.some((matcher) => matcher.type === "all")
        : candidate.id === target.ruleIdentifier
      const found = rulesSurface.result.some(matches)
      surfaces["email-rules"] = verifiedSurface(
        rulesSurface,
        {
          result: found
            ? rulesSurface.result.map((candidate) => (
                matches(candidate) ? rule : candidate
              ))
            : [...rulesSurface.result, rule],
          status: response.status,
        },
      )
    }
    return {
      ...zone,
      surfaces,
    }
  })
}

function inventoryWithVerifiedRuleset(inventory, target, response) {
  const ruleset = normalizeRulesetDetail(response.result)
  if (!ruleset || ruleset.id !== target.rulesetId) {
    throw new Error(`Ruleset verification returned no ${target.rulesetId} definition`)
  }
  return updateInventoryZone(inventory, target.zoneId, (zone) => {
    const summaries = zone.surfaces.rulesets?.result || []
    const nextDetails = zone.ruleDetails.filter(
      (detail) => !detail.ok || detail.result.id !== target.rulesetId,
    )
    if (rulesetIsEditable(ruleset)) {
      nextDetails.push({
        ok: true,
        phase: ruleset.phase,
        result: ruleset,
        status: response.status,
      })
    }
    return {
      ...zone,
      ruleDetails: nextDetails,
      surfaces: {
        ...zone.surfaces,
        rulesets: verifiedSurface(
          zone.surfaces.rulesets,
          {
            result: [
              ...summaries.filter((entry) => entry.id !== target.rulesetId),
              rulesetSurfaceSummary(ruleset),
            ],
            status: response.status,
          },
        ),
      },
    }
  })
}

function inventoryWithVerifiedRulesetDeletion(inventory, target, response) {
  const summaries = response.result
  if (!Array.isArray(summaries)) {
    throw new TypeError("Ruleset deletion verification returned no ruleset list")
  }
  if (summaries.some((ruleset) => ruleset.id === target.rulesetId)) {
    throw new Error("Cloudflare still reports the deleted ruleset")
  }
  return updateInventoryZone(inventory, target.zoneId, (zone) => ({
    ...zone,
    ruleDetails: zone.ruleDetails.filter(
      (detail) => !detail.ok || detail.result.id !== target.rulesetId,
    ),
    surfaces: {
      ...zone.surfaces,
      rulesets: verifiedSurface(zone.surfaces.rulesets, response),
    },
  }))
}

function inventoryWithVerifiedRulesetPhase(inventory, target, response) {
  const summaries = response.result?.summaries
  const details = response.result?.details
  if (!Array.isArray(summaries) || !Array.isArray(details)) {
    throw new TypeError("Ruleset phase verification returned incomplete state")
  }
  const kinds = new Set(target.kinds)
  return updateInventoryZone(inventory, target.zoneId, (zone) => ({
    ...zone,
    ruleDetails: [
      ...zone.ruleDetails.filter((detail) => {
        const phase = detail.result?.phase || detail.phase
        const kind = detail.result?.kind
        return phase !== target.phase || (kind && !kinds.has(kind))
      }),
      ...details.map((ruleset) => ({
        ok: true,
        phase: ruleset.phase,
        result: normalizeRulesetDetail(ruleset),
        status: response.status,
      })),
    ],
    surfaces: {
      ...zone.surfaces,
      rulesets: verifiedSurface(
        zone.surfaces.rulesets,
        {
          result: summaries,
          status: response.status,
        },
      ),
    },
  }))
}

async function readWriteVerificationTarget(target) {
  if (target.kind === WRITE_VERIFICATION_KIND.SURFACE) {
    const surface = SURFACE_BY_ID.get(target.surfaceId)
    if (!surface) throw new Error(`Unknown verification surface ${target.surfaceId}`)
    const response = await api.request(surface.path(target.zoneId))
    assertWriteVerificationResponse(target, response)
    return {
      response,
      target,
    }
  }
  if (target.kind === WRITE_VERIFICATION_KIND.SETTING) {
    return {
      response: await api.request(
        zoneApiPath(target.zoneId, "settings", target.settingId),
      ),
      target,
    }
  }
  if (target.kind === WRITE_VERIFICATION_KIND.DNS_RECORD) {
    return {
      response: await api.request(
        zoneApiPath(target.zoneId, "dns_records", target.recordId),
      ),
      target,
    }
  }
  if (target.kind === WRITE_VERIFICATION_KIND.EMAIL_RULE) {
    return {
      response: await api.request(zoneApiPath(
        target.zoneId,
        "email",
        "routing",
        "rules",
        target.ruleIdentifier,
      )),
      target,
    }
  }
  if (target.kind === WRITE_VERIFICATION_KIND.RULESET) {
    return {
      response: await api.request(
        zoneApiPath(target.zoneId, "rulesets", target.rulesetId),
      ),
      target,
    }
  }
  if (target.kind === WRITE_VERIFICATION_KIND.RULESET_DELETION) {
    return {
      response: await api.request(zoneApiPath(target.zoneId, "rulesets")),
      target,
    }
  }
  if (target.kind === WRITE_VERIFICATION_KIND.RULESET_PHASE) {
    const summariesResponse = await api.request(
      zoneApiPath(target.zoneId, "rulesets"),
    )
    if (!Array.isArray(summariesResponse.result)) {
      throw new TypeError("Ruleset phase verification returned no ruleset list")
    }
    const kinds = new Set(target.kinds)
    const matching = summariesResponse.result.filter(
      (ruleset) => ruleset.phase === target.phase && kinds.has(ruleset.kind),
    )
    const details = await Promise.all(matching.map(async (ruleset) => {
      const response = await api.request(
        zoneApiPath(target.zoneId, "rulesets", ruleset.id),
      )
      return response.result
    }))
    return {
      response: {
        result: {
          details,
          summaries: summariesResponse.result,
        },
        status: summariesResponse.status,
      },
      target,
    }
  }
  throw new Error(`Unsupported write verification kind: ${target.kind}`)
}

function inventoryWithWriteVerification(inventory, entry) {
  const { response, target } = entry
  if (target.kind === WRITE_VERIFICATION_KIND.SURFACE) {
    return inventoryWithVerifiedSurface(inventory, target, response)
  }
  if (target.kind === WRITE_VERIFICATION_KIND.SETTING) {
    return inventoryWithVerifiedSetting(inventory, target, response)
  }
  if (target.kind === WRITE_VERIFICATION_KIND.DNS_RECORD) {
    return inventoryWithVerifiedDnsRecord(inventory, target, response)
  }
  if (target.kind === WRITE_VERIFICATION_KIND.EMAIL_RULE) {
    return inventoryWithVerifiedEmailRule(inventory, target, response)
  }
  if (target.kind === WRITE_VERIFICATION_KIND.RULESET) {
    return inventoryWithVerifiedRuleset(inventory, target, response)
  }
  if (target.kind === WRITE_VERIFICATION_KIND.RULESET_DELETION) {
    return inventoryWithVerifiedRulesetDeletion(inventory, target, response)
  }
  if (target.kind === WRITE_VERIFICATION_KIND.RULESET_PHASE) {
    return inventoryWithVerifiedRulesetPhase(inventory, target, response)
  }
  throw new Error(`Unsupported write verification kind: ${target.kind}`)
}

function syncRulesetWorkspaceFromInventory(inventory) {
  const workspace = state.rulesetWorkspace
  if (!workspace) return
  const zone = inventory.zones.find(
    (candidate) => candidate.meta.id === workspace.action.zoneId,
  )
  const ruleset = zone?.ruleDetails
    .filter((detail) => detail.ok)
    .map((detail) => detail.result)
    .find((candidate) => candidate.id === workspace.action.rulesetId)
  if (!ruleset) return
  workspace.ruleset = ruleset
  workspace.error = ""
  workspace.loading = false
  renderRulesetWorkspace()
}

function reportScopedWriteVerification(count) {
  setRefreshDetail(
    `${count} changed resource${count === 1 ? "" : "s"} verified; full fleet refresh skipped`,
    "complete",
  )
}

async function verifyChangedWriteTargets(targets) {
  if (targets.length === 0) {
    restoreInventoryStatus()
    return []
  }
  setStatus(`Verifying changed resources 0/${targets.length}`)
  let completed = 0
  const entries = await Promise.all(targets.map(async (target) => {
    const entry = await readWriteVerificationTarget(target)
    completed += 1
    setStatus(`Verifying changed resources ${completed}/${targets.length}`)
    return entry
  }))
  let patched = state.inventory
  if (!patched) throw new Error("The fleet snapshot is unavailable")
  for (const entry of entries) {
    patched = inventoryWithWriteVerification(patched, entry)
  }
  renderInventory(patched, state.inventorySource)
  syncRulesetWorkspaceFromInventory(patched)
  const serializedSnapshot = serializeLiveSnapshot(patched)
  window[CACHE_SNAPSHOT_GLOBAL] = serializedSnapshot
  let cacheError = null
  try {
    await api.persistSnapshot(serializedSnapshot)
  } catch (error) {
    cacheError = error
  }
  restoreInventoryStatus()
  if (cacheError) {
    setRefreshDetail(
      `Changed resources verified, but the snapshot was not saved: ${cacheError instanceof Error ? cacheError.message : String(cacheError)}`,
      "error",
    )
  } else {
    reportScopedWriteVerification(targets.length)
  }
  return entries
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
  const rule = ruleset.rules?.find((candidate) => candidate.id === ruleId)
  elements.rulesetDialog.close()
  elements.search.value = ""
  elements.category.value = presentRule(rule, ruleset.phase).redirect
    ? MATRIX_CATEGORY.REDIRECTS
    : MATRIX_CATEGORY.RULESET_RULES
  elements.scope.value = MATRIX_SCOPE.ALL
  elements.dnsType.value = ""
  elements.redirectType.value = ""
  elements.differenceToggle.setAttribute("aria-pressed", "false")
  syncDnsTypeAvailability()
  syncRedirectTypeAvailability()
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

function currentRulesetComparisonRow() {
  return state.matrix?.rows.find((row) => (
    row.key === state.rulesetComparisonRowKey
      && rulesetParentRowIsReviewable(row)
  )) || null
}

function rulesetComparisonRuleList(rules) {
  const list = createElement("ol", { className: "ruleset-comparison-rule-list" })
  for (const [index, rule] of rules.entries()) {
    const item = document.createElement("li")
    const copy = document.createElement("span")
    copy.append(
      createElement("strong", { text: rulesetRuleLabel(rule, index) }),
      createElement("small", {
        text: `${ruleActionLabel(rule.action)} | ${rule.enabled === false ? "Disabled" : "Enabled"}`,
      }),
    )
    item.append(copy)
    list.append(item)
  }
  if (rules.length === 0) {
    list.append(createElement("li", {
      className: "ruleset-comparison-empty",
      text: "No rules",
    }))
  }
  return list
}

function rulesetComparisonZoneList(zones, options = {}) {
  const list = createElement("ul", { className: "ruleset-comparison-zone-list" })
  for (const zone of zones) {
    const item = document.createElement("li")
    const actions = createElement("span", {
      className: "ruleset-comparison-zone-actions",
    })
    item.append(createElement("strong", { text: zone.name }))
    if (zone.workspaceAction) {
      const button = createElement("button", {
        className: "button button-quiet open-ruleset",
        text: "Open ruleset",
      })
      button.type = "button"
      button.setAttribute("aria-label", `Open ${zone.name} ruleset`)
      workspaceActionByButton.set(button, zone.workspaceAction)
      actions.append(button)
    } else {
      actions.append(createElement("small", {
        className: "capability-badge unavailable",
        text: options.missing ? "Missing" : "Unavailable",
      }))
    }
    if (options.intentActions && options.row && intentMutationSupported()) {
      const inventoryZone = state.inventory?.zones.find(
        (candidate) => candidate.meta.id === zone.id,
      )
      if (inventoryZone) {
        appendIntentCellAction(
          actions,
          options.row,
          inventoryZone,
          cellIntentState(options.row, inventoryZone),
        )
      }
    }
    item.append(actions)
    list.append(item)
  }
  return list
}

function rulesetComparisonConfiguration(configuration, index, total, options = {}) {
  const article = createElement("article", { className: "ruleset-comparison-configuration" })
  const heading = createElement("div", { className: "ruleset-comparison-configuration-heading" })
  heading.append(
    createElement("h4", {
      text: total === 1 ? "Ordered rules" : `Definition ${index + 1}`,
    }),
    rulesetBadge(
      `${configuration.zoneCount} zone${configuration.zoneCount === 1 ? "" : "s"}`,
    ),
  )
  article.append(
    heading,
    rulesetComparisonRuleList(configuration.rules),
    rulesetComparisonZoneList(configuration.zones, options),
  )
  return article
}

function rulesetComparisonGroup(group, row) {
  const section = createElement("section", {
    className: `ruleset-comparison-group${group.baseline ? " baseline" : " outlier"}${group.ruleCount === null ? " missing" : ""}`,
  })
  const heading = createElement("div", { className: "ruleset-comparison-group-heading" })
  const badges = createElement("div", { className: "ruleset-comparison-group-badges" })
  if (group.baseline) badges.append(rulesetBadge("Most common", "baseline"))
  else badges.append(rulesetBadge("Different", "outlier"))
  badges.append(rulesetBadge(`${group.zoneCount} zone${group.zoneCount === 1 ? "" : "s"}`))
  heading.append(createElement("h3", { text: group.label }), badges)
  section.append(heading)
  if (group.ruleCount === null) {
    section.append(rulesetComparisonZoneList(group.zones, {
      intentActions: !group.baseline,
      missing: true,
      row,
    }))
    return section
  }
  if (group.configurations.length > 1) {
    section.append(createElement("p", {
      className: "ruleset-comparison-definition-note",
      text: `${group.configurations.length} different ordered rule definitions share this count.`,
    }))
  }
  const configurations = createElement("div", { className: "ruleset-comparison-configurations" })
  for (const [index, configuration] of group.configurations.entries()) {
    configurations.append(
      rulesetComparisonConfiguration(configuration, index, group.configurations.length, {
        intentActions: !group.baseline,
        row,
      }),
    )
  }
  section.append(configurations)
  return section
}

function rulesetComparisonIntentText(row, comparison) {
  if (!intentMutationSupported()) {
    return "This read-only review can inspect counts and ordered rules. Open a read/write session to define count intent or acknowledge an intentional count exception."
  }
  const policies = row.intentState?.policies || []
  if (policies.length === 0) {
    return comparison.baseline
      ? `No count intent is set. Use ${comparison.baseline.label} as exact intent, then acknowledge only the zones that should stay different. Allow any rule count if an entire coverage group may vary.`
      : "No count intent is set. The counts are tied, so choose an exact count or allow any rule count for the appropriate coverage group."
  }
  if (policies.length > 1) {
    return `${policies.length} intent policies overlap this parent summary. Review them in Fleet intent before changing the relationship.`
  }
  const policy = policies[0]
  const presenceConstraint = fleetIntentPolicyPresenceConstraint(policy)
  const constraint = fleetIntentPolicyValueConstraint(policy)
  if (presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN) {
    return "Intent requires this parent ruleset to be absent throughout its coverage group. Any present ruleset is drift."
  }
  if (constraint === FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER) {
    return presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL
      ? "Intent allows this parent ruleset to be absent or to have any rule count in its coverage group. To constrain present rulesets, choose an exact count or distinct values."
      : "Intent requires this parent ruleset throughout its coverage group but allows any rule count. To keep only selected outliers, use the common count as exact intent and acknowledge those zones with a reason."
  }
  if (constraint === FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER) {
    return presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL
      ? "Intent allows this parent ruleset to be absent, but every present covered value must differ. Use child-rule intent when uniqueness belongs to specific rules instead."
      : "Intent requires every covered zone to have a different parent summary. Use child-rule intent when uniqueness belongs to specific rules instead."
  }
  return presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL
    ? "Exact intent allows this parent ruleset to be absent, but treats any other present rule count as drift. Individual rule definitions still need child-rule intent."
    : "Exact intent treats missing or different rule counts as drift. Use Acknowledge beside a different zone below to accept only its current summarized count with a reason. Individual rule definitions still need child-rule intent."
}

function renderRulesetComparison() {
  const row = currentRulesetComparisonRow()
  const comparison = row
    ? compareDetailedRulesetRow(row, state.inventory?.zones || [])
    : null
  if (!row || !comparison) {
    if (elements.rulesetComparisonDialog.open) elements.rulesetComparisonDialog.close()
    return
  }
  const baselineSummary = comparison.baseline
    ? `The most common count is ${comparison.baseline.label}, present on ${comparison.baseline.zoneCount} of ${comparison.totalZones} zones.`
    : `No single rule count dominates the ${comparison.totalZones} zones.`
  const definitionSummary = comparison.hasDefinitionDifferences
    ? " At least one count contains multiple ordered rule definitions."
    : ""
  elements.rulesetComparisonTitle.textContent = row.label
  elements.rulesetComparisonSummary.textContent = `${baselineSummary}${definitionSummary}`
  elements.rulesetComparisonMetrics.replaceChildren(
    rulesetBadge(`${comparison.totalZones} zones`),
    comparison.baseline
      ? rulesetBadge(
          `${comparison.outlierCount} count outlier${comparison.outlierCount === 1 ? "" : "s"}`,
          comparison.outlierCount > 0 ? "outlier" : "baseline",
        )
      : rulesetBadge("No dominant count", "outlier"),
    rulesetBadge(
      `${comparison.configurationCount} ordered definition${comparison.configurationCount === 1 ? "" : "s"}`,
    ),
  )
  elements.rulesetComparisonGroups.replaceChildren(
    ...comparison.groups.map((group) => rulesetComparisonGroup(group, row)),
  )
  elements.rulesetComparisonIntent.textContent = rulesetComparisonIntentText(
    row,
    comparison,
  )
  const policies = row.intentState?.policies || []
  const presenceConstraint = fleetIntentPolicyPresenceConstraint(policies[0])
  const constraint = fleetIntentPolicyValueConstraint(policies[0])
  elements.rulesetComparisonUseBaseline.hidden = !intentMutationSupported()
    || policies.length > 1
  elements.rulesetComparisonUseBaseline.disabled = !intentWritable()
  elements.rulesetComparisonUseBaseline.textContent = policies.length === 1
    && presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN
    ? "Edit forbidden intent"
    : policies.length === 1
      && constraint === FLEET_INTENT_VALUE_CONSTRAINT.EXACT
      ? "Edit exact count intent"
      : comparison.baseline
        ? `Use ${comparison.baseline.label} as intent`
        : "Choose exact count intent"
  elements.rulesetComparisonAllowDifferences.hidden = !intentMutationSupported()
    || (policies.length === 1
      && presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN)
  elements.rulesetComparisonAllowDifferences.disabled = !intentWritable()
  elements.rulesetComparisonAllowDifferences.textContent = policies.length > 1
    ? "Review intent policies"
    : constraint === FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER
      ? "Edit allowed counts"
      : "Allow any rule count"
}

function showRulesetComparison(row) {
  state.rulesetComparisonRowKey = row.key
  renderRulesetComparison()
  const initialFocus = elements.rulesetComparisonGroups.querySelector(
    ".ruleset-comparison-group.outlier .open-ruleset",
  ) || elements.rulesetComparisonShowRules
  showDialog(elements.rulesetComparisonDialog, { initialFocus })
}

function showRulesetChildRows() {
  const row = currentRulesetComparisonRow()
  if (!row) return
  const phase = rulesetRowPhase(row)
  const category = phase === "http_request_dynamic_redirect"
    ? MATRIX_CATEGORY.REDIRECTS
    : MATRIX_CATEGORY.RULESET_RULES
  elements.rulesetComparisonDialog.close()
  elements.search.value = row.label
  elements.category.value = category
  elements.scope.value = MATRIX_SCOPE.ALL
  elements.dnsType.value = ""
  elements.redirectType.value = ""
  elements.differenceToggle.setAttribute("aria-pressed", "false")
  elements.targetHoles.setAttribute("aria-pressed", "false")
  elements.targetHoles.textContent = "Target holes"
  syncDnsTypeAvailability()
  syncRedirectTypeAvailability()
  filterRows()
  const visibleRows = [...elements.matrixBody.querySelectorAll("tr")]
    .filter((candidate) => !candidate.classList.contains("hidden-row"))
  if (visibleRows.length === 0) {
    toast("No child rule rows are available in this matrix snapshot", "error")
    return
  }
  const visibleRow = visibleRows[0]
  visibleRow.classList.add("matrix-navigation-target")
  visibleRow.scrollIntoView({
    behavior: prefersReducedMotion() ? "auto" : "smooth",
    block: "center",
    inline: "start",
  })
  const facet = visibleRow.querySelector(".facet-cell")
  if (facet) {
    facet.tabIndex = -1
    facet.focus({ preventScroll: true })
  }
  toast(
    `Showing ${visibleRows.length} child rule row${visibleRows.length === 1 ? "" : "s"} from ${row.label} in the matrix`,
  )
}

function editRulesetExactCountIntent() {
  const row = currentRulesetComparisonRow()
  if (!row || !intentWritable()) return
  const policies = row.intentState?.policies || []
  if (policies.length > 1) {
    openIntentManager()
    return
  }
  const comparison = compareDetailedRulesetRow(
    row,
    state.inventory?.zones || [],
  )
  const baselineZone = comparison?.baseline?.zones.find(
    (zone) => row.cells.has(zone.name),
  )
  const baselineCell = baselineZone ? row.cells.get(baselineZone.name) : null
  const options = {
    valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.EXACT,
  }
  if (baselineCell) {
    options.expectedCanonical = baselineCell.intentCanonical
      ?? baselineCell.canonical
  }
  openIntentPolicyEditor(row, policies[0] || null, options)
}

function allowRulesetCountDifferences() {
  const row = currentRulesetComparisonRow()
  if (!row || !intentWritable()) return
  const policies = row.intentState?.policies || []
  if (policies.length > 1) {
    openIntentManager()
    return
  }
  openIntentPolicyEditor(row, policies[0] || null, {
    valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER,
  })
}

function currentValueComparisonRow() {
  const key = state.valueComparisonRowKey
  if (!key) return null
  return state.matrix?.rows.find(
    (row) => row.category === key.category && row.key === key.key,
  ) || null
}

function valueComparisonVariantLabel(comparison, variant, index) {
  if (variant.canonical === comparison.consensusCanonical) {
    return "Fleet consensus"
  }
  if (variant.canonical === comparison.referenceCanonical) {
    return "Reference value"
  }
  if (comparison.variantCount === 2) return "Alternate value"
  return `Value ${index + 1}`
}

function valueComparisonZoneList(zones) {
  const list = createElement("ul", { className: "value-comparison-zone-list" })
  list.append(...zones.map((zone) => createElement("li", { text: zone.name })))
  return list
}

function useComparedValueAsIntent(row, variant) {
  if (!intentWritable()) return
  const policies = row.intentState?.policies || []
  elements.valueComparisonDialog.close()
  if (policies.length > 1) {
    openIntentManager()
    return
  }
  openIntentPolicyEditor(row, policies[0] || null, {
    expectedCanonical: variant.intentCanonical,
    valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.EXACT,
  })
}

function valueComparisonVariantSummary(comparison, index) {
  const summaries = comparison.differences.flatMap((difference) => {
    const entry = difference.values[index]
    const label = valueComparisonPathLabel(difference.path)
    if (!entry.present) return [`${label}: Missing`]
    if (entry.value === null) return [`${label}: None`]
    if (["boolean", "number"].includes(typeof entry.value)) {
      return [`${label}: ${String(entry.value)}`]
    }
    if (typeof entry.value === "string"
      && entry.value.length <= VALUE_COMPARISON_CONTEXT_LENGTH) {
      return [`${label}: ${entry.value || "None"}`]
    }
    return []
  })
  if (summaries.length > 0 && summaries.length <= 2) {
    return summaries.join(" | ")
  }
  return `${comparison.differences.length} differing field${comparison.differences.length === 1 ? "" : "s"}`
}

function valueComparisonGroup(row, comparison, variant, index) {
  const consensus = variant.canonical === comparison.consensusCanonical
  const reference = variant.canonical === comparison.referenceCanonical
  const article = createElement("article", {
    className: `value-comparison-group${consensus ? " consensus" : ""}`,
  })
  const heading = createElement("div", {
    className: "value-comparison-group-heading",
  })
  const badges = createElement("div", {
    className: "value-comparison-group-badges",
  })
  if (consensus) badges.append(rulesetBadge("Leading", "baseline"))
  else if (reference) badges.append(rulesetBadge("Reference"))
  else badges.append(rulesetBadge("Different", "outlier"))
  badges.append(rulesetBadge(
    `${variant.count} zone${variant.count === 1 ? "" : "s"}`,
  ))
  heading.append(
    createElement("h4", {
      text: valueComparisonVariantLabel(comparison, variant, index),
    }),
    badges,
  )
  article.append(
    heading,
    createElement("p", {
      className: "value-comparison-group-summary",
      text: valueComparisonVariantSummary(comparison, index),
    }),
    valueComparisonZoneList(variant.zones),
  )
  if (intentMutationSupported()) {
    const policies = row.intentState?.policies || []
    const actions = createElement("div", {
      className: "value-comparison-group-actions",
    })
    const button = createElement("button", {
      className: "button button-quiet",
      text: policies.length > 1 ? "Manage intents" : "Use as exact intent",
    })
    button.type = "button"
    button.setAttribute(
      "aria-label",
      policies.length > 1
        ? `Manage intents for ${row.label}`
        : `Use as exact intent: ${valueComparisonVariantLabel(comparison, variant, index)} for ${row.label}`,
    )
    button.disabled = !intentWritable()
      || (!variant.intentCanonical && policies.length <= 1)
    button.title = policies.length > 1
      ? "Multiple policies overlap this facet; review their coverage before choosing a value"
      : variant.intentCanonical
        ? "Open the intent editor with this observed value selected"
        : "This matrix value maps to multiple intent values and cannot be selected as one expectation"
    button.addEventListener("click", () => useComparedValueAsIntent(row, variant))
    actions.append(button)
    article.append(actions)
  }
  return article
}

function missingValueComparisonGroup(comparison) {
  const article = createElement("article", {
    className: "value-comparison-group missing",
  })
  const heading = createElement("div", {
    className: "value-comparison-group-heading",
  })
  heading.append(
    createElement("h4", { text: "Missing" }),
    rulesetBadge(
      `${comparison.missingZones.length} zone${comparison.missingZones.length === 1 ? "" : "s"}`,
      "outlier",
    ),
  )
  article.append(heading, valueComparisonZoneList(comparison.missingZones))
  return article
}

function compactValueDiffSegments(segments) {
  const firstDifference = segments.findIndex(
    (segment) => segment.kind !== VALUE_TEXT_DIFF_KIND.EQUAL,
  )
  const lastDifference = segments.findLastIndex(
    (segment) => segment.kind !== VALUE_TEXT_DIFF_KIND.EQUAL,
  )
  return segments.map((segment, index) => {
    if (segment.kind !== VALUE_TEXT_DIFF_KIND.EQUAL
      || segment.text.length <= VALUE_COMPARISON_CONTEXT_LENGTH * 2) {
      return segment
    }
    if (index < firstDifference) {
      return {
        ...segment,
        text: `${VALUE_COMPARISON_ELLIPSIS}${segment.text.slice(-VALUE_COMPARISON_CONTEXT_LENGTH)}`,
      }
    }
    if (index > lastDifference) {
      return {
        ...segment,
        text: `${segment.text.slice(0, VALUE_COMPARISON_CONTEXT_LENGTH)}${VALUE_COMPARISON_ELLIPSIS}`,
      }
    }
    return {
      ...segment,
      text: `${segment.text.slice(0, VALUE_COMPARISON_CONTEXT_LENGTH)}${VALUE_COMPARISON_ELLIPSIS}${segment.text.slice(-VALUE_COMPARISON_CONTEXT_LENGTH)}`,
    }
  })
}

function valueComparisonTextDiff(reference, candidate, options = {}) {
  const code = document.createElement("code")
  const segments = compactValueDiffSegments(diffValueText(reference, candidate))
  for (const segment of segments) {
    if (options.reference && segment.kind === VALUE_TEXT_DIFF_KIND.INSERT) continue
    let node
    if (options.reference && segment.kind === VALUE_TEXT_DIFF_KIND.DELETE) {
      node = document.createElement("mark")
    } else if (segment.kind === VALUE_TEXT_DIFF_KIND.DELETE) {
      node = document.createElement("del")
    } else if (segment.kind === VALUE_TEXT_DIFF_KIND.INSERT) {
      node = document.createElement("ins")
    } else {
      node = document.createElement("span")
    }
    node.textContent = segment.text
    code.append(node)
  }
  return code
}

function valueComparisonLeaf(value) {
  if (Array.isArray(value) && value.length === 0) {
    return createElement("span", { text: "Empty list" })
  }
  if (value && typeof value === "object" && Object.keys(value).length === 0) {
    return createElement("span", { text: "Empty object" })
  }
  return structuredValueElement(value)
}

function valueComparisonFieldValue(difference, index, referenceIndex) {
  const entry = difference.values[index]
  if (!entry.present) {
    return createElement("span", {
      className: "value-comparison-missing-field",
      text: "Field missing",
    })
  }
  const reference = difference.values[referenceIndex]
  if (typeof entry.value === "string" && reference.present
    && typeof reference.value === "string") {
    if (index === referenceIndex) {
      if (difference.values.length > 2) return valueComparisonLeaf(entry.value)
      const candidate = difference.values.find(
        (value, candidateIndex) => candidateIndex !== referenceIndex
          && value.present
          && typeof value.value === "string"
          && value.value !== reference.value,
      )
      return candidate
        ? valueComparisonTextDiff(reference.value, candidate.value, {
            reference: true,
          })
        : valueComparisonLeaf(entry.value)
    }
    return valueComparisonTextDiff(reference.value, entry.value)
  }
  return valueComparisonLeaf(entry.value)
}

function valueComparisonPathLabel(path) {
  if (path.length === 0) return "Value"
  return path.map((part) => (
    typeof part === "number"
      ? `Item ${part + 1}`
      : humanizeValueField(part)
  )).join(" > ")
}

function valueComparisonTable(comparison) {
  const table = createElement("table", { className: "value-comparison-table" })
  const caption = createElement("caption", {
    className: "sr-only",
    text: "Fields that differ between the observed fleet values",
  })
  const head = document.createElement("thead")
  const headingRow = document.createElement("tr")
  const fieldHeading = createElement("th", {
    className: "value-comparison-field-heading",
    text: "Differing field",
  })
  fieldHeading.scope = "col"
  headingRow.append(fieldHeading)
  for (const [index, variant] of comparison.variants.entries()) {
    const heading = document.createElement("th")
    heading.scope = "col"
    heading.textContent = `${valueComparisonVariantLabel(
      comparison,
      variant,
      index,
    )} | ${variant.count} zone${variant.count === 1 ? "" : "s"}`
    headingRow.append(heading)
  }
  head.append(headingRow)

  const body = document.createElement("tbody")
  const referenceIndex = comparison.variants.findIndex(
    (variant) => variant.canonical === comparison.referenceCanonical,
  )
  for (const difference of comparison.differences) {
    const row = document.createElement("tr")
    const field = createElement("th", {
      className: "value-comparison-field-heading",
      text: valueComparisonPathLabel(difference.path),
    })
    field.scope = "row"
    row.append(field)
    for (const index of comparison.variants.keys()) {
      const cell = document.createElement("td")
      cell.append(valueComparisonFieldValue(
        difference,
        index,
        referenceIndex,
      ))
      row.append(cell)
    }
    body.append(row)
  }
  table.append(caption, head, body)
  return table
}

function valueComparisonCompleteCard(comparison, variant, index) {
  const card = createElement("article", {
    className: "value-comparison-complete-card",
  })
  card.append(createElement("h4", {
    text: `${valueComparisonVariantLabel(comparison, variant, index)} | ${variant.count} zone${variant.count === 1 ? "" : "s"}`,
  }))
  const value = createElement("div", {
    className: "value-comparison-complete-value",
  })
  value.append(structuredValueElement(variant.value))
  card.append(value, createRawValueDetails(variant.value))
  return card
}

function renderValueComparison() {
  const row = currentValueComparisonRow()
  const comparison = row
    ? compareFleetRowValues(row, state.inventory?.zones || [])
    : null
  if (!row || !comparison || comparison.variantCount < 2) {
    if (elements.valueComparisonDialog.open) elements.valueComparisonDialog.close()
    return
  }
  const leadingSummary = comparison.hasUniqueConsensus
    ? `The leading value covers ${comparison.consensusCount} of ${comparison.presentCount} configured zones.`
    : `No value has a unique lead across ${comparison.presentCount} configured zones.`
  const missingSummary = comparison.missingZones.length > 0
    ? ` ${comparison.missingZones.length} zone${comparison.missingZones.length === 1 ? " is" : "s are"} missing this facet.`
    : ""
  elements.valueComparisonTitle.textContent = row.label
  elements.valueComparisonSummary.textContent = `${comparison.variantCount} normalized values are present. ${leadingSummary}${missingSummary}`
  elements.valueComparisonMetrics.replaceChildren(
    rulesetBadge(`${comparison.variantCount} values`, "outlier"),
    comparison.hasUniqueConsensus
      ? rulesetBadge(`${comparison.consensusCount} consensus`, "baseline")
      : rulesetBadge("Tied values", "outlier"),
    rulesetBadge(
      `${comparison.differences.length} differing field${comparison.differences.length === 1 ? "" : "s"}`,
    ),
    ...(comparison.missingZones.length > 0
      ? [rulesetBadge(`${comparison.missingZones.length} missing`, "outlier")]
      : []),
  )
  elements.valueComparisonGroups.replaceChildren(
    ...comparison.variants.map(
      (variant, index) => valueComparisonGroup(row, comparison, variant, index),
    ),
    ...(comparison.missingZones.length > 0
      ? [missingValueComparisonGroup(comparison)]
      : []),
  )
  const matchingSummary = comparison.commonFieldCount === 0
    ? "No matching fields are omitted."
    : `${comparison.commonFieldCount} matching field${comparison.commonFieldCount === 1 ? " is" : "s are"} omitted.`
  elements.valueComparisonDifferenceSummary.textContent = `${comparison.differences.length} of ${comparison.fieldCount} normalized field${comparison.fieldCount === 1 ? "" : "s"} differ${comparison.differences.length === 1 ? "s" : ""}. ${matchingSummary}`
  elements.valueComparisonDifferences.replaceChildren(
    valueComparisonTable(comparison),
  )
  elements.valueComparisonComplete.open = false
  elements.valueComparisonCompleteGrid.replaceChildren(
    ...comparison.variants.map(
      (variant, index) => valueComparisonCompleteCard(comparison, variant, index),
    ),
  )
}

function showValueComparison(row) {
  state.valueComparisonRowKey = {
    category: row.category,
    key: row.key,
  }
  renderValueComparison()
  showDialog(elements.valueComparisonDialog, {
    initialFocus: elements.valueComparisonDialog.querySelector("[data-dialog-close]"),
  })
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

function intentManagerReturnFocus() {
  if (!elements.intentDialog.open) return null
  return elements.intentDialog.querySelector("[data-dialog-close]")
}

function matrixIntentReturnFocus(row, selector, zoneId = "") {
  const managerTarget = intentManagerReturnFocus()
  if (managerTarget) return managerTarget
  const tableRow = [...elements.matrixBody.querySelectorAll("tr")].find(
    (candidate) => candidate.dataset.category === row.category
      && candidate.dataset.facetKey === row.key,
  )
  if (!tableRow || tableRow.classList.contains("hidden-row")) {
    return elements.matrixShell
  }
  const container = zoneId
    ? tableRow.querySelector(`[data-zone-id="${CSS.escape(zoneId)}"]`)
    : tableRow
  const target = container?.querySelector(selector)
  if (!target || !matrixActionIsAvailable(target)) return elements.matrixShell
  syncMatrixActionTabStop(target)
  target.scrollIntoView({
    behavior: "auto",
    block: "nearest",
    inline: "nearest",
  })
  return target
}

function coverageIntentReturnFocus() {
  return intentManagerReturnFocus() || document.querySelector("#coverage-heading")
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

function setMatrixFocus(focused) {
  const active = document.body.classList.contains(MATRIX_FOCUS_CLASS)
  if (active === focused) return
  if (focused) state.matrixFocusScrollY = window.scrollY
  document.body.classList.toggle(MATRIX_FOCUS_CLASS, focused)
  for (const button of [elements.matrixFocus, elements.mobileMatrixFocus]) {
    button.setAttribute("aria-pressed", String(focused))
    button.textContent = focused ? "Exit focus" : "Focus matrix"
    button.title = focused
      ? "Return to the fleet overview"
      : "Use the full viewport for the matrix"
  }
  if (!focused) {
    requestAnimationFrame(() => {
      window.scrollTo({
        behavior: "auto",
        top: state.matrixFocusScrollY,
      })
    })
  }
}

function closeMatrixGuideOnOutsideClick(event) {
  if (elements.matrixGuide.open && !elements.matrixGuide.contains(event.target)) {
    elements.matrixGuide.open = false
  }
}

function handleMatrixGuideKeydown(event) {
  if (event.key !== "Escape" || !elements.matrixGuide.open) return
  event.preventDefault()
  event.stopPropagation()
  elements.matrixGuide.open = false
  elements.matrixGuide.querySelector("summary").focus()
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
    return
  }
  if (event.key === "Escape"
    && document.body.classList.contains(MATRIX_FOCUS_CLASS)
    && !document.querySelector("dialog[open]")) {
    event.preventDefault()
    setMatrixFocus(false)
    const focusControl = compactToolbarMedia.matches
      ? elements.mobileMatrixFocus
      : elements.matrixFocus
    focusControl.focus()
  }
}

function renderSummary() {
  const summary = state.matrix.summary
  elements.zoneCount.textContent = String(summary.zones)
  elements.facetCount.textContent = String(summary.facets)
  elements.driftCount.textContent = String(summary.differences)
  elements.holeCount.textContent = String(summary.missingCells)
  renderTaskSummaries()
  const source = state.inventorySource === INVENTORY_SOURCE.CACHE
    ? "Cached snapshot"
    : "Live snapshot"
  const current = `${source} ${state.inventory.loadedAt}`
  elements.snapshotTime.textContent = state.inventorySource === INVENTORY_SOURCE.LIVE
    && state.startupCacheLoadedAt
    ? `${current} | opened from cache ${state.startupCacheLoadedAt}`
    : current
}

function renderIntentPolicyCard() {
  const summary = state.intentEvaluation?.summary || {
    acknowledgedCells: 0,
    actionableCells: 0,
    governedRows: 0,
    policies: state.intent.policies.length,
    staleAcknowledgements: 0,
    unresolvedPolicies: 0,
  }
  const customGroupCount = state.intent.groups.filter(
    (group) => group.id !== FLEET_INTENT_ALL_ZONES_GROUP_ID,
  ).length
  elements.intentPolicyDetail.textContent = summary.policies === 0
    ? `No facets governed yet | ${customGroupCount} custom group${customGroupCount === 1 ? "" : "s"}`
    : `${summary.governedRows} governed facet${summary.governedRows === 1 ? "" : "s"} | ${summary.acknowledgedCells} acknowledged cell${summary.acknowledgedCells === 1 ? "" : "s"}`
  elements.intentPolicyDetail.title = elements.intentPolicyDetail.textContent
  elements.intentPolicyDrift.textContent = `${summary.actionableCells} actionable`
  const reviewCount = summary.staleAcknowledgements + summary.unresolvedPolicies
  elements.intentPolicyReview.hidden = reviewCount === 0
  elements.intentPolicyReview.textContent = `${reviewCount} need review`
  elements.manageIntent.textContent = readOnly
    ? "View fleet intent"
    : "Manage fleet intent"
}

function renderDnssecWorkflowCard() {
  const row = state.matrix?.rows.find(rowSupportsDnssecIntentCorrection) || null
  const policies = row?.intentState?.policies || []
  const correction = row ? dnssecIntentCorrection(row) : null
  elements.showDnssecWorkflow.disabled = !row
  elements.dnssecWorkflowState.className = "workflow-state"

  if (!row) {
    elements.dnssecWorkflowState.textContent = "Unavailable"
    elements.dnssecWorkflowState.classList.add("inactive")
    elements.dnssecWorkflowDetail.textContent = "DNSSEC was not available in the loaded fleet snapshot."
    return
  }
  if (correction.available) {
    const count = correction.targets.length
    elements.dnssecWorkflowState.textContent = `${count} correctable`
    elements.dnssecWorkflowState.classList.add("ready")
    elements.dnssecWorkflowDetail.textContent = `${count} zone${count === 1 ? "" : "s"} can be aligned to exact DNSSEC intent from the matrix row.`
    return
  }
  if (policies.length === 0) {
    elements.dnssecWorkflowState.textContent = "Set intent first"
    elements.dnssecWorkflowState.classList.add("inactive")
    elements.dnssecWorkflowDetail.textContent = "Define an exact DNSSEC status in Fleet intent to evaluate correctable zones."
    return
  }
  if (correction.waiting.length > 0) {
    elements.dnssecWorkflowState.textContent = "Cloudflare processing"
    elements.dnssecWorkflowState.classList.add("waiting")
  } else {
    elements.dnssecWorkflowState.textContent = "No change ready"
    elements.dnssecWorkflowState.classList.add("inactive")
  }
  elements.dnssecWorkflowDetail.textContent = correction.reason
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
      text: `${matrixCategoryLabel(category)} (${counts.get(category) || 0})`,
    })
    option.value = category
    elements.category.append(option)
  }
  if (state.matrix.categories.includes(previous)) elements.category.value = previous
}

function capabilityBadge(capability) {
  const presentation = MATRIX_CAPABILITY_PRESENTATION[capability]
  if (!presentation) return null
  return createElement("span", {
    className: `capability-chip ${presentation.kind}`,
    text: presentation.label,
  })
}

function categoryChangeDetail(capabilities) {
  const available = CATEGORY_CHANGE_CAPABILITY_ORDER.filter(
    (capability) => capabilities.has(capability),
  )
  const labels = available.map(
    (capability) => MATRIX_CAPABILITY_PRESENTATION[capability].label,
  )
  const typeLabel = labels.length === 1 ? "type" : "types"
  const details = [`Available change ${typeLabel} in this category: ${labels.join(", ")}.`]
  if (capabilities.has(MATRIX_CAPABILITY.DIRECT_EDIT)) {
    details.push("A direct edit targets only the opened cell.")
  }
  if (capabilities.has(MATRIX_CAPABILITY.COPY_FILL)) {
    details.push("Copy and fill actions use the selected matrix targets.")
  }
  if (capabilities.has(MATRIX_CAPABILITY.INTENT_FIX)) {
    details.push("An intent-driven fix requires exact expected state before a write can be reviewed.")
  }
  details.push("The matrix shows action availability for each cell.")
  return details.join(" ")
}

function renderCategoryCapability() {
  if (!state.matrix) return
  const selectedCategory = elements.category.value
  const categories = matrixCategoryCapabilities(state.matrix)
  const counts = matrixCapabilityCounts(state.matrix)
  const readOnlyNote = readOnly
    ? " This read-only session can inspect capabilities and intent, but cannot save expected state or apply Cloudflare writes."
    : ""
  let capabilities

  if (!selectedCategory) {
    elements.categoryCapabilityTitle.textContent = "All categories"
    elements.categoryCapabilityDetail.textContent = `${counts.rows} facets across ${counts.categories} categories. ${counts.changeableRows} facets in ${counts.changeableCategories} categories have a supported matrix change path; ${counts.compareOnlyCategories} categories are comparison and expected-state only. Capability badges summarize row-level paths; the matrix shows availability for each cell. Multi-setting workflows are scoped separately above.${readOnlyNote}`
    capabilities = new Set([
      MATRIX_CAPABILITY.COMPARE,
      MATRIX_CAPABILITY.EXPECTED_STATE,
    ])
    for (const entry of categories) {
      for (const capability of entry.capabilities) capabilities.add(capability)
    }
    if (counts.changeableCategories > 0) {
      capabilities.delete(MATRIX_CAPABILITY.COMPARE_ONLY)
    }
  } else {
    const entry = categories.find((candidate) => candidate.category === selectedCategory)
    elements.categoryCapabilityTitle.textContent = selectedCategory
    if (!entry) {
      elements.categoryCapabilityDetail.textContent = "This category is not available in the loaded fleet snapshot."
      capabilities = new Set([MATRIX_CAPABILITY.COMPARE_ONLY])
    } else if (entry.changeableRows === 0) {
      elements.categoryCapabilityDetail.textContent = `${entry.rows} facet${entry.rows === 1 ? "" : "s"}. The dashboard can compare these values and evaluate expected state, but it cannot change Cloudflare configuration in this category.${readOnlyNote}`
      capabilities = new Set(entry.capabilities)
    } else if (entry.changeableRows === entry.rows) {
      capabilities = new Set(entry.capabilities)
      elements.categoryCapabilityDetail.textContent = `${entry.rows} facet${entry.rows === 1 ? "" : "s"}. Every facet has at least one supported matrix change path. ${categoryChangeDetail(capabilities)}${readOnlyNote}`
    } else {
      capabilities = new Set(entry.capabilities)
      const remainingRows = entry.rows - entry.changeableRows
      elements.categoryCapabilityDetail.textContent = `${entry.rows} facets. ${entry.changeableRows} facet${entry.changeableRows === 1 ? " has" : "s have"} a supported matrix change path; the remaining ${remainingRows} facet${remainingRows === 1 ? "" : "s"} can still be compared and assigned expected state. ${categoryChangeDetail(capabilities)}${readOnlyNote}`
    }
  }

  elements.categoryCapabilityBadges.replaceChildren(
    ...[...capabilities].map(capabilityBadge).filter(Boolean),
  )
}

function renderTaskSummaries() {
  const reviewCount = state.matrix?.summary.differences || 0
  const capabilityCounts = matrixCapabilityCounts(state.matrix)
  elements.reviewTaskCount.textContent = String(reviewCount)
  elements.reviewTaskLabel.textContent = reviewCount === 1
    ? "facet needs review"
    : "facets need review"
  elements.supportedChangeCount.textContent = String(capabilityCounts.changeableRows)
  elements.supportedChangeLabel.textContent = capabilityCounts.changeableRows === 1
    ? "facet has a matrix change path"
    : "facets have a matrix change path"
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

function renderRedirectTypes() {
  const previous = elements.redirectType.value
  const counts = new Map()
  for (const row of state.matrix.rows) {
    for (const targetKind of row.redirectTypes) {
      counts.set(targetKind, (counts.get(targetKind) || 0) + 1)
    }
  }
  elements.redirectType.replaceChildren(createElement("option", {
    text: "All redirect targets",
  }))
  elements.redirectType.firstElementChild.value = ""
  for (const targetKind of REDIRECT_TARGET_KIND_ORDER) {
    if (!counts.has(targetKind)) continue
    const option = createElement("option", {
      text: `${redirectTargetKindLabel(targetKind)} (${counts.get(targetKind)})`,
    })
    option.value = targetKind
    elements.redirectType.append(option)
  }
  if (counts.has(previous)) elements.redirectType.value = previous
}

function syncDnsTypeAvailability() {
  const category = elements.category.value
  const available = !category || DNS_MATRIX_CATEGORY_SET.has(category)
  elements.dnsType.hidden = category === MATRIX_CATEGORY.REDIRECTS
  elements.dnsType.disabled = !available
  elements.dnsType.title = available
    ? "Limit DNS rows to one record type"
    : "DNS type applies only to DNS categories"
  if (!available) elements.dnsType.value = ""
}

function syncRedirectTypeAvailability() {
  const available = elements.category.value === MATRIX_CATEGORY.REDIRECTS
  elements.redirectType.hidden = !available
  elements.redirectType.disabled = !available
  elements.redirectType.title = available
    ? "Limit redirects to static or computed destinations"
    : "Redirect target type applies only to redirects"
  if (!available) elements.redirectType.value = ""
}

function currentMatrixFilters() {
  return {
    category: elements.category.value,
    changeableOnly: elements.changeSupportToggle.getAttribute("aria-pressed") === "true",
    differencesOnly: elements.differenceToggle.getAttribute("aria-pressed") === "true",
    query: elements.search.value,
    recordType: elements.dnsType.value,
    redirectType: elements.redirectType.value,
    scope: elements.scope.value,
    targetHolesOnly: elements.targetHoles.getAttribute("aria-pressed") === "true",
    targetZoneIds: state.selectedZoneIds,
    zoneCount: state.inventory?.zones.length || 0,
  }
}

function syncResponsiveFilterPanel() {
  const compact = compactFilterMedia.matches
  elements.filterPanelToggle.hidden = !compact
  elements.toolbarSecondary.hidden = compact && !state.filterPanelExpanded
  elements.filterPanelToggle.setAttribute(
    "aria-expanded",
    String(!compact || state.filterPanelExpanded),
  )
}

function syncMatrixFilterControls(filters = currentMatrixFilters()) {
  const changeCount = matrixFilterChangeCount(filters)
  const label = changeCount === 0 ? "Filters" : `Filters (${changeCount})`
  elements.filterReset.hidden = changeCount === 0
  elements.filterReset.disabled = changeCount === 0
  elements.filterPanelToggle.textContent = state.filterPanelExpanded
    ? "Hide filters"
    : label
  elements.filterPanelToggle.setAttribute(
    "aria-label",
    `${state.filterPanelExpanded ? "Hide" : "Show"} secondary filters. ${changeCount} non-default filter${changeCount === 1 ? "" : "s"}.`,
  )
  elements.filterPanelToggle.classList.toggle("active", changeCount > 0)
  syncResponsiveFilterPanel()
}

function resetMatrixFilters() {
  elements.search.value = DEFAULT_MATRIX_FILTERS.query
  elements.category.value = DEFAULT_MATRIX_FILTERS.category
  elements.scope.value = DEFAULT_MATRIX_FILTERS.scope
  elements.dnsType.value = DEFAULT_MATRIX_FILTERS.recordType
  elements.redirectType.value = DEFAULT_MATRIX_FILTERS.redirectType
  elements.changeSupportToggle.setAttribute(
    "aria-pressed",
    String(DEFAULT_MATRIX_FILTERS.changeableOnly),
  )
  elements.differenceToggle.setAttribute(
    "aria-pressed",
    String(DEFAULT_MATRIX_FILTERS.differencesOnly),
  )
  elements.targetHoles.setAttribute(
    "aria-pressed",
    String(DEFAULT_MATRIX_FILTERS.targetHolesOnly),
  )
  elements.targetHoles.textContent = "Target holes"
  state.filterPanelExpanded = false
  syncDnsTypeAvailability()
  syncRedirectTypeAvailability()
  renderCategoryCapability()
  filterRows()
}

function renderMatrixFilters() {
  renderCategories()
  renderScopes()
  renderDnsTypes()
  renderRedirectTypes()
  syncDnsTypeAvailability()
  syncRedirectTypeAvailability()
  renderCategoryCapability()
  syncMatrixFilterControls()
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
  elements.emailPolicyDetail.title = elements.emailPolicyDetail.textContent
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
  const exceptionLabel = `${exceptionCount} policy exception${exceptionCount === 1 ? "" : "s"}`
  elements.emailPolicyExceptions.textContent = exceptionLabel
  elements.emailPolicyExceptions.classList.toggle(
    "needs-review",
    exceptionReviewCount > 0,
  )
  elements.emailPolicyExceptions.setAttribute(
    "aria-label",
    contextualActionLabel(
      exceptionLabel,
      `Inspect email policy exceptions. ${activeExceptionCount} active and ${exceptionReviewCount} requiring review.`,
    ),
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
  elements.wafPolicyDetail.title = elements.wafPolicyDetail.textContent
  elements.wafPolicyDrift.textContent = `${wafDrift.length} drifted`

  renderIntentPolicyCard()
  renderDnssecWorkflowCard()
  const intentDriftZoneIds = state.intentEvaluation
    ? [...state.intentEvaluation.rowStates.values()].flatMap(
        (rowState) => rowState.actionableCells.map((cell) => cell.zone.meta.id),
      )
    : []

  elements.selectDrifted.dataset.zoneIds = JSON.stringify(
    [...new Set([
      ...emailDrift.map((zone) => zone.meta.id),
      ...wafDrift.map((zone) => zone.meta.id),
      ...intentDriftZoneIds,
    ])],
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
    elements.redirectType.value = ""
    elements.differenceToggle.setAttribute("aria-pressed", "false")
    elements.targetHoles.setAttribute("aria-pressed", "false")
    elements.targetHoles.textContent = "Target holes"
    syncDnsTypeAvailability()
    syncRedirectTypeAvailability()
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

function setIntentSaving(saving) {
  state.intentSaving = saving
  updateActionButtons()
  if (elements.intentDialog.open) renderIntentManager()
}

async function persistIntentDocument(document, successMessage) {
  if (!intentWritable()) {
    toast(
      api.usesBroker
        ? "Fleet intent is read-only while this session is unavailable"
        : "Fleet intent persistence requires a normal dashboard session",
      "error",
    )
    return false
  }
  setIntentSaving(true)
  try {
    const saved = await api.persistFleetIntent(document)
    if (!isFleetIntentDocument(saved, auth.accountId)) {
      throw new Error("The broker returned an invalid fleet intent document")
    }
    state.intent = saved
    if (state.inventory) renderInventory(state.inventory, state.inventorySource)
    else renderIntentPolicyCard()
    toast(successMessage)
    return true
  } catch (error) {
    if (error instanceof FleetIntentApiConflictError
      && isFleetIntentDocument(error.currentDocument, auth.accountId)) {
      state.intent = error.currentDocument
      if (state.inventory) renderInventory(state.inventory, state.inventorySource)
      toast("Fleet intent changed in another window. The latest version is loaded; review and retry your edit.", "error")
      return false
    }
    toast(error instanceof Error ? error.message : String(error), "error")
    return false
  } finally {
    setIntentSaving(false)
  }
}

function openCoverageIntentEditor(issue, expectation = null) {
  if (!intentWritable()) {
    toast("Expected coverage editing is unavailable in this session", "error")
    return
  }
  const currentExpectation = expectation
    || (issue ? coverageExpectationForIssue(issue) : null)
  const target = issue || currentExpectation
  if (!target) return
  const changed = Boolean(issue && currentExpectation
    && issue.observedCanonical !== currentExpectation.observedCanonical)
  state.coverageIntentDraft = {
    baseRevision: state.intent.revision,
    expectation: currentExpectation,
    issue,
  }
  elements.coverageIntentTitle.textContent = currentExpectation
    ? changed ? "Update expected gap" : "Edit expected gap"
    : "Mark gap as expected"
  elements.coverageIntentTarget.textContent = coverageTargetLabel(target)
  elements.coverageIntentPreview.replaceChildren(
    createElement("strong", {
      text: issue
        ? changed ? "The failure changed" : "Observed failure"
        : "No matching failure is active",
    }),
    document.createTextNode(issue?.detail
      || "The saved allowance remains available if this exact failure returns."),
  )
  elements.coverageIntentReason.value = currentExpectation?.reason || ""
  elements.coverageIntentRemove.hidden = !currentExpectation
  elements.coverageIntentSave.textContent = currentExpectation
    ? changed ? "Update expectation" : "Save expectation"
    : "Mark expected"
  clearFieldError(elements.coverageIntentReason, elements.coverageIntentError)
  showDialog(elements.coverageIntentDialog, {
    fallbackFocus: coverageIntentReturnFocus,
    initialFocus: elements.coverageIntentReason,
  })
  elements.coverageIntentReason.select()
}

async function saveCoverageIntent(event) {
  if (event.submitter?.value === "cancel") return
  event.preventDefault()
  const draft = state.coverageIntentDraft
  if (!draft) return
  if (event.submitter?.value === "remove") {
    const expectation = draft.expectation
    if (!expectation) return
    elements.coverageIntentDialog.close()
    requestIntentRemoval({
      fallbackFocus: coverageIntentReturnFocus,
      remove: (document) => removeFleetIntentCoverageExpectation(
        document,
        expectation.id,
      ),
      successMessage: `Expected coverage removed for ${coverageTargetLabel(expectation)}`,
      summary: `Remove expected coverage for ${coverageTargetLabel(expectation)}? A matching failure will return to unexpected coverage.`,
      title: "Remove expected coverage",
    })
    return
  }
  if (draft.baseRevision !== state.intent.revision) {
    showFieldError(
      elements.coverageIntentReason,
      elements.coverageIntentError,
      new Error("Fleet intent changed while this editor was open. Close and reopen it to review the latest coverage."),
    )
    return
  }
  const reason = elements.coverageIntentReason.value.trim()
  if (!reason) {
    showFieldError(
      elements.coverageIntentReason,
      elements.coverageIntentError,
      new Error("Enter why this inventory gap is expected"),
    )
    return
  }
  const target = draft.issue || draft.expectation
  const timestamp = new Date().toISOString()
  const expectation = {
    createdAt: draft.expectation?.createdAt || timestamp,
    id: draft.expectation?.id || intentId("coverage"),
    kind: target.kind,
    observedCanonical: target.observedCanonical,
    reason,
    subjectId: target.subjectId,
    subjectLabel: target.subjectLabel,
    updatedAt: timestamp,
    zoneId: target.zoneId,
    zoneName: target.zoneName,
  }
  let document
  try {
    document = replaceFleetIntentCoverageExpectation(state.intent, expectation)
  } catch (error) {
    showFieldError(
      elements.coverageIntentReason,
      elements.coverageIntentError,
      error,
    )
    return
  }
  const saved = await persistIntentDocument(
    document,
    `Expected coverage saved for ${coverageTargetLabel(expectation)}`,
  )
  if (saved) elements.coverageIntentDialog.close()
}

async function syncFleetIntent(options = {}) {
  if (!api.usesBroker || state.intentSaving || state.intentSyncing) return false
  state.intentSyncing = true
  try {
    const latest = await api.loadFleetIntent()
    if (!isFleetIntentDocument(latest, auth.accountId)) {
      throw new Error("The broker returned an invalid fleet intent document")
    }
    if (latest.revision === state.intent.revision) return false
    state.intent = latest
    if (state.inventory) renderInventory(state.inventory, state.inventorySource)
    else renderIntentPolicyCard()
    if (!options.silent) toast("Newer fleet intent loaded from another dashboard window")
    return true
  } catch (error) {
    if (!options.silent) {
      toast(error instanceof Error ? error.message : String(error), "error")
    }
    return false
  } finally {
    state.intentSyncing = false
  }
}

function intentPolicyRow(policy) {
  return state.matrix?.rows.find(
    (row) => row.category === policy.facet.category
      && row.key === policy.facet.key,
  ) || null
}

function intentPoliciesForRow(row) {
  return state.intent.policies.filter(
    (policy) => policy.facet.category === row.category
      && policy.facet.key === row.key,
  )
}

function intentPolicyState(policyId) {
  return state.intentEvaluation?.policyStates.find(
    (entry) => entry.policy.id === policyId,
  ) || null
}

function rowIntentVariants(row, policies = []) {
  const variants = new Map(groupFleetRowIntentValues(
    row,
    state.inventory.zones,
  ).map((variant) => [variant.canonical, {
    ...variant,
    origin: FLEET_INTENT_EXPECTED_ORIGIN.OBSERVED,
  }]))
  for (const policy of policies) {
    if (policy.expected
      && !fleetIntentExpectedIsAuthored(policy.expected)
      && !variants.has(policy.expected.canonical)) {
      variants.set(policy.expected.canonical, {
        canonical: policy.expected.canonical,
        count: 0,
        display: policy.expected.display,
        origin: FLEET_INTENT_EXPECTED_ORIGIN.OBSERVED,
        resolutionCanonical: policy.expected.resolutionCanonical,
        sourceZoneId: policy.expected.sourceZoneId,
        sourceZoneName: policy.expected.sourceZoneName,
        value: cloneJsonValue(policy.expected.value),
        zones: [],
      })
    }
  }
  const comparison = compareFleetValueVariants([...variants.values()], {
    zoneCount: state.inventory.zones.length,
  })
  return {
    ...comparison,
    variants: comparison.variants.map((variant, index) => ({
      ...variant,
      optionValue: String(index),
    })),
  }
}

function selectedIntentPolicyVariant() {
  const selection = elements.intentPolicyValues.querySelector(
    'input[name="intent-policy-value"]:checked',
  )
  return state.intentPolicyDraft?.variants.find(
    (variant) => variant.optionValue === selection?.value,
  ) || null
}

function selectIntentPolicyVariant(optionValue) {
  const controls = elements.intentPolicyValues.querySelectorAll(
    'input[name="intent-policy-value"]',
  )
  for (const control of controls) {
    control.checked = control.value === optionValue
  }
}

function intentPolicyVariantLabel(comparison, variant, index) {
  if (variant.count === 0) return "Saved value"
  return valueComparisonVariantLabel(comparison, variant, index)
}

function intentPolicyValueChoice(comparison, variant, index) {
  const id = `intent-policy-value-${index}`
  const label = createElement("label", {
    className: "intent-policy-value-option",
  })
  label.htmlFor = id
  const control = document.createElement("input")
  control.id = id
  control.name = "intent-policy-value"
  control.required = true
  control.type = "radio"
  control.value = variant.optionValue
  const body = createElement("span", {
    className: "intent-policy-value-option-body",
  })
  const heading = createElement("span", {
    className: "intent-policy-value-option-heading",
  })
  heading.append(
    createElement("strong", {
      text: intentPolicyVariantLabel(comparison, variant, index),
    }),
    createElement("small", {
      text: variant.count === 0
        ? "Not observed"
        : `${variant.count} zone${variant.count === 1 ? "" : "s"}`,
    }),
  )
  const summary = comparison.differences.length > 0
    ? valueComparisonVariantSummary(comparison, index)
    : variant.display
  body.append(
    heading,
    createElement("small", {
      className: "intent-policy-value-option-summary",
      text: summary,
    }),
  )
  if (variant.sourceZoneName) {
    body.append(createElement("small", {
      className: "intent-policy-value-option-source",
      text: `Representative source: ${variant.sourceZoneName}`,
    }))
  }
  body.append(
    variant.zones.length > 0
      ? valueComparisonZoneList(variant.zones)
      : createElement("small", {
          className: "intent-policy-value-option-empty",
          text: "No loaded zone has this saved value",
        }),
  )
  label.append(control, body)
  return label
}

function renderIntentPolicyValueChoices() {
  const draft = state.intentPolicyDraft
  if (!draft) return
  const comparison = draft.valueComparison
  elements.intentPolicyValues.replaceChildren(...comparison.variants.map(
    (variant, index) => intentPolicyValueChoice(comparison, variant, index),
  ))
  if (comparison.variants.length === 0) {
    elements.intentPolicyValues.append(createElement("p", {
      className: "intent-policy-value-empty",
      text: "No observed value is available. Choose Custom value to define one.",
    }))
  }
  elements.intentPolicyDifferences.replaceChildren()
  if (comparison.variantCount < 2 || comparison.differences.length === 0) {
    elements.intentPolicyDifferences.hidden = true
    return
  }
  const heading = createElement("div", {
    className: "intent-policy-differences-heading",
  })
  heading.append(
    createElement("h3", { text: "What differs" }),
    createElement("p", {
      text: "Only fields that differ between these normalized values are shown.",
    }),
  )
  const table = createElement("div", {
    className: "value-comparison-table-wrap",
  })
  table.append(valueComparisonTable(comparison))
  elements.intentPolicyDifferences.append(heading, table)
  elements.intentPolicyDifferences.hidden = false
}

function selectedIntentPolicyValueMode() {
  return elements.intentPolicyModeCustom.checked
    ? INTENT_POLICY_VALUE_MODE.CUSTOM
    : INTENT_POLICY_VALUE_MODE.OBSERVED
}

function selectedIntentPolicyValueConstraint() {
  if (elements.intentPolicyConstraintMayDiffer.checked) {
    return FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER
  }
  if (elements.intentPolicyConstraintMustDiffer.checked) {
    return FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER
  }
  return FLEET_INTENT_VALUE_CONSTRAINT.EXACT
}

function selectedIntentPolicyPresenceConstraint() {
  if (elements.intentPolicyPresenceForbidden.checked) {
    return FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN
  }
  if (elements.intentPolicyPresenceOptional.checked) {
    return FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL
  }
  return FLEET_INTENT_PRESENCE_CONSTRAINT.REQUIRED
}

function intentPolicyPresenceLabel(policy) {
  const presenceConstraint = fleetIntentPolicyPresenceConstraint(policy)
  return INTENT_ADOPTION_PRESENCE_LABEL[presenceConstraint]
}

function intentPolicyValueConstraintLabel(policy) {
  const valueConstraint = fleetIntentPolicyValueConstraint(policy)
  if (valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER) {
    return "May differ"
  }
  if (valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER) {
    return "Must differ"
  }
  return "Exact value"
}

function intentPolicyConstraintLabel(policy) {
  const presenceConstraint = fleetIntentPolicyPresenceConstraint(policy)
  if (presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN) {
    return "Forbidden"
  }
  return `${intentPolicyPresenceLabel(policy)} | ${intentPolicyValueConstraintLabel(policy)}`
}

function observedIntentExpected(variant) {
  if (!variant) return null
  return {
    canonical: variant.canonical,
    display: variant.display,
    origin: FLEET_INTENT_EXPECTED_ORIGIN.OBSERVED,
    resolutionCanonical: variant.resolutionCanonical,
    sourceZoneId: variant.sourceZoneId,
    sourceZoneName: variant.sourceZoneName,
    value: structuredClone(variant.value),
  }
}

function intentExpectedSourceLabel(expected) {
  if (!expected) return ""
  return fleetIntentExpectedIsAuthored(expected)
    ? "custom value"
    : `source ${expected.sourceZoneName}`
}

function selectedIntentPolicyExpected() {
  if (selectedIntentPolicyPresenceConstraint()
    === FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN) return null
  if (selectedIntentPolicyValueConstraint() !== FLEET_INTENT_VALUE_CONSTRAINT.EXACT) {
    return null
  }
  if (selectedIntentPolicyValueMode() === INTENT_POLICY_VALUE_MODE.CUSTOM) {
    const draft = state.intentPolicyDraft?.customDraft
    if (draft === undefined) return null
    const expected = createAuthoredFleetIntentExpected(draft)
    const observedMatch = state.intentPolicyDraft.variants.find(
      (variant) => variant.canonical === expected.canonical,
    )
    if (observedMatch) {
      expected.resolutionCanonical = observedMatch.resolutionCanonical
    }
    return expected
  }
  return observedIntentExpected(selectedIntentPolicyVariant())
}

function renderIntentPolicyRemediation() {
  const support = intentPolicyRemediation(
    state.intentPolicyDraft?.row,
    selectedIntentPolicyExpected(),
    selectedIntentPolicyValueConstraint(),
    selectedIntentPolicyPresenceConstraint(),
  )
  elements.intentPolicyRemediation.className = `intent-remediation-status ${support.className}`
  elements.intentPolicyRemediation.textContent = support.text
}

function renderIntentPolicyPreview() {
  const variant = selectedIntentPolicyVariant()
  elements.intentPolicyPreview.replaceChildren(
    variant
      ? structuredValueElement(variant.value)
      : createElement("span", { text: "No expected value selected" }),
  )
  elements.intentPolicyRaw.textContent = variant
    ? formattedJson(variant.value)
    : ""
  renderIntentPolicyRemediation()
}

function syncIntentPolicyCustomJson() {
  const draft = state.intentPolicyDraft
  if (!draft) return
  elements.intentPolicyCustomRaw.value = formattedJson(draft.customDraft)
  elements.intentPolicyCustomRaw.removeAttribute("aria-invalid")
  draft.customJsonInvalid = false
  clearFieldError(elements.intentPolicyCustomRaw, elements.intentPolicyError)
}

function renderIntentPolicyCustomEditor() {
  const draft = state.intentPolicyDraft
  if (!draft) return
  elements.intentPolicyCustomKind.value = jsonValueKind(draft.customDraft)
  elements.intentPolicyCustomFields.replaceChildren(
    createGenericValueEditorFragment(draft.customDraft, {
      suggestions: draft.suggestions,
    }),
  )
}

function replaceIntentPolicyCustomDraft(value, options = {}) {
  const draft = state.intentPolicyDraft
  if (!draft) return
  draft.customDraft = value
  if (options.markDirty !== false) {
    draft.customDirty = true
    draft.formDirty = true
  }
  syncIntentPolicyCustomJson()
  if (options.render !== false) renderIntentPolicyCustomEditor()
  renderIntentPolicyRemediation()
}

function seedIntentPolicyCustomDraft() {
  const draft = state.intentPolicyDraft
  const variant = selectedIntentPolicyVariant()
  if (!draft || draft.customDirty || !variant) return
  replaceIntentPolicyCustomDraft(cloneJsonValue(variant.value), {
    markDirty: false,
  })
}

function renderIntentPolicyValueMode() {
  const valuesApply = selectedIntentPolicyPresenceConstraint()
    !== FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN
  const exact = valuesApply
    && selectedIntentPolicyValueConstraint() === FLEET_INTENT_VALUE_CONSTRAINT.EXACT
  const custom = exact
    && selectedIntentPolicyValueMode() === INTENT_POLICY_VALUE_MODE.CUSTOM
  elements.intentPolicyValueRelationship.hidden = !valuesApply
  for (const control of elements.intentPolicyValueRelationship.elements) {
    control.disabled = !valuesApply
  }
  elements.intentPolicyExactFields.hidden = !exact
  elements.intentPolicyModeObserved.disabled = !exact
    || state.intentPolicyDraft?.variants.length === 0
  elements.intentPolicyModeCustom.disabled = !exact
  elements.intentPolicyObservedFields.hidden = !exact || custom
  elements.intentPolicyCustomEditor.hidden = !custom
  for (const control of elements.intentPolicyValues.querySelectorAll(
    'input[name="intent-policy-value"]',
  )) {
    control.disabled = !exact || custom
    control.required = exact && !custom
  }
  for (const control of elements.intentPolicyCustomEditor.querySelectorAll(
    "button, input, select, textarea",
  )) {
    control.disabled = !custom
  }
  if (custom) {
    seedIntentPolicyCustomDraft()
    renderIntentPolicyCustomEditor()
    syncIntentPolicyCustomJson()
  }
  renderIntentPolicyRemediation()
}

function syncIntentPolicyCustomFromJson() {
  const draft = state.intentPolicyDraft
  if (!draft) return
  try {
    const value = JSON.parse(elements.intentPolicyCustomRaw.value)
    jsonValueKind(value)
    draft.customDraft = value
    draft.customDirty = true
    draft.formDirty = true
    draft.customJsonInvalid = false
    elements.intentPolicyCustomRaw.removeAttribute("aria-invalid")
    clearFieldError(elements.intentPolicyCustomRaw, elements.intentPolicyError)
    renderIntentPolicyCustomEditor()
    renderIntentPolicyRemediation()
  } catch {
    draft.customJsonInvalid = true
    elements.intentPolicyCustomRaw.setAttribute("aria-invalid", "true")
  }
}

function changeIntentPolicyCustomKind() {
  const draft = state.intentPolicyDraft
  if (!draft) return
  const kind = elements.intentPolicyCustomKind.value
  if (kind === jsonValueKind(draft.customDraft)) return
  replaceIntentPolicyCustomDraft(defaultValueForKind(kind))
  requestAnimationFrame(() => {
    elements.intentPolicyCustomFields.querySelector(".value-control")?.focus()
  })
}

function changeIntentPolicyValueMode() {
  if (state.intentPolicyDraft) state.intentPolicyDraft.formDirty = true
  renderIntentPolicyValueMode()
  renderIntentPolicyPreview()
}

function changeIntentPolicyValueConstraint() {
  if (state.intentPolicyDraft) state.intentPolicyDraft.formDirty = true
  renderIntentPolicyValueMode()
  renderIntentPolicyPreview()
}

function changeIntentPolicyPresenceConstraint() {
  if (state.intentPolicyDraft) state.intentPolicyDraft.formDirty = true
  renderIntentPolicyValueMode()
  renderIntentPolicyPreview()
}

function setIntentPolicyConstraintControls(presenceConstraint, valueConstraint) {
  elements.intentPolicyPresenceRequired.checked = presenceConstraint
    === FLEET_INTENT_PRESENCE_CONSTRAINT.REQUIRED
  elements.intentPolicyPresenceOptional.checked = presenceConstraint
    === FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL
  elements.intentPolicyPresenceForbidden.checked = presenceConstraint
    === FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN
  elements.intentPolicyConstraintExact.checked = valueConstraint
    === FLEET_INTENT_VALUE_CONSTRAINT.EXACT
  elements.intentPolicyConstraintMayDiffer.checked = valueConstraint
    === FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER
  elements.intentPolicyConstraintMustDiffer.checked = valueConstraint
    === FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER
}

function intentPolicyGroupsOverlap(leftGroup, rightGroup) {
  const leftZoneIds = new Set(
    intentGroupScope(leftGroup).applies.map((zone) => zone.zoneId),
  )
  return intentGroupScope(rightGroup).applies.some(
    (zone) => leftZoneIds.has(zone.zoneId),
  )
}

function renderIntentPolicyOverlap() {
  const draft = state.intentPolicyDraft
  const group = intentGroupById(elements.intentPolicyGroup.value)
  if (!draft || !group) {
    elements.intentPolicyOverlap.hidden = true
    elements.intentPolicyOverlap.textContent = ""
    return
  }
  const selectedPolicy = fleetIntentPolicyForGroup(draft.policies, group.id)
  const overlaps = draft.policies.filter((policy) => {
    if (policy.id === selectedPolicy?.id) return false
    const policyGroup = intentGroupById(policy.groupId)
    return policyGroup && intentPolicyGroupsOverlap(group, policyGroup)
  })
  if (overlaps.length === 0) {
    elements.intentPolicyOverlap.hidden = true
    elements.intentPolicyOverlap.textContent = ""
    return
  }
  const groupNames = [...new Set(overlaps.map((policy) => (
    intentGroupById(policy.groupId)?.name || "a missing group"
  )))]
  elements.intentPolicyOverlap.textContent = `Coverage overlaps saved intent in ${groupNames.join(", ")}. Compatible presence and value constraints combine on shared zones. Required with Forbidden, or different Exact values, are reported as conflicts.`
  elements.intentPolicyOverlap.hidden = false
}

function loadIntentPolicyGroupContext(groupId, options = {}) {
  const draft = state.intentPolicyDraft
  const group = intentGroupById(groupId)
  if (!draft || !group) return
  const scopeZones = intentGroupScope(group).applies
  const selection = fleetIntentPolicyGroupSelection(
    draft.row,
    scopeZones,
    draft.policies,
    group.id,
  )
  const presenceConstraint = options.presenceConstraint
    || selection.presenceConstraint
  const valueConstraint = options.valueConstraint || selection.valueConstraint
  const valuesApply = presenceConstraint
    !== FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN
  const exact = valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.EXACT
  const policyIsAuthored = valuesApply
    && exact
    && fleetIntentExpectedIsAuthored(selection.policy?.expected)
  const selectedCanonical = options.expectedCanonical
    || selection.expectedCanonical
  const selected = selectedCanonical
    ? draft.variants.find((variant) => variant.canonical === selectedCanonical)
    : draft.variants[0]
  const customSeed = policyIsAuthored
    ? selection.policy.expected.value
    : selected?.value ?? ""

  draft.activeGroupId = group.id
  draft.customDirty = policyIsAuthored
  draft.customDraft = cloneJsonValue(customSeed)
  draft.customJsonInvalid = false
  draft.policy = selection.policy
  elements.intentPolicyGroup.value = group.id
  renderIntentPolicyGroupScope()
  elements.intentPolicyTitle.textContent = selection.policy
    ? "Edit facet intent"
    : "Set facet intent"
  elements.intentPolicySave.textContent = selection.policy
    ? "Save group intent"
    : "Add group intent"
  selectIntentPolicyVariant(selected?.optionValue || draft.variants[0]?.optionValue || "")
  setIntentPolicyConstraintControls(presenceConstraint, valueConstraint)
  elements.intentPolicyModeObserved.checked = !policyIsAuthored
    && draft.variants.length > 0
  elements.intentPolicyModeCustom.checked = policyIsAuthored
    || draft.variants.length === 0
  elements.intentPolicyCustomJson.open = false
  elements.intentPolicyComplete.open = false
  elements.intentPolicyRaw.closest("details").open = false
  elements.intentPolicyError.hidden = true
  elements.intentPolicyError.textContent = ""
  renderIntentPolicyCustomEditor()
  syncIntentPolicyCustomJson()
  renderIntentPolicyValueMode()
  renderIntentPolicyPreview()
  renderIntentPolicyOverlap()
  draft.formDirty = Boolean(
    options.expectedCanonical
      || options.presenceConstraint
      || options.valueConstraint,
  )
}

function changeIntentPolicyGroup() {
  const draft = state.intentPolicyDraft
  const groupId = elements.intentPolicyGroup.value
  if (!draft) {
    renderIntentPolicyGroupScope()
    return
  }
  if (draft.formDirty && groupId !== draft.activeGroupId) {
    const activeGroup = intentGroupById(draft.activeGroupId)
    const discard = window.confirm(
      `Discard unsaved changes for ${activeGroup?.name || "the selected group"}?`,
    )
    if (!discard) {
      elements.intentPolicyGroup.value = draft.activeGroupId
      renderIntentPolicyGroupScope()
      return
    }
  }
  loadIntentPolicyGroupContext(groupId)
}

function changeObservedIntentPolicyValue() {
  if (state.intentPolicyDraft) state.intentPolicyDraft.formDirty = true
  seedIntentPolicyCustomDraft()
  renderIntentPolicyValueMode()
  renderIntentPolicyPreview()
}

function openIntentPolicyEditor(row, policy = null, options = {}) {
  if (!intentWritable()) {
    toast("Fleet intent editing is unavailable in this session", "error")
    return
  }
  const policies = intentPoliciesForRow(row)
  const valueComparison = rowIntentVariants(row, policies)
  const variants = valueComparison.variants
  const selectedGroupId = policy?.groupId
    || state.intent.groups.find(
      (group) => !fleetIntentPolicyForGroup(policies, group.id),
    )?.id
    || FLEET_INTENT_ALL_ZONES_GROUP_ID
  state.intentPolicyDraft = {
    activeGroupId: selectedGroupId,
    baseRevision: state.intent.revision,
    customDirty: false,
    customDraft: "",
    customJsonInvalid: false,
    formDirty: false,
    policies,
    policy: null,
    row,
    suggestions: collectValueSuggestions(variants.map((variant) => variant.value)),
    valueComparison,
    variants,
  }
  elements.intentPolicyTarget.textContent = `${matrixCategoryLabel(row.category)} | ${row.label}`
  renderIntentPolicyValueChoices()
  renderIntentPolicyGroupOptions(selectedGroupId, policies)
  loadIntentPolicyGroupContext(selectedGroupId, options)
  showDialog(elements.intentPolicyDialog, {
    fallbackFocus: () => matrixIntentReturnFocus(
      row,
      ".intent-set-policy",
    ),
    initialFocus: elements.intentPolicyGroup,
  })
}

async function saveIntentPolicy(event) {
  if (event.submitter?.value === "cancel") return
  event.preventDefault()
  const draft = state.intentPolicyDraft
  const presenceConstraint = selectedIntentPolicyPresenceConstraint()
  const valuesApply = presenceConstraint !== FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN
  const valueConstraint = valuesApply
    ? selectedIntentPolicyValueConstraint()
    : FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER
  const expected = selectedIntentPolicyExpected()
  const group = intentGroupById(elements.intentPolicyGroup.value)
  if (draft && draft.baseRevision !== state.intent.revision) {
    elements.intentPolicyError.textContent = "Fleet intent changed while this editor was open. Close and reopen it to review the latest policy."
    elements.intentPolicyError.hidden = false
    return
  }
  if (!draft || !group
    || (valuesApply
      && valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.EXACT
      && !expected)) {
    elements.intentPolicyError.textContent = "Choose coverage, presence, and a value relationship"
    elements.intentPolicyError.hidden = false
    return
  }
  if (valuesApply
    && valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.EXACT
    && selectedIntentPolicyValueMode() === INTENT_POLICY_VALUE_MODE.CUSTOM
    && draft.customJsonInvalid) {
    showFieldError(
      elements.intentPolicyCustomRaw,
      elements.intentPolicyError,
      "Enter valid JSON for the custom expected value",
    )
    elements.intentPolicyCustomJson.open = true
    elements.intentPolicyCustomRaw.focus()
    return
  }
  const policy = {
    expected,
    facet: {
      category: draft.row.category,
      description: draft.row.description || "",
      key: draft.row.key,
      label: draft.row.label,
    },
    groupId: group.id,
    id: fleetIntentPolicyForGroup(draft.policies, group.id)?.id
      || intentId("policy"),
    presenceConstraint,
    valueConstraint,
  }
  let document
  try {
    document = replaceFleetIntentPolicy(state.intent, policy)
  } catch (error) {
    elements.intentPolicyError.textContent = error instanceof Error ? error.message : String(error)
    elements.intentPolicyError.hidden = false
    return
  }
  const saved = await persistIntentDocument(
    document,
    `${draft.row.label} intent saved for ${group.name}`,
  )
  if (saved) elements.intentPolicyDialog.close()
}

function renderIntentGroupMembers(group) {
  const fragment = document.createDocumentFragment()
  const selectedMembers = new Map(
    (group?.members || []).map((member) => [member.zoneId, member]),
  )
  const loadedZoneIds = new Set()
  for (const zone of state.inventory?.zones || []) {
    loadedZoneIds.add(zone.meta.id)
    const label = createElement("label", { className: "target-option" })
    const checkbox = document.createElement("input")
    checkbox.type = "checkbox"
    checkbox.checked = selectedMembers.has(zone.meta.id)
    checkbox.dataset.zoneId = zone.meta.id
    checkbox.dataset.zoneName = zone.meta.name
    const copy = createElement("span")
    copy.append(createElement("strong", { text: zone.meta.name }))
    label.append(checkbox, copy)
    fragment.append(label)
  }
  for (const member of group?.members || []) {
    if (loadedZoneIds.has(member.zoneId)) continue
    const label = createElement("label", {
      className: "target-option intent-zone-unavailable",
    })
    const checkbox = document.createElement("input")
    checkbox.type = "checkbox"
    checkbox.checked = true
    checkbox.dataset.zoneId = member.zoneId
    checkbox.dataset.zoneName = member.zoneName
    checkbox.dataset.zoneUnavailable = ""
    const copy = createElement("span")
    copy.append(
      createElement("strong", { text: member.zoneName }),
      createElement("small", { text: "Unavailable in the loaded inventory" }),
    )
    label.append(checkbox, copy)
    fragment.append(label)
  }
  elements.intentGroupMembers.replaceChildren(fragment)
  updateIntentGroupSelectionSummary()
}

function updateIntentGroupSelectionSummary() {
  const inputs = [...elements.intentGroupMembers.querySelectorAll("input")]
  const zoneFromInput = (input) => ({
    unavailable: input.hasAttribute("data-zone-unavailable"),
    zoneId: input.dataset.zoneId,
    zoneName: input.dataset.zoneName,
  })
  const applies = inputs.filter((input) => input.checked).map(zoneFromInput)
  const excludes = inputs.filter((input) => (
    !input.checked && !input.hasAttribute("data-zone-unavailable")
  )).map(zoneFromInput)
  renderIntentZoneScope(elements.intentGroupSelectionSummary, {
    applies,
    excludes,
  })
  elements.intentGroupSelectionAnnouncement.textContent = `${applies.length} zone${applies.length === 1 ? "" : "s"} included; ${excludes.length} loaded zone${excludes.length === 1 ? "" : "s"} excluded`
  if (elements.intentGroupError.textContent === "Select at least one zone") {
    elements.intentGroupError.hidden = true
    elements.intentGroupError.textContent = ""
  }
}

function openIntentGroupEditor(group = null, options = {}) {
  if (!intentWritable()) {
    toast("Fleet intent editing is unavailable in this session", "error")
    return
  }
  state.intentGroupDraft = {
    adoptionCandidateId: options.adoptionCandidateId || null,
    baseRevision: state.intent.revision,
    group,
    returnToAdoption: Boolean(options.returnToAdoption),
    returnToPolicy: Boolean(options.returnToPolicy),
  }
  elements.intentGroupTitle.textContent = group ? "Edit zone group" : "New zone group"
  elements.intentGroupName.value = group?.name || ""
  elements.intentGroupError.hidden = true
  elements.intentGroupError.textContent = ""
  renderIntentGroupMembers(group)
  const initialFocus = elements.intentGroupMembers.querySelector("input:checked")
    || elements.intentGroupMembers.querySelector("input")
    || elements.intentGroupName
  showDialog(elements.intentGroupDialog, {
    initialFocus,
  })
}

async function saveIntentGroup(event) {
  if (event.submitter?.value === "cancel") return
  event.preventDefault()
  const groupDraft = state.intentGroupDraft
  const name = elements.intentGroupName.value.trim()
  const selectedZones = [...elements.intentGroupMembers.querySelectorAll("input:checked")]
  if (groupDraft?.baseRevision !== state.intent.revision) {
    showFieldError(
      elements.intentGroupName,
      elements.intentGroupError,
      new Error("Fleet intent changed while this editor was open. Close and reopen it to review the latest groups."),
    )
    return
  }
  if (!name) {
    showFieldError(
      elements.intentGroupName,
      elements.intentGroupError,
      new Error("Enter a group name"),
    )
    return
  }
  if (selectedZones.length === 0) {
    elements.intentGroupError.textContent = "Select at least one zone"
    elements.intentGroupError.hidden = false
    return
  }
  const group = {
    id: groupDraft?.group?.id || intentId("group"),
    members: selectedZones.map((checkbox) => {
      const zone = zoneById(checkbox.dataset.zoneId)
      return {
        zoneId: checkbox.dataset.zoneId,
        zoneName: zone?.meta.name || checkbox.dataset.zoneName,
      }
    }),
    mode: FLEET_INTENT_GROUP_MODE.MEMBERS,
    name,
  }
  let document
  try {
    document = replaceFleetIntentGroup(state.intent, group)
  } catch (error) {
    showFieldError(elements.intentGroupName, elements.intentGroupError, error)
    return
  }
  const saved = await persistIntentDocument(document, `${group.name} group saved`)
  if (saved) {
    if (groupDraft?.returnToPolicy && state.intentPolicyDraft) {
      state.intentPolicyDraft.baseRevision = state.intent.revision
      state.intentPolicyDraft.policies = intentPoliciesForRow(
        state.intentPolicyDraft.row,
      )
      renderIntentPolicyGroupOptions(
        group.id,
        state.intentPolicyDraft.policies,
      )
      loadIntentPolicyGroupContext(group.id)
    }
    let adoptionGroupSelect = null
    if (groupDraft?.returnToAdoption && state.intentAdoptionDraft) {
      state.intentAdoptionDraft.baseRevision = state.intent.revision
      const selection = state.intentAdoptionDraft.selections.get(
        groupDraft.adoptionCandidateId,
      )
      if (selection) {
        selectIntentAdoptionGroup(selection, group.id)
        const candidate = state.intentAdoptionDraft.candidates.find(
          (entry) => entry.id === groupDraft.adoptionCandidateId,
        )
        if (candidate) applyIntentAdoptionSelectionDefaults(candidate, selection)
      }
      renderIntentAdoptionCandidates()
      adoptionGroupSelect = state.intentAdoptionDraft.controls.get(
        groupDraft.adoptionCandidateId,
      )?.groupSelect || null
    }
    if (elements.intentGroupDialog.open) elements.intentGroupDialog.close()
    if (adoptionGroupSelect) {
      requestAnimationFrame(() => adoptionGroupSelect.focus({ preventScroll: true }))
    }
  }
}

function observedIntentValue(row, zone) {
  const cell = row.cells.get(zone.meta.name)
  return cell ? structuredClone(cell.inspectionValue) : null
}

function openIntentAcknowledgement(action) {
  if (!intentWritable()) return
  const policy = action.intentCell.policy
  const existing = state.intent.acknowledgements.find(
    (acknowledgement) => acknowledgement.policyId === policy.id
      && acknowledgement.zoneId === action.zone.meta.id,
  ) || null
  state.intentAcknowledgementDraft = {
    ...action,
    baseRevision: state.intent.revision,
    existing,
    policy,
  }
  elements.intentAcknowledgementTarget.textContent = `${action.zone.meta.name} | ${matrixCategoryLabel(action.row.category)} | ${action.row.label}. Only the exact state shown below will be accepted.`
  elements.intentAcknowledgementPreview.replaceChildren(
    action.intentCell.observedCanonical === FLEET_INTENT_MISSING_CANONICAL
      ? createElement("strong", { text: "Missing" })
      : structuredValueElement(observedIntentValue(action.row, action.zone)),
  )
  elements.intentAcknowledgementReason.value = existing?.reason || ""
  elements.intentAcknowledgementError.hidden = true
  elements.intentAcknowledgementError.textContent = ""
  showDialog(elements.intentAcknowledgementDialog, {
    fallbackFocus: () => matrixIntentReturnFocus(
      action.row,
      ".remove-acknowledgement, .acknowledge-intent",
      action.zone.meta.id,
    ),
    initialFocus: elements.intentAcknowledgementReason,
  })
}

async function saveIntentAcknowledgement(event) {
  if (event.submitter?.value === "cancel") return
  event.preventDefault()
  const draft = state.intentAcknowledgementDraft
  const reason = elements.intentAcknowledgementReason.value.trim()
  if (draft && draft.baseRevision !== state.intent.revision) {
    showFieldError(
      elements.intentAcknowledgementReason,
      elements.intentAcknowledgementError,
      new Error("Fleet intent changed while this editor was open. Close and reopen it to review the latest acknowledgement."),
    )
    return
  }
  if (!draft || !reason) {
    showFieldError(
      elements.intentAcknowledgementReason,
      elements.intentAcknowledgementError,
      new Error("Explain why this exact state is intentional"),
    )
    return
  }
  const now = new Date().toISOString()
  const acknowledgement = {
    createdAt: draft.existing?.createdAt || now,
    id: draft.existing?.id || intentId("ack"),
    observedCanonical: draft.intentCell.observedCanonical,
    policyId: draft.policy.id,
    reason,
    updatedAt: now,
    zoneId: draft.zone.meta.id,
    zoneName: draft.zone.meta.name,
  }
  let document
  try {
    document = replaceFleetIntentAcknowledgement(state.intent, acknowledgement)
  } catch (error) {
    showFieldError(
      elements.intentAcknowledgementReason,
      elements.intentAcknowledgementError,
      error,
    )
    return
  }
  const saved = await persistIntentDocument(
    document,
    `${draft.row.label} acknowledged on ${draft.zone.meta.name}`,
  )
  if (saved) elements.intentAcknowledgementDialog.close()
}

function requestIntentRemoval(options) {
  if (!intentWritable()) return
  state.intentDeleteDraft = {
    ...options,
    baseRevision: state.intent.revision,
  }
  elements.intentDeleteTitle.textContent = options.title
  elements.intentDeleteSummary.textContent = options.summary
  showDialog(elements.intentDeleteDialog, {
    fallbackFocus: options.fallbackFocus || intentManagerReturnFocus,
    initialFocus: elements.intentDeleteDialog.querySelector("[data-dialog-close]"),
  })
}

async function applyIntentRemoval(event) {
  if (event.submitter?.value === "cancel") return
  event.preventDefault()
  const draft = state.intentDeleteDraft
  if (!draft) return
  if (draft.baseRevision !== state.intent.revision) {
    elements.intentDeleteDialog.close()
    toast("Fleet intent changed while this confirmation was open. Review the latest state and try again.", "error")
    return
  }
  let document
  try {
    document = draft.remove(state.intent)
  } catch (error) {
    elements.intentDeleteDialog.close()
    toast(error instanceof Error ? error.message : String(error), "error")
    return
  }
  const saved = await persistIntentDocument(document, draft.successMessage)
  if (saved) elements.intentDeleteDialog.close()
}

function showIntentPolicyInMatrix(policy) {
  const row = intentPolicyRow(policy)
  if (!row) {
    toast("This intent facet is not present in the loaded matrix", "error")
    return
  }
  elements.intentDialog.close()
  elements.search.value = ""
  elements.category.value = row.category
  elements.scope.value = MATRIX_SCOPE.ALL
  elements.dnsType.value = ""
  elements.redirectType.value = ""
  elements.differenceToggle.setAttribute("aria-pressed", "false")
  elements.targetHoles.setAttribute("aria-pressed", "false")
  elements.targetHoles.textContent = "Target holes"
  syncDnsTypeAvailability()
  syncRedirectTypeAvailability()
  filterRows()
  const tableRow = [...elements.matrixBody.querySelectorAll("tr")].find(
    (candidate) => candidate.dataset.category === row.category
      && candidate.dataset.facetKey === row.key,
  )
  tableRow?.scrollIntoView({
    behavior: prefersReducedMotion() ? "auto" : "smooth",
    block: "center",
  })
  const focusTarget = tableRow?.querySelector(".intent-set-policy, .cell-action")
  if (focusTarget && !focusTarget.disabled) focusMatrixAction(focusTarget)
}

function intentStatusBadge(text, status) {
  return createElement("span", {
    className: `intent-status-badge ${status}`,
    text,
  })
}

function intentItemActions() {
  return createElement("div", { className: "intent-item-actions" })
}

function intentActionButton(label, action, options = {}) {
  const button = createElement("button", {
    className: `button ${options.danger ? "button-danger" : "button-quiet"}`,
    text: label,
  })
  button.type = "button"
  button.disabled = Boolean(options.write && !intentWritable())
  if (options.write) button.dataset.intentWrite = ""
  if (options.context) {
    button.setAttribute("aria-label", contextualActionLabel(label, options.context))
  }
  if (options.title) button.title = options.title
  button.addEventListener("click", action)
  return button
}

function renderIntentGroups() {
  const fragment = document.createDocumentFragment()
  const loadedZoneIds = state.inventory
    ? new Set(state.inventory.zones.map((zone) => zone.meta.id))
    : null
  for (const group of state.intent.groups) {
    const unavailableMembers = group.mode === FLEET_INTENT_GROUP_MODE.MEMBERS
      && loadedZoneIds
      ? group.members.filter((member) => !loadedZoneIds.has(member.zoneId))
      : []
    const scope = intentGroupScope(group)
    const item = createElement("article", {
      className: `intent-item ${unavailableMembers.length > 0 ? "unresolved" : "active"}`,
    })
    const heading = createElement("div", { className: "intent-item-heading" })
    heading.append(
      createElement("h4", { text: intentGroupPrimaryText(group, scope) }),
      intentStatusBadge(
        group.mode === FLEET_INTENT_GROUP_MODE.ALL
          ? "Dynamic"
          : unavailableMembers.length > 0
            ? `${unavailableMembers.length} unavailable`
            : "Named",
        unavailableMembers.length > 0 ? "unresolved" : "active",
      ),
    )
    const membershipDescription = group.mode === FLEET_INTENT_GROUP_MODE.ALL
      ? "Membership follows the loaded inventory"
      : "Membership stays fixed until edited"
    const summary = createElement("p", {
      className: "intent-item-summary",
      text: `Group label: ${group.name} | ${membershipDescription}`,
    })
    item.append(heading, summary)
    if (group.mode === FLEET_INTENT_GROUP_MODE.ALL
      || scope.applies.length > INTENT_ZONE_SUMMARY_LIMIT
      || unavailableMembers.length > 0) {
      const scopeDetails = createElement("div", {
        className: "intent-zone-scope intent-item-scope",
      })
      scopeDetails.append(
        intentZoneScopeRow("Member zones", scope.applies, "No zones"),
      )
      item.append(scopeDetails)
    }
    if (group.mode === FLEET_INTENT_GROUP_MODE.MEMBERS) {
      const actions = intentItemActions()
      const inUse = state.intent.policies.some((policy) => policy.groupId === group.id)
      actions.append(
        intentActionButton("Edit", () => openIntentGroupEditor(group), {
          context: group.name,
          write: true,
        }),
        intentActionButton("Remove", () => requestIntentRemoval({
          remove: (document) => removeFleetIntentGroup(document, group.id),
          successMessage: `${group.name} group removed`,
          summary: `Remove ${group.name}? Its saved membership will be discarded.`,
          title: "Remove zone group",
        }), {
          context: group.name,
          danger: true,
          title: inUse ? "Remove policies that use this group first" : "",
          write: true,
        }),
      )
      actions.lastElementChild.dataset.intentBlocked = String(inUse)
      actions.lastElementChild.disabled = inUse || !intentWritable()
      item.append(actions)
    }
    fragment.append(item)
  }
  elements.intentGroupList.replaceChildren(fragment)
}

function orderedIntentPolicies(layers) {
  const facetOrder = new Map()
  for (const policy of state.intent.policies) {
    const facetId = fleetIntentFacetId(policy.facet.category, policy.facet.key)
    if (!facetOrder.has(facetId)) facetOrder.set(facetId, facetOrder.size)
  }
  return [...state.intent.policies].sort((left, right) => {
    const leftFacetId = fleetIntentFacetId(left.facet.category, left.facet.key)
    const rightFacetId = fleetIntentFacetId(right.facet.category, right.facet.key)
    const facetCompared = facetOrder.get(leftFacetId) - facetOrder.get(rightFacetId)
    if (facetCompared !== 0) return facetCompared
    const roleCompared = INTENT_POLICY_LAYER_ORDER[layers.get(left.id).role]
      - INTENT_POLICY_LAYER_ORDER[layers.get(right.id).role]
    if (roleCompared !== 0) return roleCompared
    const leftGroupName = intentGroupById(left.groupId)?.name || ""
    const rightGroupName = intentGroupById(right.groupId)?.name || ""
    return leftGroupName.localeCompare(rightGroupName)
  })
}

function intentPolicyLayerSummary(layer) {
  if (layer.role === FLEET_INTENT_POLICY_LAYER_ROLE.BASELINE) {
    return `Refined for ${layer.narrowerGroupNames.join(", ")}`
  }
  if (layer.role === FLEET_INTENT_POLICY_LAYER_ROLE.REFINEMENT) {
    return `Refines ${layer.broaderGroupNames.join(", ")}`
  }
  if (layer.role === FLEET_INTENT_POLICY_LAYER_ROLE.OVERLAP) {
    return `Shares coverage with ${layer.overlappingGroupNames.join(", ")}`
  }
  return ""
}

function renderIntentPolicies() {
  const fragment = document.createDocumentFragment()
  const layers = fleetIntentPolicyLayers(
    state.intent.policies,
    state.intent.groups,
    (state.inventory?.zones || []).map((zone) => zone.meta.id),
  )
  for (const policy of orderedIntentPolicies(layers)) {
    const layer = layers.get(policy.id)
    const layerPresentation = FLEET_INTENT_POLICY_LAYER_PRESENTATION[layer.role]
    const policyState = intentPolicyState(policy.id)
    const row = intentPolicyRow(policy)
    const rowState = row ? intentRowState(row) : null
    const conflicted = rowState
      ? [...rowState.cells.values()].some(
          (cell) => cell.status === FLEET_INTENT_CELL_STATUS.CONFLICT
            && cell.policies.some((entry) => entry.id === policy.id),
        )
      : false
    const actionableCount = policyState?.actionableCount || 0
    const status = !row || policyState?.unresolved
      ? "unresolved"
      : conflicted || actionableCount > 0
        ? "actionable"
        : "aligned"
    const statusLabel = status === "unresolved"
      ? "Unresolved"
      : status === "actionable"
        ? conflicted ? "Conflict" : `${actionableCount} actionable`
        : "Aligned"
    const group = intentGroupById(policy.groupId)
    const groupScope = intentGroupScope(group)
    const actionContext = group
      ? `${policy.facet.label} for ${group.name}`
      : policy.facet.label
    const presenceConstraint = fleetIntentPolicyPresenceConstraint(policy)
    const valueConstraint = fleetIntentPolicyValueConstraint(policy)
    const remediation = intentPolicyRemediation(
      row,
      policy.expected,
      valueConstraint,
      presenceConstraint,
    )
    const correction = row
      ? dnssecIntentCorrection(row, { policyId: policy.id })
      : null
    const item = createElement("article", {
      className: `intent-item ${status} ${layer.role}`,
    })
    const heading = createElement("div", { className: "intent-item-heading" })
    const badges = createElement("div", { className: "intent-item-badges" })
    const remediationBadge = intentStatusBadge(
      INTENT_REMEDIATION_PRESENTATION[remediation.className].label,
      remediation.className,
    )
    remediationBadge.title = remediation.text
    badges.append(intentStatusBadge(statusLabel, status))
    if (layerPresentation.label) {
      badges.append(intentStatusBadge(
        layerPresentation.label,
        layerPresentation.status,
      ))
    }
    if (remediation.className !== INTENT_REMEDIATION_KIND.ALLOWANCE) {
      badges.append(remediationBadge)
    }
    heading.append(
      createElement("h4", { text: policy.facet.label }),
      badges,
    )
    item.append(
      heading,
      createElement("p", {
        className: "intent-item-summary",
        text: [
          matrixCategoryLabel(policy.facet.category),
          group
            ? `Applies to ${intentGroupPrimaryText(group, groupScope)}`
            : "Missing group",
          group ? `Group: ${group.name}` : "",
          intentPolicyLayerSummary(layer),
          `Presence: ${intentPolicyPresenceLabel(policy)}`,
          presenceConstraint !== FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN
            ? `Values: ${intentPolicyValueConstraintLabel(policy)}`
            : "",
          presenceConstraint !== FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN
            && valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.EXACT
            ? intentExpectedSourceLabel(policy.expected)
            : "",
        ].filter(Boolean).join(" | "),
      }),
    )
    const value = createElement("div", { className: "intent-item-value" })
    if (presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN) {
      value.textContent = "This facet must be absent"
    } else if (valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.EXACT) {
      value.append(structuredValueElement(policy.expected.value))
    } else {
      value.textContent = valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER
        ? presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL
          ? layer.role === FLEET_INTENT_POLICY_LAYER_ROLE.BASELINE
            ? "Fleet baseline: the facet may be absent, and any present value is accepted"
            : "The facet may be absent, and any present value is accepted"
          : "Every covered zone must have a value; present values may differ"
        : presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL
          ? "Any present values must be distinct"
          : "Every covered zone must have a distinct value"
    }
    item.append(value)
    const actions = intentItemActions()
    actions.append(
      intentActionButton("Show", () => showIntentPolicyInMatrix(policy), {
        context: actionContext,
      }),
    )
    if (correction?.available) {
      const correctionCount = correction.targets.length
      actions.append(intentActionButton(
        `Align ${correctionCount} zone${correctionCount === 1 ? "" : "s"}`,
        () => reviewDnssecIntentCorrection(
          correction,
          `Align ${policy.facet.label} with fleet intent`,
        ),
        {
          context: actionContext,
          title: `Live-validate and preview DNSSEC status changes for ${correctionCount} zone${correctionCount === 1 ? "" : "s"}`,
          write: true,
        },
      ))
    }
    if (row) {
      actions.append(
        intentActionButton("Edit", () => openIntentPolicyEditor(row, policy), {
          context: actionContext,
          write: true,
        }),
        intentActionButton("Add coverage", () => openIntentPolicyEditor(row), {
          context: actionContext,
          title: "Add another zone group with its own presence and value rules",
          write: true,
        }),
      )
    }
    actions.append(
      intentActionButton("Remove", () => requestIntentRemoval({
        remove: (document) => removeFleetIntentPolicy(document, policy.id),
        successMessage: `${policy.facet.label} intent removed`,
        summary: `Remove intent for ${policy.facet.label}? Its acknowledgements will also be removed.`,
        title: "Remove facet intent",
      }), { context: actionContext, danger: true, write: true }),
    )
    item.append(actions)
    fragment.append(item)
  }
  if (fragment.childNodes.length === 0) {
    fragment.append(createElement("p", {
      className: "intent-empty",
      text: "No facet policies yet. Use Set intent on a matrix row to define one.",
    }))
  }
  elements.intentPolicyList.replaceChildren(fragment)
}

function showCoverageExpectation(expectationState) {
  const section = expectationState.status
    === FLEET_INTENT_COVERAGE_EXPECTATION_STATUS.CHANGED
    ? COVERAGE_SECTION.UNEXPECTED
    : COVERAGE_SECTION.EXPECTED
  state.coverageExpanded[section] = true
  syncCoverageVisibility()
  elements.intentDialog.close()
  const toggle = section === COVERAGE_SECTION.UNEXPECTED
    ? elements.coverageUnexpectedToggle
    : elements.coverageExpectedToggle
  toggle.scrollIntoView({
    behavior: prefersReducedMotion() ? "auto" : "smooth",
    block: "center",
  })
  toggle.focus({ preventScroll: true })
}

function renderIntentCoverageExpectations() {
  const fragment = document.createDocumentFragment()
  const expectationStates = state.coverageEvaluation?.expectationStates
    || state.intent.coverageExpectations.map((expectation) => ({
      expectation,
      issue: null,
      status: FLEET_INTENT_COVERAGE_EXPECTATION_STATUS.INACTIVE,
    }))
  for (const expectationState of expectationStates) {
    const expectation = expectationState.expectation
    const actionContext = coverageTargetLabel(expectation)
    const status = expectationState.status
    const presentation = status === FLEET_INTENT_COVERAGE_EXPECTATION_STATUS.ACTIVE
      ? {
          className: "aligned",
          label: "Expected",
          summary: "The exact saved failure is active and shown in yellow",
        }
      : status === FLEET_INTENT_COVERAGE_EXPECTATION_STATUS.CHANGED
        ? {
            className: "actionable",
            label: "Changed",
            summary: "The current failure differs and is shown in red",
          }
        : {
            className: "stale",
            label: "Inactive",
            summary: "No matching failure is present in the loaded inventory",
          }
    const item = createElement("article", {
      className: `intent-item ${presentation.className}`,
    })
    const heading = createElement("div", { className: "intent-item-heading" })
    heading.append(
      createElement("h4", { text: coverageTargetLabel(expectation) }),
      intentStatusBadge(presentation.label, presentation.className),
    )
    item.append(
      heading,
      createElement("p", {
        className: "intent-item-summary",
        text: presentation.summary,
      }),
      createElement("div", {
        className: "intent-item-value",
        text: expectation.reason,
      }),
    )
    const actions = intentItemActions()
    actions.append(
      intentActionButton("Show coverage", () => {
        showCoverageExpectation(expectationState)
      }, { context: actionContext }),
      intentActionButton("Edit", () => {
        openCoverageIntentEditor(expectationState.issue, expectation)
      }, { context: actionContext, write: true }),
      intentActionButton("Remove", () => requestIntentRemoval({
        remove: (document) => removeFleetIntentCoverageExpectation(
          document,
          expectation.id,
        ),
        successMessage: `Expected coverage removed for ${coverageTargetLabel(expectation)}`,
        summary: `Remove expected coverage for ${coverageTargetLabel(expectation)}? A matching failure will return to unexpected coverage.`,
        title: "Remove expected coverage",
      }), { context: actionContext, danger: true, write: true }),
    )
    item.append(actions)
    fragment.append(item)
  }
  if (fragment.childNodes.length === 0) {
    fragment.append(createElement("p", {
      className: "intent-empty",
      text: "No inventory gaps are marked as expected. Use Mark expected beside a red coverage issue.",
    }))
  }
  elements.intentCoverageList.replaceChildren(fragment)
}

function renderIntentAcknowledgements() {
  const fragment = document.createDocumentFragment()
  for (const entry of state.intentEvaluation?.acknowledgementStates || []) {
    const acknowledgement = entry.acknowledgement
    const policy = intentPolicyById(acknowledgement.policyId)
    const actionContext = `${policy?.facet.label || "Unknown facet"} on ${acknowledgement.zoneName}`
    const status = entry.status === FLEET_INTENT_ACKNOWLEDGEMENT_STATUS.ACTIVE
      ? "active"
      : "stale"
    const item = createElement("article", { className: `intent-item ${status}` })
    const heading = createElement("div", { className: "intent-item-heading" })
    heading.append(
      createElement("h4", {
        text: `${acknowledgement.zoneName} | ${policy?.facet.label || "Unknown facet"}`,
      }),
      intentStatusBadge(status === "active" ? "Active" : "Stale", status),
    )
    item.append(
      heading,
      createElement("p", {
        className: "intent-item-summary",
        text: status === "active"
          ? acknowledgement.reason
          : `${entry.reason}. Saved reason: ${acknowledgement.reason}`,
      }),
    )
    const actions = intentItemActions()
    if (policy) {
      actions.append(intentActionButton("Show", () => showIntentPolicyInMatrix(policy), {
        context: actionContext,
      }))
    }
    actions.append(intentActionButton("Remove", () => requestIntentRemoval({
      remove: (document) => removeFleetIntentAcknowledgement(document, acknowledgement.id),
      successMessage: `Acknowledgement removed for ${acknowledgement.zoneName}`,
      summary: `Remove this acknowledgement for ${acknowledgement.zoneName}? The observed difference will return to actionable drift when its policy still applies.`,
      title: "Remove acknowledgement",
    }), { context: actionContext, danger: true, write: true }))
    item.append(actions)
    fragment.append(item)
  }
  if (fragment.childNodes.length === 0) {
    fragment.append(createElement("p", {
      className: "intent-empty",
      text: "No intentional differences have been acknowledged.",
    }))
  }
  elements.intentAcknowledgementList.replaceChildren(fragment)
}

function intentAdoptionSelectedEntries() {
  const draft = state.intentAdoptionDraft
  if (!draft) return []
  return draft.candidates
    .filter((candidate) => draft.selections.get(candidate.id)?.selected)
    .map((candidate) => ({
      candidate,
      selection: draft.selections.get(candidate.id),
    }))
}

function intentAdoptionCandidateMatches(candidate) {
  const search = elements.intentAdoptionSearch.value.trim().toLowerCase()
  const category = elements.intentAdoptionCategory.value
  const pattern = elements.intentAdoptionPattern.value
  if (search && !candidate.search.includes(search)) return false
  if (category && candidate.category !== category) return false
  if (pattern === INTENT_ADOPTION_FILTER.HIGH
    && candidate.confidence !== INTENT_ADOPTION_CONFIDENCE.HIGH) return false
  if (pattern === INTENT_ADOPTION_FILTER.REVIEW
    && candidate.confidence !== INTENT_ADOPTION_CONFIDENCE.REVIEW) return false
  if (pattern === INTENT_ADOPTION_FILTER.MISSING
    && candidate.missingCount === 0) return false
  if (pattern === INTENT_ADOPTION_FILTER.ZONE_SPECIFIC
    && candidate.classification
      !== INTENT_ADOPTION_CLASSIFICATION.ZONE_SPECIFIC) return false
  return true
}

function filterIntentAdoptionCandidates() {
  const draft = state.intentAdoptionDraft
  if (!draft) return
  let visibleCount = 0
  for (const candidate of draft.candidates) {
    const visible = intentAdoptionCandidateMatches(candidate)
    draft.controls.get(candidate.id).card.hidden = !visible
    if (visible) visibleCount += 1
  }
  draft.empty.hidden = visibleCount > 0
  const selectedCount = intentAdoptionSelectedEntries().length
  elements.intentAdoptionVisible.textContent = `${visibleCount} suggestion${visibleCount === 1 ? "" : "s"} shown | ${selectedCount} selected`
}

function intentAdoptionMetric(value, label, status = "") {
  const metric = createElement("span", {
    className: `intent-adoption-impact-metric${status ? ` ${status}` : ""}`,
  })
  metric.append(
    createElement("strong", { text: String(value) }),
    createElement("span", { text: label }),
  )
  return metric
}

function renderIntentAdoptionImpact() {
  const draft = state.intentAdoptionDraft
  if (!draft) return
  const entries = intentAdoptionSelectedEntries()
  elements.intentAdoptionError.hidden = true
  elements.intentAdoptionError.textContent = ""
  if (entries.length === 0) {
    draft.preview = null
    elements.intentAdoptionImpactTitle.textContent = "No suggestions selected"
    elements.intentAdoptionImpactSummary.textContent = "Select one or more suggestions to preview how the loaded fleet would evaluate under them."
    elements.intentAdoptionImpactMetrics.replaceChildren()
    elements.intentAdoptionSave.textContent = "Save selected intents"
    elements.intentAdoptionSave.disabled = true
    filterIntentAdoptionCandidates()
    return
  }
  try {
    draft.preview = previewIntentAdoption(
      state.intent,
      state.inventory,
      state.matrix,
      entries,
    )
    const summary = draft.preview.summary
    elements.intentAdoptionImpactTitle.textContent = `${summary.policiesAdded} suggested polic${summary.policiesAdded === 1 ? "y" : "ies"} ready`
    elements.intentAdoptionImpactSummary.textContent = summary.actionableCells === 0
      ? `All ${summary.targetedCells} covered cells satisfy the selected policies. Future drift will become visible against durable intent.`
      : `${summary.matchingCells} of ${summary.targetedCells} covered cells already satisfy the selected policies; ${summary.actionableCells} would enter the actionable queue.`
    elements.intentAdoptionImpactMetrics.replaceChildren(
      intentAdoptionMetric(summary.policiesAdded, "Policies"),
      intentAdoptionMetric(summary.matchingCells, "Match", "aligned"),
      intentAdoptionMetric(
        summary.actionableCells,
        "Actionable",
        summary.actionableCells > 0 ? "actionable" : "aligned",
      ),
      intentAdoptionMetric(summary.missingCells, "Required missing"),
      intentAdoptionMetric(summary.variantCells, "Variants"),
      ...(summary.conflictCells > 0
        ? [intentAdoptionMetric(summary.conflictCells, "Conflicts", "actionable")]
        : []),
    )
    elements.intentAdoptionSave.textContent = `Save ${summary.policiesAdded} intent${summary.policiesAdded === 1 ? "" : "s"}`
    elements.intentAdoptionSave.disabled = !intentWritable()
  } catch (error) {
    draft.preview = null
    elements.intentAdoptionImpactTitle.textContent = "Preview unavailable"
    elements.intentAdoptionImpactSummary.textContent = "Review the selected scope, presence, and value relationship."
    elements.intentAdoptionImpactMetrics.replaceChildren()
    elements.intentAdoptionError.textContent = error instanceof Error ? error.message : String(error)
    elements.intentAdoptionError.hidden = false
    elements.intentAdoptionSave.disabled = true
  }
  filterIntentAdoptionCandidates()
}

function intentAdoptionGroupOption(group) {
  const scope = intentGroupScope(group)
  const option = createElement("option", {
    text: `${intentGroupPrimaryText(group, scope)} | Group: ${group.name}`,
  })
  option.value = group.id
  return option
}

function intentAdoptionCreateGroupOption() {
  const option = createElement("option", {
    text: "+ Create new zone group...",
  })
  option.value = INTENT_ADOPTION_CREATE_GROUP_VALUE
  return option
}

function renderIntentAdoptionGroupDetails(container, summary, groupId) {
  const group = intentGroupById(groupId)
  const scope = intentGroupScope(group)
  summary.textContent = group
    ? `${intentGroupPrimaryText(group, scope)} | Group: ${group.name}`
    : "Missing zone group"
  renderIntentZoneScope(container, scope, {
    groupName: group?.name || "Missing group",
  })
}

function applyIntentAdoptionSelectionDefaults(candidate, selection) {
  if (selection.constraintsDirty) return
  const row = state.matrix.rows.find(
    (entry) => entry.category === candidate.category
      && entry.key === candidate.key,
  )
  const group = intentGroupById(selection.groupId)
  const scopeZones = intentGroupScope(group).applies
  const defaults = defaultFleetIntentPolicyConstraints(row, scopeZones)
  selection.presenceConstraint = defaults.presenceConstraint
  selection.valueConstraint = defaults.valueConstraint
  if (defaults.valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.EXACT) {
    selection.expectedCanonical = firstFleetIntentObservedCanonical(
      row,
      scopeZones,
    ) || candidate.variants[0].canonical
  }
}

function intentAdoptionVariantLabel(variant) {
  return `${variant.count} zone${variant.count === 1 ? "" : "s"} | ${variant.sourceZoneName} | ${variant.display}`
}

function lazyStructuredValueDetails(summaryText, value) {
  const details = document.createElement("details")
  details.append(createElement("summary", { text: summaryText }))
  details.addEventListener("toggle", () => {
    if (details.open) details.append(structuredValueElement(value))
  }, { once: true })
  return details
}

function renderIntentAdoptionValuePreview(container, candidate, selection) {
  if (selection.presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN) {
    container.replaceChildren(createElement("span", {
      text: "This facet must be absent from every covered zone.",
    }))
    return
  }
  if (selection.valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER) {
    container.replaceChildren(createElement("span", {
      text: selection.presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL
        ? "Covered zones may omit this facet; any present values may differ."
        : "Every covered zone must have this facet; present values may differ.",
    }))
    return
  }
  if (selection.valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER) {
    container.replaceChildren(createElement("span", {
      text: selection.presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL
        ? "Covered zones may omit this facet; any present values must be distinct."
        : "Every covered zone must have this facet and a distinct value.",
    }))
    return
  }
  const variant = candidate.variants.find(
    (entry) => entry.canonical === selection.expectedCanonical,
  )
  if (!variant) {
    container.replaceChildren(createElement("span", {
      text: "Choose an observed expected value",
    }))
    return
  }
  if (variant.value === null || typeof variant.value !== "object") {
    container.replaceChildren(structuredValueElement(variant.value))
    return
  }
  const summary = createElement("div", {
    className: "intent-adoption-compact-value",
  })
  summary.append(
    createElement("strong", { text: variant.display }),
    createElement("span", { text: `Observed source: ${variant.sourceZoneName}` }),
  )
  const details = lazyStructuredValueDetails(
    "Inspect selected value",
    variant.value,
  )
  container.replaceChildren(summary, details)
}

function intentAdoptionVariantList(candidate) {
  const list = createElement("ul", { className: "intent-adoption-variant-list" })
  for (const variant of candidate.variants) {
    const item = document.createElement("li")
    const heading = createElement("div", { className: "intent-adoption-variant-heading" })
    heading.append(
      createElement("strong", {
        text: `${variant.count} zone${variant.count === 1 ? "" : "s"}`,
      }),
      createElement("span", { text: `Source: ${variant.sourceZoneName}` }),
    )
    const value = createElement("div", { className: "intent-adoption-variant-value" })
    value.append(structuredValueElement(variant.value))
    item.append(heading, value)
    list.append(item)
  }
  return list
}

function renderIntentAdoptionCandidate(candidate, index) {
  const draft = state.intentAdoptionDraft
  const selection = draft.selections.get(candidate.id)
  const card = createElement("article", {
    className: `intent-adoption-candidate${selection.selected ? " selected" : ""}`,
  })
  const overview = createElement("div", { className: "intent-adoption-overview" })
  const selectionLabel = createElement("label", {
    className: "intent-adoption-select",
  })
  const checkbox = document.createElement("input")
  checkbox.type = "checkbox"
  checkbox.id = `intent-adoption-candidate-${index}`
  checkbox.checked = selection.selected
  const title = createElement("span")
  title.append(
    createElement("strong", { text: candidate.label }),
    createElement("small", { text: candidate.category }),
  )
  selectionLabel.htmlFor = checkbox.id
  selectionLabel.append(checkbox, title)
  const badges = createElement("div", { className: "intent-item-badges" })
  const presentation = INTENT_ADOPTION_CLASSIFICATION_PRESENTATION[
    candidate.classification
  ]
  badges.append(intentStatusBadge(presentation.label, presentation.status))
  if (candidate.missingCount > 0
    && candidate.classification !== INTENT_ADOPTION_CLASSIFICATION.MISSING_COVERAGE) {
    badges.append(intentStatusBadge(`${candidate.missingCount} absent`, "allowance"))
  }
  const heading = createElement("div", { className: "intent-adoption-candidate-heading" })
  heading.append(selectionLabel, badges)
  const leadingCount = candidate.variants[0]?.count || 0
  overview.append(
    heading,
    createElement("p", {
      className: "intent-adoption-observation",
      text: `${candidate.presentCount}/${state.inventory.zones.length} present | ${candidate.variants.length} observed variant${candidate.variants.length === 1 ? "" : "s"} | leading value ${leadingCount}/${candidate.presentCount}`,
    }),
    createElement("p", {
      className: "intent-adoption-recommendation",
      text: `Suggestion: ${candidate.recommendation.reason}`,
    }),
  )
  const variants = document.createElement("details")
  variants.className = "intent-adoption-variants"
  variants.append(createElement("summary", {
    text: `Compare ${candidate.variants.length} observed variant${candidate.variants.length === 1 ? "" : "s"}`,
  }))
  variants.addEventListener("toggle", () => {
    if (variants.open) variants.append(intentAdoptionVariantList(candidate))
  }, { once: true })
  overview.append(variants)

  const controls = createElement("div", { className: "intent-adoption-controls" })
  const groupField = createElement("label", { className: "intent-adoption-field" })
  groupField.append(createElement("span", { text: "Applies to zones" }))
  const groupSelect = document.createElement("select")
  groupSelect.id = `intent-adoption-group-${index}`
  groupSelect.name = `intent-adoption-group-${index}`
  groupField.htmlFor = groupSelect.id
  groupSelect.setAttribute(
    "aria-label",
    `Applies to zones for ${candidate.label}`,
  )
  groupSelect.replaceChildren(
    ...state.intent.groups.map(intentAdoptionGroupOption),
    intentAdoptionCreateGroupOption(),
  )
  groupSelect.value = selection.groupId
  groupField.append(groupSelect)

  const presenceField = createElement("label", { className: "intent-adoption-field" })
  presenceField.append(createElement("span", { text: "Presence" }))
  const presenceSelect = document.createElement("select")
  presenceSelect.id = `intent-adoption-presence-${index}`
  presenceSelect.name = `intent-adoption-presence-${index}`
  presenceField.htmlFor = presenceSelect.id
  for (const presenceConstraint of INTENT_PRESENCE_OPTIONS) {
    const option = createElement("option", {
      text: INTENT_ADOPTION_PRESENCE_LABEL[presenceConstraint],
    })
    option.value = presenceConstraint
    presenceSelect.append(option)
  }
  presenceSelect.value = selection.presenceConstraint
  presenceField.append(presenceSelect)

  const constraintField = createElement("label", { className: "intent-adoption-field" })
  constraintField.append(createElement("span", { text: "Value when present" }))
  const constraintSelect = document.createElement("select")
  constraintSelect.id = `intent-adoption-value-constraint-${index}`
  constraintSelect.name = `intent-adoption-value-constraint-${index}`
  constraintField.htmlFor = constraintSelect.id
  for (const valueConstraint of Object.values(FLEET_INTENT_VALUE_CONSTRAINT)) {
    const option = createElement("option", {
      text: INTENT_ADOPTION_CONSTRAINT_LABEL[valueConstraint],
    })
    option.value = valueConstraint
    constraintSelect.append(option)
  }
  constraintSelect.value = selection.valueConstraint
  constraintField.append(constraintSelect)

  const expectedField = createElement("label", { className: "intent-adoption-field" })
  expectedField.append(createElement("span", { text: "Expected observed value" }))
  const expectedSelect = document.createElement("select")
  expectedSelect.id = `intent-adoption-expected-${index}`
  expectedSelect.name = `intent-adoption-expected-${index}`
  expectedField.htmlFor = expectedSelect.id
  for (const variant of candidate.variants) {
    const option = createElement("option", { text: intentAdoptionVariantLabel(variant) })
    option.value = variant.canonical
    expectedSelect.append(option)
  }
  expectedSelect.value = selection.expectedCanonical || candidate.variants[0].canonical
  expectedField.append(expectedSelect)
  expectedField.hidden = selection.presenceConstraint
    === FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN
    || selection.valueConstraint !== FLEET_INTENT_VALUE_CONSTRAINT.EXACT

  const groupDetails = document.createElement("details")
  groupDetails.className = "intent-adoption-scope"
  const groupSummary = document.createElement("summary")
  const groupScope = createElement("div", { className: "intent-zone-scope" })
  groupDetails.append(groupSummary, groupScope)
  renderIntentAdoptionGroupDetails(
    groupScope,
    groupSummary,
    selection.groupId,
  )
  const valuePreview = createElement("div", {
    className: "intent-adoption-value-preview",
  })
  renderIntentAdoptionValuePreview(valuePreview, candidate, selection)
  controls.append(
    groupField,
    presenceField,
    constraintField,
    expectedField,
    groupDetails,
    valuePreview,
  )
  card.append(overview, controls)

  const syncValueControls = () => {
    const valuesApply = selection.presenceConstraint
      !== FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN
    constraintField.hidden = !valuesApply
    constraintSelect.disabled = !valuesApply
    expectedField.hidden = !valuesApply
      || selection.valueConstraint !== FLEET_INTENT_VALUE_CONSTRAINT.EXACT
    expectedSelect.disabled = expectedField.hidden
    renderIntentAdoptionValuePreview(valuePreview, candidate, selection)
  }
  syncValueControls()

  const selectCandidate = () => {
    selection.selected = true
    checkbox.checked = true
    card.classList.add("selected")
  }
  checkbox.addEventListener("change", () => {
    selection.selected = checkbox.checked
    card.classList.toggle("selected", selection.selected)
    renderIntentAdoptionImpact()
  })
  groupSelect.addEventListener("change", () => {
    if (groupSelect.value === INTENT_ADOPTION_CREATE_GROUP_VALUE) {
      groupSelect.value = selection.groupId
      openIntentGroupEditor(null, {
        adoptionCandidateId: candidate.id,
        returnToAdoption: true,
      })
      return
    }
    selectIntentAdoptionGroup(selection, groupSelect.value)
    if (!selection.constraintsDirty) {
      applyIntentAdoptionSelectionDefaults(candidate, selection)
      presenceSelect.value = selection.presenceConstraint
      constraintSelect.value = selection.valueConstraint
      expectedSelect.value = selection.expectedCanonical
      syncValueControls()
    }
    renderIntentAdoptionGroupDetails(groupScope, groupSummary, selection.groupId)
    checkbox.checked = true
    card.classList.add("selected")
    renderIntentAdoptionImpact()
  })
  presenceSelect.addEventListener("change", () => {
    selection.presenceConstraint = presenceSelect.value
    selection.constraintsDirty = true
    syncValueControls()
    selectCandidate()
    renderIntentAdoptionImpact()
  })
  constraintSelect.addEventListener("change", () => {
    selection.valueConstraint = constraintSelect.value
    selection.constraintsDirty = true
    if (selection.valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.EXACT
      && !selection.expectedCanonical) {
      selection.expectedCanonical = candidate.variants[0].canonical
    }
    syncValueControls()
    selectCandidate()
    renderIntentAdoptionImpact()
  })
  expectedSelect.addEventListener("change", () => {
    selection.expectedCanonical = expectedSelect.value
    selection.constraintsDirty = true
    renderIntentAdoptionValuePreview(valuePreview, candidate, selection)
    selectCandidate()
    renderIntentAdoptionImpact()
  })
  draft.controls.set(candidate.id, {
    card,
    checkbox,
    groupSelect,
  })
  return card
}

function renderIntentAdoptionCandidates() {
  const draft = state.intentAdoptionDraft
  if (!draft) return
  draft.controls = new Map()
  draft.empty = createElement("p", {
    className: "intent-empty",
    text: "No suggestions match these filters.",
  })
  elements.intentAdoptionList.replaceChildren(
    ...draft.candidates.map(renderIntentAdoptionCandidate),
    draft.empty,
  )
  filterIntentAdoptionCandidates()
  renderIntentAdoptionImpact()
}

function openIntentAdoption() {
  if (!state.inventory || !state.matrix) {
    toast("Load the fleet before reviewing ungoverned drift", "error")
    return
  }
  if (!intentWritable()) {
    toast("Fleet intent editing is unavailable in this session", "error")
    return
  }
  const candidates = buildIntentAdoptionCandidates(
    state.intent,
    state.inventory,
    state.matrix,
  )
  if (candidates.length === 0) {
    toast("Every drifted facet already has intent")
    return
  }
  state.intentAdoptionDraft = {
    baseRevision: state.intent.revision,
    candidates,
    controls: new Map(),
    preview: null,
    selections: new Map(candidates.map((candidate) => [
      candidate.id,
      {
        constraintsDirty: false,
        expectedCanonical: candidate.recommendation.expectedCanonical,
        groupId: FLEET_INTENT_ALL_ZONES_GROUP_ID,
        policyId: intentId("policy"),
        presenceConstraint: candidate.recommendation.presenceConstraint,
        selected: false,
        valueConstraint: candidate.recommendation.valueConstraint,
      },
    ])),
  }
  elements.intentAdoptionSearch.value = ""
  elements.intentAdoptionPattern.value = INTENT_ADOPTION_FILTER.HIGH
  elements.intentAdoptionCategory.replaceChildren(
    createElement("option", { text: "All categories" }),
    ...[...new Set(candidates.map((candidate) => candidate.category))]
      .sort()
      .map((category) => {
        const option = createElement("option", { text: category })
        option.value = category
        return option
      }),
  )
  elements.intentAdoptionCategory.firstElementChild.value = ""
  renderIntentAdoptionCandidates()
  showDialog(elements.intentAdoptionDialog, {
    initialFocus: elements.intentAdoptionSearch,
  })
}

function selectClearIntentAdoptionCandidates() {
  const draft = state.intentAdoptionDraft
  if (!draft) return
  for (const candidate of draft.candidates) {
    if (candidate.confidence !== INTENT_ADOPTION_CONFIDENCE.HIGH
      || !intentAdoptionCandidateMatches(candidate)) continue
    const selection = draft.selections.get(candidate.id)
    selection.selected = true
    draft.controls.get(candidate.id).checkbox.checked = true
    draft.controls.get(candidate.id).card.classList.add("selected")
  }
  renderIntentAdoptionImpact()
}

function clearIntentAdoptionSelection() {
  const draft = state.intentAdoptionDraft
  if (!draft) return
  for (const candidate of draft.candidates) {
    const selection = draft.selections.get(candidate.id)
    selection.selected = false
    draft.controls.get(candidate.id).checkbox.checked = false
    draft.controls.get(candidate.id).card.classList.remove("selected")
  }
  renderIntentAdoptionImpact()
}

async function saveIntentAdoption() {
  const draft = state.intentAdoptionDraft
  if (!draft?.preview) return
  if (draft.baseRevision !== state.intent.revision) {
    elements.intentAdoptionError.textContent = "Fleet intent changed while this review was open. Close and reopen it to review the latest policies."
    elements.intentAdoptionError.hidden = false
    elements.intentAdoptionSave.disabled = true
    return
  }
  const policyCount = draft.preview.summary.policiesAdded
  const saved = await persistIntentDocument(
    draft.preview.document,
    `${policyCount} fleet intent polic${policyCount === 1 ? "y" : "ies"} saved`,
  )
  if (saved && elements.intentAdoptionDialog.open) {
    elements.intentAdoptionDialog.close()
  }
}

function renderIntentManager() {
  const summary = state.intentEvaluation?.summary || {
    acknowledgedCells: 0,
    actionableCells: 0,
    governedRows: 0,
    staleAcknowledgements: 0,
  }
  const modeDetail = readOnly
    ? "This read-only session can inspect intent but cannot change it."
    : api.usesBroker
      ? "Intent is persisted as project state and shared by normal dashboard windows."
      : "This debug session can inspect injected intent but cannot persist changes."
  elements.intentSummary.textContent = modeDetail
  elements.intentMetrics.replaceChildren(
    createElement("span", {
      className: "intent-metric",
      text: `${summary.governedRows} governed`,
    }),
    createElement("span", {
      className: `intent-metric${summary.actionableCells > 0 ? " actionable" : ""}`,
      text: `${summary.actionableCells} actionable`,
    }),
    createElement("span", {
      className: "intent-metric",
      text: `${summary.acknowledgedCells} acknowledged`,
    }),
    createElement("span", {
      className: `intent-metric${summary.staleAcknowledgements > 0 ? " actionable" : ""}`,
      text: `${summary.staleAcknowledgements} stale`,
    }),
    createElement("span", {
      className: `intent-metric${(state.coverageEvaluation?.summary.changed || 0) > 0 ? " actionable" : ""}`,
      text: `${state.intent.coverageExpectations.length} coverage`,
    }),
  )
  elements.intentAddGroup.disabled = !intentWritable()
  const adoptionCandidateCount = state.inventory && state.matrix
    ? buildIntentAdoptionCandidates(
        state.intent,
        state.inventory,
        state.matrix,
      ).length
    : 0
  elements.intentReviewUngoverned.textContent = adoptionCandidateCount > 0
    ? `Review ${adoptionCandidateCount} ungoverned facet${adoptionCandidateCount === 1 ? "" : "s"}`
    : "No ungoverned drift"
  elements.intentReviewUngoverned.dataset.intentBlocked = String(
    adoptionCandidateCount === 0,
  )
  elements.intentReviewUngoverned.disabled = adoptionCandidateCount === 0
    || !intentWritable()
  renderIntentGroups()
  renderIntentPolicies()
  renderIntentCoverageExpectations()
  renderIntentAcknowledgements()
}

function openIntentManager() {
  renderIntentManager()
  showDialog(elements.intentDialog, {
    initialFocus: elements.intentDialog.querySelector("[data-dialog-close]"),
  })
  syncFleetIntent({ silent: true })
}

function activateIntentCellAction(button) {
  const action = intentCellActionByButton.get(button)
  if (!action) return
  if (action.type === "acknowledge") {
    openIntentAcknowledgement(action)
    return
  }
  if (action.type === "remove-acknowledgement") {
    requestIntentRemoval({
      fallbackFocus: () => matrixIntentReturnFocus(
        action.row,
        ".acknowledge-intent, .remove-acknowledgement",
        action.zone.meta.id,
      ),
      remove: (document) => removeFleetIntentAcknowledgement(
        document,
        action.acknowledgement.id,
      ),
      successMessage: `Acknowledgement removed for ${action.zone.meta.name}`,
      summary: `Remove the acknowledgement for ${action.row.label} on ${action.zone.meta.name}? This exact difference will return to actionable drift.`,
      title: "Remove acknowledgement",
    })
  }
}

function activateIntentPolicyRow(button) {
  const action = intentPolicyRowByButton.get(button)
  if (!action) return
  if (action.showManager) {
    openIntentManager()
    return
  }
  openIntentPolicyEditor(action.row, action.policy)
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
  if (action.type === READ_ACTION.EMAIL_RULE_EDIT) {
    return `Edit ${row.label} on ${zone.meta.name}`
  }
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

function cellComparisonStatus(row, cell) {
  const hasConsensus = row.consensusCanonical !== null
  const matchesConsensus = hasConsensus
    && cell.canonical === row.consensusCanonical
  const status = matchesConsensus
    ? {
        className: MATRIX_COMPARISON_STATE.MATCH,
        label: "Match",
        title: "Matches the unique row consensus",
      }
    : hasConsensus
      ? {
          className: MATRIX_COMPARISON_STATE.VARIANT,
          label: "Variant",
          title: "Differs from the unique row consensus",
        }
      : {
          className: MATRIX_COMPARISON_STATE.NO_CONSENSUS,
          label: "No consensus",
          title: "The most common present values are tied",
        }
  const element = createElement("span", {
    className: `cell-comparison-status ${status.className}`,
    text: status.label,
  })
  element.title = status.title
  element.setAttribute("aria-label", status.title)
  return {
    className: status.className,
    element,
  }
}

function cellIntentState(row, zone) {
  return row.intentState?.cells.get(zone.meta.id) || null
}

function cellIntentStatus(state) {
  if (!state
    || state.status === FLEET_INTENT_CELL_STATUS.UNGOVERNED
    || state.status === FLEET_INTENT_CELL_STATUS.OUT_OF_SCOPE) return null
  const presenceConstraint = fleetIntentPolicyPresenceConstraint(state.policy)
  const valueConstraint = fleetIntentPolicyValueConstraint(state.policy)
  const missing = state.observedCanonical === FLEET_INTENT_MISSING_CANONICAL
  const duplicateZones = state.duplicateZoneNames?.join(", ") || "another covered zone"
  const definitions = {
    [FLEET_INTENT_CELL_STATUS.ACKNOWLEDGED]: {
      label: "Acknowledged",
      title: "This exact observed state is acknowledged intentionally",
    },
    [FLEET_INTENT_CELL_STATUS.CONFLICT]: {
      label: "Intent conflict",
      title: "Multiple policies target this facet and zone",
    },
    [FLEET_INTENT_CELL_STATUS.MATCH]: {
      label: "Intent match",
      title: presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN
        ? "This facet is absent as required"
        : missing
          ? "This policy allows the facet to be absent on this zone"
          : valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER
            ? "A value is present; this policy allows present values to differ"
            : valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER
              ? "This value is distinct among the present covered values"
              : "Matches the expected value for this policy",
    },
    [FLEET_INTENT_CELL_STATUS.MISSING]: {
      label: "Intent drift",
      title: valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER
        ? "This policy requires a present, distinct value in every covered zone"
        : "This policy requires a value in every covered zone",
    },
    [FLEET_INTENT_CELL_STATUS.VARIANT]: {
      label: presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN
        ? "Unexpected presence"
        : valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER
          ? "Duplicate"
          : "Intent drift",
      title: presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN
        ? "This policy requires the facet to be absent"
        : valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER
          ? `Duplicates ${duplicateZones}; every present covered value must differ`
          : "The observed value differs from fleet intent",
    },
  }
  const definition = definitions[state.status]
  if (!definition) return null
  const element = createElement("span", {
    className: `cell-intent-status ${state.status}`,
    text: definition.label,
  })
  element.title = definition.title
  element.setAttribute("aria-label", definition.title)
  return element
}

function applyIntentCellPresentation(td, row, zone) {
  const intentCell = cellIntentState(row, zone)
  if (intentCell) td.dataset.intentStatus = intentCell.status
  const status = cellIntentStatus(intentCell)
  if (status) td.append(status)
  const drift = intentCell?.status === FLEET_INTENT_CELL_STATUS.CONFLICT
    || intentCell?.status === FLEET_INTENT_CELL_STATUS.MISSING
    || intentCell?.status === FLEET_INTENT_CELL_STATUS.VARIANT
  td.classList.toggle("intent-drift", drift)
  td.classList.toggle(
    "intent-acknowledged",
    intentCell?.status === FLEET_INTENT_CELL_STATUS.ACKNOWLEDGED,
  )
  return intentCell
}

function appendIntentCellAction(actions, row, zone, intentCell) {
  if (!intentMutationSupported()) return
  if (intentCell?.status === FLEET_INTENT_CELL_STATUS.MISSING
    || intentCell?.status === FLEET_INTENT_CELL_STATUS.VARIANT) {
    const button = createElement("button", {
      className: "cell-action acknowledge-intent",
      text: "Acknowledge",
    })
    button.type = "button"
    button.setAttribute("aria-label", `Acknowledge ${row.label} on ${zone.meta.name}`)
    button.title = "Accept only this exact observed state as intentional"
    button.disabled = !intentWritable()
    intentCellActionByButton.set(button, {
      intentCell,
      row,
      type: "acknowledge",
      zone,
    })
    actions.append(button)
    return
  }
  if (intentCell?.status === FLEET_INTENT_CELL_STATUS.ACKNOWLEDGED) {
    const actionLabel = "Unacknowledge"
    const button = createElement("button", {
      className: "cell-action remove-acknowledgement",
      text: actionLabel,
    })
    button.type = "button"
    button.setAttribute(
      "aria-label",
      contextualActionLabel(
        actionLabel,
        `Remove acknowledgement for ${row.label} on ${zone.meta.name}`,
      ),
    )
    button.title = "Return this exact difference to actionable drift"
    button.disabled = !intentWritable()
    intentCellActionByButton.set(button, {
      acknowledgement: intentCell.acknowledgement,
      intentCell,
      row,
      type: "remove-acknowledgement",
      zone,
    })
    actions.append(button)
  }
}

function matrixCell(row, zone) {
  const cell = row.cells.get(zone.meta.name)
  const td = createElement("td", { className: "matrix-cell" })
  td.dataset.zoneId = zone.meta.id
  td.classList.toggle("selected-column", state.selectedZoneIds.has(zone.meta.id))

  if (!cell) {
    td.classList.add("missing")
    const intentCell = applyIntentCellPresentation(td, row, zone)
    td.append(createElement("span", { className: "cell-state", text: "Missing" }))
    const resolution = row.missingResolutions.get(zone.meta.name)
    const intentPolicy = intentCell?.policy || null
    const intentExpected = intentPolicy?.expected || null
    const intentPresenceConstraint = fleetIntentPolicyPresenceConstraint(intentPolicy)
    const intentValueConstraint = fleetIntentPolicyValueConstraint(intentPolicy)
    const matchingIntentSource = intentExpected?.resolutionCanonical
      ? resolution?.candidates?.some(
          (candidate) => candidate.canonical === intentExpected.resolutionCanonical,
        )
      : false
    const intentResolutionAvailable = !intentPolicy
      || (intentPresenceConstraint !== FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN
        && (intentValueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER
          || (intentValueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.EXACT
            && (resolution?.kind === HOLE_RESOLUTION_KIND.EMAIL_POLICY
              ? !fleetIntentExpectedIsAuthored(intentExpected)
              : matchingIntentSource))))
    if (resolution?.available && intentResolutionAvailable && !readOnly) {
      const action = {
        category: row.category,
        key: row.key,
        label: row.label,
        resolution,
        intentGoverned: Boolean(intentCell?.policy),
        intentExpectedAuthored: fleetIntentExpectedIsAuthored(
          intentExpected,
        ),
        intentExpectedCanonical: intentExpected?.resolutionCanonical || null,
        intentPresenceConstraint,
        intentValueConstraint,
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
    } else if (intentPolicy && resolution?.available && !intentResolutionAvailable) {
      td.title = intentPresenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN
        ? "Intent requires this facet to remain absent, so fill actions are unavailable"
        : intentValueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER
          ? intentPresenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL
            ? "Absence is allowed, but any added value must be distinct; copying an existing fleet value would violate uniqueness"
            : "Intent requires a new distinct value; copying an existing fleet value would violate uniqueness"
          : "Intent detects this missing value, but no matching fleet source or product-specific create flow is available"
      td.setAttribute(
        "aria-label",
        `Missing ${row.label} on ${zone.meta.name}. ${td.title}`,
      )
    } else if (resolution?.reason) {
      td.title = resolution.reason
      td.setAttribute(
        "aria-label",
        `Missing ${row.label} on ${zone.meta.name}. ${resolution.reason}`,
      )
    }
    const intentActions = createElement("div", { className: "cell-actions intent-cell-actions" })
    appendIntentCellAction(intentActions, row, zone, intentCell)
    if (intentActions.children.length > 0) td.append(intentActions)
    return td
  }

  if (cell.action?.type === "ruleset-rule") {
    td.dataset.ruleId = cell.action.ruleId
    td.dataset.rulesetId = cell.action.rulesetId
  }
  td.classList.add(`variant-${row.variantIndexes.get(cell.canonical) ?? 0}`)
  const comparisonStatus = cellComparisonStatus(row, cell)
  td.dataset.comparison = comparisonStatus.className
  td.append(comparisonStatus.element)
  const intentCell = applyIntentCellPresentation(td, row, zone)
  const directlyEditable = Boolean(cell.action && !readOnly)
  const structuredValue = cell.inspectionValue !== null
    && typeof cell.inspectionValue === "object"
  if (cell.presentation?.kind === "rule") {
    const details = document.createElement("details")
    details.className = "cell-value-details"
    const redirect = cell.presentation.redirect
    details.append(
      redirect
        ? createRedirectCellSummary(
            redirect,
            cell.presentation.rule.description,
            row.label,
          )
        : createElement("summary", { text: cell.display }),
      createRuleSummary(
        cell.presentation.rule,
        cell.presentation.phase,
        {
          compact: true,
          omitFields: redirect
            ? ["enabled", "action", "phase"]
            : ["description", "enabled"],
        },
      ),
      createRawValueDetails(cell.inspectionValue),
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
  const hasIntentAction = intentMutationSupported()
    && (intentCell?.status === FLEET_INTENT_CELL_STATUS.MISSING
      || intentCell?.status === FLEET_INTENT_CELL_STATUS.VARIANT
      || intentCell?.status === FLEET_INTENT_CELL_STATUS.ACKNOWLEDGED)
  if (directlyEditable || hasWriteSecondaryAction || hasWorkspaceAction || hasIntentAction) {
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
    appendIntentCellAction(actions, row, zone, intentCell)
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
    const rulesetComparison = compareDetailedRulesetRow(
      row,
      state.inventory.zones,
    )
    const tr = document.createElement("tr")
    tr.dataset.actionable = String(row.actionable)
    tr.dataset.category = row.category
    tr.dataset.changeable = String(matrixRowSupportsChanges(row))
    tr.dataset.different = String(
      row.different || Boolean(rulesetComparison?.hasDefinitionDifferences),
    )
    tr.dataset.facetKey = row.key
    tr.dataset.missingZoneIds = row.missingZoneIds.join(" ")
    tr.dataset.presentCount = String(row.presentCount)
    tr.dataset.recordType = row.recordType
    tr.dataset.redirectTypes = row.redirectTypes.join(" ")
    tr.dataset.search = row.search

    const categoryCell = createElement("th", {
      className: "category-cell",
      text: matrixCategoryLabel(row.category),
    })
    categoryCell.scope = "row"
    const facetCell = createElement("th", { className: "facet-cell" })
    facetCell.scope = "row"
    facetCell.append(createElement("small", {
      className: "facet-category",
      text: matrixCategoryLabel(row.category),
    }))
    const hasConsensus = rulesetComparison
      ? Boolean(rulesetComparison.baseline)
      : row.consensusCanonical !== null
    const consensusBadge = createElement("small", {
      className: `comparison-badge ${hasConsensus ? "consensus" : "no-consensus"}${rulesetComparison ? " ruleset-count" : ""}`,
      text: rulesetComparison?.badgeText || (hasConsensus
        ? `Consensus ${row.consensusCount}/${state.inventory.zones.length}`
        : "No consensus"),
    })
    consensusBadge.title = rulesetComparison?.title || (hasConsensus
      ? `${row.consensusCount} of ${state.inventory.zones.length} zones match the unique row consensus`
      : `${row.variantCount} present variants; the most common values are tied`)
    consensusBadge.setAttribute("aria-label", consensusBadge.title)
    const facetTitle = createElement("div", { className: "facet-title" })
    facetTitle.append(
      createElement("span", { text: row.label }),
      consensusBadge,
    )
    facetCell.append(facetTitle)
    if (row.description) facetCell.append(createElement("small", { text: row.description }))
    if (rulesetComparison?.hasDifferences) {
      facetCell.append(createElement("small", {
        className: "ruleset-count-distribution",
        text: rulesetComparison.distributionText,
      }))
    }
    const facetActions = createElement("div", { className: "facet-actions" })
    const actionTypes = new Set(
      [...row.cells.values()].map((cell) => cell.action?.type).filter(Boolean),
    )
    const secondaryActionTypes = new Set(
      [...row.cells.values()].map((cell) => cell.secondaryAction?.type).filter(Boolean),
    )
    if (row.variantCount > 1 && !rulesetComparison?.hasDifferences) {
      const compareLabel = `Compare ${row.variantCount} values`
      const compareButton = createElement("button", {
        className: "cell-action compare-values",
        text: compareLabel,
      })
      compareButton.type = "button"
      compareButton.setAttribute(
        "aria-label",
        contextualActionLabel(compareLabel, `Observed values for ${row.label}`),
      )
      compareButton.title = "See the zones using each value and only the fields that differ"
      valueComparisonRowByButton.set(compareButton, row)
      facetActions.append(compareButton)
    }
    if (rulesetComparison?.hasDifferences) {
      const reviewLabel = rulesetComparison.baseline && rulesetComparison.outlierCount > 0
        ? `Review ${rulesetComparison.outlierCount} count outlier${rulesetComparison.outlierCount === 1 ? "" : "s"}`
        : rulesetComparison.baseline
          ? "Review rule differences"
          : "Review count distribution"
      const reviewButton = createElement("button", {
        className: "cell-action review-ruleset-comparison",
        text: reviewLabel,
      })
      reviewButton.type = "button"
      reviewButton.setAttribute(
        "aria-label",
        contextualActionLabel(
          reviewLabel,
          `Rule-count and ordered-rule differences for ${row.label}`,
        ),
      )
      reviewButton.title = "See what differs, open exact rulesets, or define accepted states"
      rulesetComparisonRowByButton.set(reviewButton, row)
      facetActions.append(reviewButton)
    }
    if (!readOnly && api.usesBroker) {
      const policies = row.intentState?.policies || []
      const policyGroup = policies.length === 1
        ? intentGroupById(policies[0].groupId)
        : null
      const intentLabel = policies.length === 0
        ? "Set intent"
        : policies.length === 1
          ? `Intent: ${intentPolicyConstraintLabel(policies[0])}`
          : `Intent (${policies.length})`
      const intentButton = createElement("button", {
        className: "cell-action intent-set-policy",
        text: intentLabel,
      })
      intentButton.type = "button"
      intentButton.disabled = !intentWritable()
      intentButton.setAttribute(
        "aria-label",
        contextualActionLabel(
          intentLabel,
          policies.length > 1
            ? `Manage ${policies.length} intent policies for ${row.label}`
            : `${policies.length === 1 ? "Edit" : "Set"} intent for ${row.label}`,
        ),
      )
      intentButton.title = policies.length > 1
        ? "Review overlapping policies in Fleet intent"
        : policies.length === 1
          ? `${policyGroup?.name || "Configured coverage"} | ${intentPolicyConstraintLabel(policies[0])}. Click to edit.`
          : "Choose coverage, presence, and the relationship between present values"
      intentPolicyRowByButton.set(intentButton, {
        policy: policies.length === 1 ? policies[0] : null,
        row,
        showManager: policies.length > 1,
      })
      facetActions.append(intentButton)
    }
    const intentCorrection = dnssecIntentCorrection(row)
    if (!readOnly && intentCorrection.available) {
      const correctionCount = intentCorrection.targets.length
      const correctionLabel = `Align ${correctionCount} zone${correctionCount === 1 ? "" : "s"}`
      const correctionButton = createElement("button", {
        className: "cell-action apply-intent-correction",
        text: correctionLabel,
      })
      correctionButton.type = "button"
      correctionButton.setAttribute(
        "aria-label",
        contextualActionLabel(
          correctionLabel,
          `Align ${row.label} with fleet intent`,
        ),
      )
      correctionButton.title = "Fresh-read the drifting zones and preview the DNSSEC status writes"
      correctionButton.dataset.actionTitle = correctionButton.title
      intentCorrectionByButton.set(correctionButton, intentCorrection)
      facetActions.append(correctionButton)
    }
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
      const renameLabel = "Rename fleet"
      const renameButton = createElement("button", {
        className: "cell-action rename-rule",
        text: renameLabel,
      })
      renameButton.type = "button"
      renameButton.setAttribute(
        "aria-label",
        contextualActionLabel(renameLabel, `Rename ${row.label} across fleet`),
      )
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

function coverageExpectationForIssue(issue) {
  const targetKey = fleetIntentCoverageTargetKey(issue)
  return state.intent.coverageExpectations.find(
    (expectation) => fleetIntentCoverageTargetKey(expectation) === targetKey,
  ) || null
}

function coverageTargetLabel(target) {
  return target.zoneName
    ? `${target.subjectLabel} | ${target.zoneName}`
    : `${target.subjectLabel} | Fleet-wide limitation`
}

function coverageIssueGroups(issueStates) {
  const groups = new Map()
  for (const issueState of issueStates) {
    const issue = issueState.issue
    const key = JSON.stringify([issue.kind, issue.subjectId])
    if (!groups.has(key)) {
      groups.set(key, {
        issueStates: [],
        kind: issue.kind,
        subjectId: issue.subjectId,
        subjectLabel: issue.subjectLabel,
      })
    }
    groups.get(key).issueStates.push(issueState)
  }
  return [...groups.values()]
}

function coverageIssueAction(issueState) {
  if (!intentMutationSupported()) return null
  const actionLabel = issueState.expected
    ? "Edit expectation"
    : issueState.expectation
      ? "Update expectation"
      : "Mark expected"
  const button = createElement("button", {
    className: "button button-quiet",
    text: actionLabel,
  })
  button.type = "button"
  button.setAttribute(
    "aria-label",
    contextualActionLabel(actionLabel, coverageTargetLabel(issueState.issue)),
  )
  button.dataset.intentWrite = ""
  button.disabled = !intentWritable()
  button.addEventListener("click", () => {
    openCoverageIntentEditor(issueState.issue, issueState.expectation)
  })
  return button
}

function coverageIssueRow(issueState) {
  const issue = issueState.issue
  const row = createElement("div", { className: "coverage-issue" })
  const copy = createElement("div", { className: "coverage-issue-copy" })
  copy.append(
    createElement("strong", {
      text: issue.zoneName || "Fleet-wide limitation",
    }),
    createElement("small", { text: issue.detail }),
  )
  row.append(copy)
  const action = coverageIssueAction(issueState)
  if (action) row.append(action)
  return row
}

function coverageIssueGroupItem(group, expected) {
  const count = group.issueStates.length
  const item = createElement("li", {
    className: expected ? "expected" : "failed",
  })
  item.append(
    createElement("span", { text: group.subjectLabel }),
    createElement("small", {
      text: group.kind === INVENTORY_COVERAGE_KIND.LIMITATION
        ? expected ? "Expected fleet-wide limitation" : "Unexpected fleet-wide limitation"
        : `${count} ${expected ? "expected" : "unexpected"} zone failure${count === 1 ? "" : "s"}`,
    }),
  )
  const issues = createElement("div", { className: "coverage-issue-list" })
  for (const issueState of group.issueStates) {
    issues.append(coverageIssueRow(issueState))
  }
  item.append(issues)
  return item
}

function coverageEmptyItem(text) {
  return createElement("li", {
    className: "coverage-empty",
    text,
  })
}

function inactiveCoverageExpectationItem(expectationState) {
  const expectation = expectationState.expectation
  const changed = expectationState.status
    === FLEET_INTENT_COVERAGE_EXPECTATION_STATUS.CHANGED
  const item = createElement("li", { className: "expected" })
  item.append(
    createElement("span", { text: expectation.subjectLabel }),
    createElement("small", {
      text: changed
        ? `${expectation.zoneName || "Fleet-wide limitation"} | Failure changed and is red again`
        : `${expectation.zoneName || "Fleet-wide limitation"} | No matching failure in this inventory`,
    }),
  )
  const row = createElement("div", { className: "coverage-issue" })
  const copy = createElement("div", { className: "coverage-issue-copy" })
  copy.append(
    createElement("strong", { text: changed ? "Needs review" : "Saved allowance inactive" }),
    createElement("small", { text: expectation.reason }),
  )
  row.append(copy)
  if (intentMutationSupported()) {
    const review = createElement("button", {
      className: "button button-quiet",
      text: "Review",
    })
    review.type = "button"
    review.dataset.intentWrite = ""
    review.disabled = !intentWritable()
    review.addEventListener("click", () => {
      openCoverageIntentEditor(expectationState.issue, expectation)
    })
    row.append(review)
  }
  item.append(row)
  return item
}

function syncCoverageVisibility() {
  const sections = [
    {
      key: COVERAGE_SECTION.UNEXPECTED,
      list: elements.coverageUnexpectedList,
      toggle: elements.coverageUnexpectedToggle,
    },
    {
      key: COVERAGE_SECTION.EXPECTED,
      list: elements.coverageExpectedList,
      toggle: elements.coverageExpectedToggle,
    },
    {
      key: COVERAGE_SECTION.HEALTHY,
      list: elements.coverageHealthyList,
      toggle: elements.coverageHealthyToggle,
    },
  ]
  for (const section of sections) {
    const expanded = state.coverageExpanded[section.key]
    section.list.hidden = !expanded
    section.toggle.setAttribute("aria-expanded", String(expanded))
  }
}

function renderCoverage() {
  const inventoryCoverage = coverageFor(state.inventory)
  const issues = [
    ...inventoryCoverage.flatMap((coverage) => coverage.failed),
    ...staticCoverageIssues(STATIC_LIMITATIONS),
  ]
  const evaluation = evaluateFleetIntentCoverage(state.intent, issues)
  state.coverageEvaluation = evaluation

  const unexpectedFragment = document.createDocumentFragment()
  for (const group of coverageIssueGroups(evaluation.unexpectedIssues)) {
    unexpectedFragment.append(coverageIssueGroupItem(group, false))
  }
  if (unexpectedFragment.childNodes.length === 0) {
    unexpectedFragment.append(coverageEmptyItem("No unexpected inventory gaps"))
  }
  elements.coverageUnexpectedList.replaceChildren(unexpectedFragment)

  const expectedFragment = document.createDocumentFragment()
  for (const group of coverageIssueGroups(evaluation.expectedIssues)) {
    expectedFragment.append(coverageIssueGroupItem(group, true))
  }
  for (const expectationState of evaluation.expectationStates.filter(
    (entry) => entry.status !== FLEET_INTENT_COVERAGE_EXPECTATION_STATUS.ACTIVE,
  )) {
    expectedFragment.append(inactiveCoverageExpectationItem(expectationState))
  }
  if (expectedFragment.childNodes.length === 0) {
    expectedFragment.append(coverageEmptyItem("No expected gaps have been saved"))
  }
  elements.coverageExpectedList.replaceChildren(expectedFragment)

  const healthyFragment = document.createDocumentFragment()
  const healthy = inventoryCoverage.filter((coverage) => coverage.ok)
  for (const coverage of healthy) {
    const item = createElement("li", { className: "healthy" })
    item.append(
      createElement("span", { text: coverage.label }),
      createElement("small", { text: coverage.detail }),
    )
    healthyFragment.append(item)
  }
  if (healthyFragment.childNodes.length === 0) {
    healthyFragment.append(coverageEmptyItem("No surface succeeded across every zone"))
  }
  elements.coverageHealthyList.replaceChildren(healthyFragment)

  const expectedCurrent = evaluation.expectedIssues.length
  elements.coverageUnexpectedCount.textContent = `${evaluation.unexpectedIssues.length} current`
  const expectedCounts = [`${expectedCurrent} current`]
  if (evaluation.summary.changed > 0) {
    expectedCounts.push(`${evaluation.summary.changed} review`)
  }
  if (evaluation.summary.inactive > 0) {
    expectedCounts.push(`${evaluation.summary.inactive} inactive`)
  }
  elements.coverageExpectedCount.textContent = expectedCounts.join(" | ")
  elements.coverageHealthyCount.textContent = `${healthy.length} readable`
  elements.coverageSummary.textContent = `${evaluation.unexpectedIssues.length} unexpected | ${expectedCurrent} expected | ${healthy.length} healthy surface${healthy.length === 1 ? "" : "s"}`
  syncCoverageVisibility()
}

function filterRows() {
  const rows = [...elements.matrixBody.querySelectorAll("tr")]
  const filters = currentMatrixFilters()
  let visible = 0

  for (const row of rows) {
    row.classList.remove("matrix-navigation-target")
    const show = matrixRowMatchesFilters({
      actionable: row.dataset.actionable === "true",
      category: row.dataset.category,
      changeable: row.dataset.changeable === "true",
      different: row.dataset.different === "true",
      missingZoneIds: row.dataset.missingZoneIds.split(" ").filter(Boolean),
      presentCount: Number(row.dataset.presentCount),
      recordType: row.dataset.recordType,
      redirectTypes: row.dataset.redirectTypes.split(" ").filter(Boolean),
      search: row.dataset.search,
    }, filters)
    row.classList.toggle("hidden-row", !show)
    if (show) visible += 1
  }

  elements.visibleCount.textContent = `${visible} / ${rows.length} facets`
  const emptyMessage = matrixEmptyMessage(rows.length, visible)
  elements.matrixEmpty.textContent = emptyMessage
  elements.matrixEmpty.hidden = emptyMessage.length === 0
  elements.matrixTable.hidden = emptyMessage.length > 0
  syncMatrixFilterControls(filters)
  syncMatrixActionTabStop()
}

function updateSelectionStyles() {
  const count = state.selectedZoneIds.size
  const targetHolesWasActive = elements.targetHoles.getAttribute("aria-pressed") === "true"
  const driftCount = workflowOrIntentDriftZoneIds().length
  const zoneCount = state.inventory?.zones.length || 0
  const selectionCanNarrow = count > 0 && count < zoneCount
  if (!selectionCanNarrow) state.selectedColumnsOnly = false
  const selectedColumnsOnly = selectionCanNarrow && state.selectedColumnsOnly
  elements.selectionCount.textContent = String(count)
  elements.writeSelectionSummary.textContent = count === 0
    ? "No target zones chosen"
    : `${count} target zone${count === 1 ? "" : "s"} chosen`
  for (const element of document.querySelectorAll("[data-zone-id]")) {
    const selected = state.selectedZoneIds.has(element.dataset.zoneId)
    if (element.classList.contains("zone-heading")) element.classList.toggle("selected", selected)
    if (element.classList.contains("matrix-cell")) element.classList.toggle("selected-column", selected)
    if (element.classList.contains("zone-heading")
      || element.classList.contains("matrix-cell")) {
      element.classList.toggle(
        MATRIX_COLUMN_HIDDEN_CLASS,
        !matrixColumnIsVisible(
          element.dataset.zoneId,
          state.selectedZoneIds,
          selectedColumnsOnly,
        ),
      )
    }
  }
  elements.clearSelection.disabled = count === 0
  elements.selectDrifted.disabled = driftCount === 0
  elements.selectedColumnsOnly.disabled = !selectionCanNarrow
  elements.selectedColumnsOnly.setAttribute("aria-pressed", String(selectedColumnsOnly))
  elements.selectedColumnsOnly.textContent = selectedColumnsOnly
    ? "Show all zones"
    : "Selected zones only"
  elements.selectedColumnsOnly.title = selectedColumnsOnly
    ? "Show every zone column"
    : "Hide unselected zone columns without changing fleet comparisons"
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
  syncMatrixActionTabStop()
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

function intentCompatibleDnsTargetFillBatch(row) {
  const batch = dnsTargetFillBatch(row, state.inventory, state.selectedZoneIds)
  if (!batch.available) return batch
  for (const zoneId of batch.targetZoneIds) {
    const intentCell = row.intentState?.cells.get(zoneId)
    if (!intentCell
      || intentCell.status === FLEET_INTENT_CELL_STATUS.UNGOVERNED
      || intentCell.status === FLEET_INTENT_CELL_STATUS.OUT_OF_SCOPE) continue
    if (intentCell.status === FLEET_INTENT_CELL_STATUS.CONFLICT) {
      return {
        ...batch,
        available: false,
        reason: "Overlapping fleet intent policies must be resolved before bulk fill",
      }
    }
    const valueConstraint = fleetIntentPolicyValueConstraint(intentCell.policy)
    const presenceConstraint = fleetIntentPolicyPresenceConstraint(intentCell.policy)
    if (presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN) {
      return {
        ...batch,
        available: false,
        reason: "Forbidden intent requires this facet to remain absent",
      }
    }
    if (valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER) {
      return {
        ...batch,
        available: false,
        reason: presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL
          ? "Optional must-differ intent allows absence, but any added value must be distinct"
          : "Must-differ intent requires a new distinct value for each missing zone",
      }
    }
    if (valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.EXACT
      && batch.candidate.canonical !== intentCell.policy.expected.resolutionCanonical) {
      return {
        ...batch,
        available: false,
        reason: "The bulk fill source does not match the exact fleet intent value",
      }
    }
  }
  return batch
}

function updateActionButtons() {
  const hasSelection = state.selectedZoneIds.size > 0
  const writeLocked = state.busy
    || readOnly
    || !state.inventory
    || !state.transportAvailable
  const writeLockReason = readOnly
    ? "This session is read-only"
    : !state.transportAvailable
      ? "Session broker offline; relaunch to restore live writes"
      : state.busy
        ? "Another fleet operation is in progress"
        : "Fleet inventory is unavailable"
  elements.alignEmail.disabled = writeLocked || !hasSelection
  elements.alignWaf.disabled = writeLocked || !hasSelection
  elements.alignEmail.textContent = hasSelection
    ? `Review Email for ${state.selectedZoneIds.size}`
    : "Choose zones first"
  elements.alignWaf.textContent = hasSelection
    ? `Review WAF for ${state.selectedZoneIds.size}`
    : "Choose zones first"
  elements.alignEmail.title = !hasSelection && !readOnly
    ? "Choose at least one target zone first"
    : "Live-validates Email Routing and DNS state before confirmation"
  elements.alignWaf.title = !hasSelection && !readOnly
    ? "Choose at least one target zone first"
    : "Live-validates shared WAF rules before confirmation"
  elements.chooseTargets.disabled = state.busy || !state.inventory
  elements.reviewNeedsAttention.disabled = !state.matrix
    || state.matrix.summary.differences === 0
  elements.showSupportedChanges.disabled = !state.matrix
    || matrixCapabilityCounts(state.matrix).changeableRows === 0
  elements.showDnssecWorkflow.disabled = !state.matrix?.rows.some(
    rowSupportsDnssecIntentCorrection,
  )

  for (const cell of document.querySelectorAll(".editable-cell, .fillable-hole")) {
    cell.classList.toggle("write-locked", writeLocked)
    cell.title = writeLocked
      ? writeLockReason
      : cell.dataset.editTitle
  }
  for (const button of document.querySelectorAll(".edit-cell")) {
    button.disabled = writeLocked
  }
  for (const button of document.querySelectorAll(".activity-undo")) {
    const entry = activityEntryByButton.get(button)
    button.disabled = writeLocked || !entry || !activityUndoable(entry)
    button.title = writeLocked
      ? writeLockReason
      : "Fresh-read the affected resources before reviewing the inverse writes"
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
      ? intentCompatibleDnsTargetFillBatch(row)
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
  for (const button of document.querySelectorAll(".apply-intent-correction")) {
    button.disabled = writeLocked
    button.title = writeLocked ? writeLockReason : button.dataset.actionTitle
  }
  const intentLocked = !intentWritable()
  for (const button of document.querySelectorAll(
    ".intent-set-policy, .acknowledge-intent, .remove-acknowledgement, #intent-add-group, [data-intent-write]",
  )) {
    button.disabled = intentLocked || button.dataset.intentBlocked === "true"
  }
  if (elements.intentAdoptionSave) {
    elements.intentAdoptionSave.disabled = intentLocked
      || !state.intentAdoptionDraft?.preview
  }
  syncMatrixActionTabStop()
}

function updateTargetSelectionSummary() {
  const count = state.selectedZoneIds.size
  elements.targetSelectionSummary.textContent = count === 0
    ? "No target zones chosen"
    : `${count} target zone${count === 1 ? "" : "s"} chosen`
}

function renderTargetOptions() {
  const drifted = new Set(workflowOrIntentDriftZoneIds())
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
      text: drifted.has(zone.meta.id)
        ? "Workflow or intent drift"
        : "No workflow or intent drift",
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

function focusConfigurationExplorer() {
  elements.configurationHeading.focus({ preventScroll: true })
  elements.configurationHeading.scrollIntoView({
    behavior: prefersReducedMotion() ? "auto" : "smooth",
    block: "start",
  })
}

function showExplorerView(options = {}) {
  elements.search.value = ""
  elements.category.value = options.category || ""
  elements.scope.value = options.scope || MATRIX_SCOPE.ALL
  elements.dnsType.value = ""
  elements.redirectType.value = ""
  elements.differenceToggle.setAttribute(
    "aria-pressed",
    String(Boolean(options.differencesOnly)),
  )
  elements.changeSupportToggle.setAttribute(
    "aria-pressed",
    String(Boolean(options.changeableOnly)),
  )
  elements.targetHoles.setAttribute("aria-pressed", "false")
  elements.targetHoles.textContent = "Target holes"
  state.filterPanelExpanded = false
  syncDnsTypeAvailability()
  syncRedirectTypeAvailability()
  renderCategoryCapability()
  filterRows()
  focusConfigurationExplorer()
}

function showNeedsAttention() {
  showExplorerView({
    differencesOnly: true,
    scope: MATRIX_SCOPE.ALL,
  })
}

function showSupportedChanges() {
  showExplorerView({
    changeableOnly: true,
    scope: MATRIX_SCOPE.ALL,
  })
}

function showDnssecWorkflow() {
  showExplorerView({
    category: "DNSSEC",
    scope: MATRIX_SCOPE.ALL,
  })
}

function activityOperations(entry) {
  return entry.plans.flatMap((plan) => plan.operations.map((operation) => ({
    operation,
    plan,
  })))
}

function verifiedUndoFor(entry, entries = state.activity.entries) {
  return entries.find((candidate) => (
    candidate.undoOf === entry.id
      && candidate.status === OPERATION_ACTIVITY_STATUS.VERIFIED
  )) || null
}

function pendingUndoFor(entry, entries = state.activity.entries) {
  return entries.find((candidate) => (
    candidate.undoOf === entry.id
      && candidate.status === OPERATION_ACTIVITY_STATUS.PENDING
  )) || null
}

function activityUndoable(entry, entries = state.activity.entries) {
  return entry.status === OPERATION_ACTIVITY_STATUS.VERIFIED
    && entry.inverse?.available === true
    && !verifiedUndoFor(entry, entries)
    && !pendingUndoFor(entry, entries)
}

function activityMatchesFilter(entry, filter) {
  if (filter === ACTIVITY_FILTER.UNDOABLE) return activityUndoable(entry)
  if (filter === ACTIVITY_FILTER.FAILED) {
    return [
      OPERATION_ACTIVITY_STATUS.VERIFICATION_FAILED,
      OPERATION_ACTIVITY_STATUS.WRITE_FAILED,
    ].includes(entry.status)
  }
  if (filter === ACTIVITY_FILTER.PENDING) {
    return entry.status === OPERATION_ACTIVITY_STATUS.PENDING
  }
  return true
}

function formatActivityTime(timestamp) {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.valueOf())) return "Unknown time"
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}

function activityZoneNames(entry) {
  return [...new Set(entry.plans.map((plan) => plan.zoneName).filter(Boolean))]
}

function updateActivityButton() {
  const count = state.activity.entries.length
  elements.activityCount.textContent = String(count)
  const activityLabel = `Activity ${count}`
  elements.showActivity.setAttribute(
    "aria-label",
    contextualActionLabel(
      activityLabel,
      `Operation history, ${count === 0 ? "no" : count} entr${count === 1 ? "y" : "ies"}`,
    ),
  )
}

function activityOperationList(entry) {
  const section = createElement("section", { className: "activity-detail-section" })
  section.append(createElement("h4", { text: "Reviewed writes" }))
  const list = document.createElement("ul")
  for (const { operation, plan } of activityOperations(entry)) {
    const item = document.createElement("li")
    item.append(
      createElement("code", { text: operation.method }),
      document.createTextNode(`${plan.zoneName}: ${operation.label}`),
    )
    list.append(item)
  }
  section.append(list)
  return section
}

function activityVerificationList(entry) {
  const section = createElement("section", { className: "activity-detail-section" })
  section.append(createElement("h4", { text: "Verified live state" }))
  const list = document.createElement("ul")
  if (entry.verification.length === 0) {
    list.append(createElement("li", {
      text: entry.status === OPERATION_ACTIVITY_STATUS.PENDING
        ? "Verification did not complete"
        : "No verification guard was recorded",
    }))
  } else {
    for (const guard of entry.verification) {
      const zoneName = entry.plans.find(
        (plan) => plan.zoneId === guard.target.zoneId,
      )?.zoneName || guard.target.zoneId
      list.append(createElement("li", {
        text: `${zoneName}: ${guard.summary}`,
      }))
    }
  }
  section.append(list)
  return section
}

function activityRawPreview(entry) {
  return entry.plans.flatMap((plan) => plan.operations.map((operation) => ({
    body: operation.body,
    currentValue: operation.currentValue,
    label: operation.label,
    method: operation.method,
    path: operation.path,
    zone: plan.zoneName,
  })))
}

function activityUndoPresentation(entry) {
  const undone = verifiedUndoFor(entry)
  const pendingUndo = pendingUndoFor(entry)
  const guardFailure = state.activityGuardFailures.get(entry.id)
  if (undone) {
    return {
      className: "undone",
      text: `Undone and verified ${formatActivityTime(undone.completedAt)}`,
    }
  }
  if (pendingUndo) {
    return {
      className: "",
      text: `Guarded undo has been pending since ${formatActivityTime(pendingUndo.startedAt)}; inspect live state before retrying`,
    }
  }
  if (guardFailure) {
    return {
      className: "",
      text: `Undo blocked: ${guardFailure}`,
    }
  }
  if (entry.status === OPERATION_ACTIVITY_STATUS.PENDING) {
    return {
      className: "",
      text: entry.undoOf
        ? "This guarded undo did not record a final result; inspect live state before retrying"
        : "This operation did not record a final result; inspect live state before making another change",
    }
  }
  if (entry.undoOf) {
    return {
      className: entry.status === OPERATION_ACTIVITY_STATUS.VERIFIED
        ? "undone"
        : "",
      text: entry.status === OPERATION_ACTIVITY_STATUS.VERIFIED
        ? "This entry is the verified undo of an earlier operation"
        : "This guarded undo did not complete successfully; inspect live state before retrying",
    }
  }
  if (activityUndoable(entry)) {
    return {
      className: "available",
      text: "Undo is available after the affected Cloudflare resources pass a fresh drift check",
    }
  }
  return {
    className: "",
    text: `Automatic undo unavailable: ${entry.inverse?.reason || "the operation did not produce a lossless inverse"}`,
  }
}

function renderActivityEntry(entry) {
  const article = createElement("article", {
    className: `activity-entry ${entry.status}`,
  })
  const heading = createElement("header", { className: "activity-entry-heading" })
  const title = document.createElement("div")
  title.append(
    createElement("h3", { text: entry.title }),
    createElement("p", {
      text: `${formatActivityTime(entry.startedAt)} | ${entry.id}`,
    }),
  )
  heading.append(
    title,
    createElement("span", {
      className: `activity-status ${entry.status}`,
      text: ACTIVITY_STATUS_LABEL[entry.status],
    }),
  )
  article.append(heading)

  const operations = activityOperations(entry)
  const zones = activityZoneNames(entry)
  const summary = createElement("div", { className: "activity-entry-summary" })
  summary.append(
    createElement("span", {
      className: "activity-chip",
      text: `${operations.length} API write${operations.length === 1 ? "" : "s"}`,
    }),
    createElement("span", {
      className: "activity-chip",
      text: `${zones.length} zone${zones.length === 1 ? "" : "s"}`,
    }),
  )
  for (const zoneName of zones) {
    summary.append(createElement("span", {
      className: "activity-chip",
      text: zoneName,
    }))
  }
  article.append(summary)

  if (entry.error) {
    article.append(createElement("p", {
      className: "activity-error",
      text: entry.error,
    }))
  }
  const undo = activityUndoPresentation(entry)
  article.append(createElement("p", {
    className: `activity-undo-state ${undo.className}`.trim(),
    text: undo.text,
  }))

  const details = createElement("details")
  details.append(createElement("summary", { text: "Review operation details" }))
  const detailGrid = createElement("div", { className: "activity-detail-grid" })
  detailGrid.append(
    activityOperationList(entry),
    activityVerificationList(entry),
  )
  const raw = createElement("details")
  raw.append(
    createElement("summary", { text: "Show request payloads" }),
    createElement("pre", {
      text: JSON.stringify(activityRawPreview(entry), null, 2),
    }),
  )
  details.append(detailGrid, raw)
  article.append(details)

  if (activityUndoable(entry) && !readOnly) {
    const actions = createElement("div", { className: "activity-entry-actions" })
    const button = createElement("button", {
      className: "button button-danger activity-undo",
      text: "Review guarded undo",
    })
    button.type = "button"
    button.disabled = state.busy || !state.transportAvailable || !state.inventory
    button.title = "Fresh-read the affected resources before reviewing the inverse writes"
    activityEntryByButton.set(button, entry)
    actions.append(button)
    article.append(actions)
  }
  return article
}

function renderOperationActivity() {
  updateActivityButton()
  const filter = elements.activityFilter.value || ACTIVITY_FILTER.ALL
  const entries = [...state.activity.entries]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .filter((entry) => activityMatchesFilter(entry, filter))
  elements.activityVisibleCount.textContent = `${entries.length} operation${entries.length === 1 ? "" : "s"}`
  elements.activitySummary.textContent = state.activity.updatedAt
    ? `${state.activity.entries.length} durable operation record${state.activity.entries.length === 1 ? "" : "s"}; journal updated ${formatActivityTime(state.activity.updatedAt)}.`
    : "Reviewed Cloudflare writes will be recorded before execution and finalized after scoped live verification."
  if (entries.length === 0) {
    elements.activityList.replaceChildren(createElement("p", {
      className: "activity-empty",
      text: state.activity.entries.length === 0
        ? "No Cloudflare writes have been recorded yet"
        : "No operation records match this filter",
    }))
    return
  }
  elements.activityList.replaceChildren(...entries.map(renderActivityEntry))
}

async function loadOperationActivity(options = {}) {
  if (!api.usesBroker) {
    elements.activityLoadError.textContent = "Operation history is unavailable in a direct debug session"
    elements.activityLoadError.hidden = false
    renderOperationActivity()
    return false
  }
  if (state.activityLoading) return false
  state.activityLoading = true
  elements.activityRefresh.disabled = true
  try {
    const document = await api.loadOperationActivity()
    if (!isOperationActivityDocument(document)) {
      throw new Error("The persisted operation history is invalid")
    }
    state.activity = document
    elements.activityLoadError.hidden = true
    elements.activityLoadError.textContent = ""
    renderOperationActivity()
    return true
  } catch (error) {
    elements.activityLoadError.textContent = error instanceof Error
      ? error.message
      : String(error)
    elements.activityLoadError.hidden = false
    renderOperationActivity()
    if (!options.silent) toast(elements.activityLoadError.textContent, "error")
    return false
  } finally {
    state.activityLoading = false
    elements.activityRefresh.disabled = false
  }
}

async function openOperationActivity() {
  renderOperationActivity()
  showDialog(elements.activityDialog, {
    initialFocus: elements.activityFilter,
  })
  await loadOperationActivity({ silent: true })
}

async function readActivityVerification(entry, message) {
  const targets = entry.verification.map((guard) => guard.target)
  if (targets.length === 0) {
    throw new Error("This operation has no recorded verification guard")
  }
  setStatus(`${message} 0/${targets.length}`)
  let completed = 0
  const entries = await Promise.all(targets.map(async (target) => {
    const result = await readWriteVerificationTarget(target)
    completed += 1
    setStatus(`${message} ${completed}/${targets.length}`)
    return result
  }))
  const comparison = compareVerificationGuards(entry.verification, entries)
  if (!comparison.matches) {
    const summaries = comparison.differences
      .slice(0, 3)
      .map((difference) => difference.expected?.summary || difference.actual?.summary)
      .filter(Boolean)
    const suffix = summaries.length > 0 ? `: ${summaries.join(", ")}` : ""
    throw new Error(`Live state no longer matches the recorded verified result${suffix}`)
  }
  return entries
}

async function undoOperationActivity(entry) {
  if (!activityUndoable(entry) || state.busy || readOnly) return
  if (elements.activityDialog.open) elements.activityDialog.close()
  state.activityGuardFailures.delete(entry.id)
  setBusy(true)
  try {
    await readActivityVerification(entry, "Checking undo guard")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    state.activityGuardFailures.set(entry.id, message)
    toast(message, "error")
    restoreInventoryStatus()
    setBusy(false)
    renderOperationActivity()
    showDialog(elements.activityDialog, {
      initialFocus: elements.activityFilter,
    })
    return
  }
  setBusy(false)
  restoreInventoryStatus()
  const applied = await applyPlans(
    `Undo ${entry.title}`,
    createLivePlanSet(entry.inverse.plans),
    {
      beforeExecute: () => readActivityVerification(
        entry,
        "Rechecking undo guard",
      ),
      confirmationNote: "The affected resources match the recorded post-write state. They will be checked again immediately after confirmation before any inverse request is sent.",
      recordInverse: false,
      successMessage: "Undo succeeded and live verification passed",
      undoOf: entry.id,
    },
  )
  await loadOperationActivity({ silent: true })
  renderOperationActivity()
  if (!elements.activityDialog.open) {
    showDialog(elements.activityDialog, {
      initialFocus: applied
        ? elements.activityList.querySelector(".activity-entry summary, .activity-entry button")
        : elements.activityFilter,
    })
  }
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

function confirmPlans(title, planSet, options = {}) {
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
  elements.confirmSummary.textContent = `Live state was validated at ${validationTime}. ${actionable.length} zone${actionable.length === 1 ? "" : "s"} and ${operations.length} API write${operations.length === 1 ? "" : "s"} will be applied, then the affected live state will be re-read for verification.${options.confirmationNote ? ` ${options.confirmationNote}` : ""}`
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
      fallbackFocus: options.fallbackFocus,
      initialFocus: elements.confirmDialog.querySelector("[value='cancel']"),
    })
  })
}

async function applyPlans(title, planSet, options = {}) {
  if (!planSet?.[LIVE_PLAN_SET]) {
    toast("This change has not passed live validation", "error")
    return false
  }
  try {
    verificationTargetsForPlans(planSet.plans)
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error")
    return false
  }
  if (!await confirmPlans(title, planSet, options)) return false
  const plans = planSet.plans
  setBusy(true)
  let writesCompleted = false
  let writeAttempted = false
  let activityEntry = null
  const executionResults = []
  const operationCount = plans.reduce(
    (count, plan) => count + plan.operations.length,
    0,
  )
  try {
    if (options.beforeExecute) await options.beforeExecute()
    if (api.usesBroker) {
      const pendingActivity = createPendingOperationActivity(title, planSet, {
        undoOf: options.undoOf || null,
      })
      state.activity = await api.appendOperationActivity(pendingActivity)
      activityEntry = pendingActivity
      renderOperationActivity()
    }
    writeAttempted = true
    await executePlans(api, plans, {
      onProgress: ({ completed, total, operation, plan }) => {
        if (operation) setStatus(`Writing ${completed + 1}/${total}: ${plan.zoneName}`)
      },
      onResult: (result) => executionResults.push(result),
    })
    writesCompleted = true
    toast("Writes succeeded; re-reading live state for verification")
    const verificationTargets = verificationTargetsForResults(executionResults)
    const verificationEntries = await verifyChangedWriteTargets(verificationTargets)
    const inverse = options.recordInverse === false
      ? {
          available: false,
          plans: [],
          reason: "Undo operations are recorded as final to avoid an implicit redo chain",
        }
      : buildInversePlans(executionResults)
    if (activityEntry) {
      const completed = completeOperationActivity(activityEntry, {
        execution: {
          completed: executionResults.length,
          total: operationCount,
        },
        inverse,
        status: OPERATION_ACTIVITY_STATUS.VERIFIED,
        verification: createVerificationGuards(verificationEntries),
      })
      try {
        state.activity = await api.finalizeOperationActivity(completed)
        renderOperationActivity()
      } catch (error) {
        setRefreshDetail(
          `Live verification passed, but operation history was not finalized: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        )
        toast("Writes and verification succeeded, but the durable history record is incomplete", "error")
        return true
      }
    }
    toast(options.successMessage || "Writes succeeded and live verification passed")
    return true
  } catch (error) {
    setStatus(
      writesCompleted
        ? "Verification failed"
        : writeAttempted
          ? "Write failed"
          : "Validation failed",
      "error",
    )
    toast(error instanceof Error ? error.message : String(error), "error")
    let verification = []
    try {
      if (executionResults.length > 0) {
        const targets = verificationTargetsForResults(executionResults)
        const entries = await verifyChangedWriteTargets(targets)
        verification = createVerificationGuards(entries)
      } else {
        restoreInventoryStatus()
      }
    } catch {
      restoreInventoryStatus()
    }
    if (activityEntry) {
      const completed = completeOperationActivity(activityEntry, {
        error: error instanceof Error ? error.message : String(error),
        execution: {
          completed: executionResults.length,
          total: operationCount,
        },
        inverse: {
          available: false,
          plans: [],
          reason: writesCompleted
            ? "Live verification did not complete, so no safe undo guard exists"
            : "The write sequence did not complete, so a batch inverse would be unsafe",
        },
        status: writesCompleted
          ? OPERATION_ACTIVITY_STATUS.VERIFICATION_FAILED
          : OPERATION_ACTIVITY_STATUS.WRITE_FAILED,
        verification,
      })
      try {
        state.activity = await api.finalizeOperationActivity(completed)
        renderOperationActivity()
      } catch (historyError) {
        setRefreshDetail(
          `The write result could not be finalized in operation history: ${historyError instanceof Error ? historyError.message : String(historyError)}`,
          "error",
        )
      }
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

async function reviewDnssecIntentCorrection(correction, title = "Align DNSSEC with fleet intent") {
  if (!correction?.available || correction.targets.length === 0) {
    toast(correction?.reason || "No correctable DNSSEC status drift is present", "error")
    return false
  }
  const desiredStatusByZoneId = new Map(
    correction.targets.map((target) => [target.zoneId, target.desiredStatus]),
  )
  const zoneIds = correction.targets.map((target) => target.zoneId)
  const intentWasOpen = elements.intentDialog.open
  try {
    const liveData = await runWritePreflight(
      "DNSSEC intent",
      () => executePreflightRead([
        {
          type: READ_ACTION.DNSSEC_ALIGNMENT,
          zoneIds,
        },
      ]),
    )
    const liveInventory = liveData.inventory
    assertSurfaceReads(liveInventory, DNSSEC_PREFLIGHT_SURFACE_IDS, "DNSSEC")
    const plans = selectedLiveZones(liveInventory, zoneIds).map((zone) => {
      const desiredStatus = desiredStatusByZoneId.get(zone.meta.id)
      if (!desiredStatus) {
        throw new Error(`DNSSEC intent is unavailable for ${zone.meta.name}`)
      }
      return buildDnssecStatusPlan(zone, desiredStatus)
    })
    if (intentWasOpen) elements.intentDialog.close()
    const applied = await applyPlans(
      title,
      createLivePlanSet(plans),
      {
        confirmationNote: dnssecConfirmationNote(plans),
        successMessage: "DNSSEC correction requests succeeded and live state was re-read",
      },
    )
    if (intentWasOpen) openIntentManager()
    return applied
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error")
    return false
  }
}

function dnssecConfirmationNote(plans) {
  const statuses = new Set(plans.flatMap((plan) => (
    plan.operations.map((operation) => operation.body?.status)
  )))
  const notes = []
  if (statuses.has(DNSSEC_STATUS.ACTIVE)) {
    notes.push("Cloudflare may report DNSSEC as pending until the parent DS record is published; a non-Cloudflare registrar may require manual DS setup.")
  }
  if (statuses.has(DNSSEC_STATUS.DISABLED)) {
    notes.push("Before disabling, remove the parent DS record and wait for its TTL to expire; otherwise validating resolvers can fail.")
  }
  return notes.join(" ")
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
  const batch = intentCompatibleDnsTargetFillBatch(row)
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
  if (action.intentPresenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN) {
    toast("This policy requires the facet to remain absent. Fill actions are unavailable.", "error")
    return
  }
  if (action.intentValueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER) {
    toast(
      action.intentPresenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL
        ? "This policy allows absence, but any added value must be distinct. Copying an existing fleet value would violate uniqueness."
        : "This policy requires a new distinct value. Copying an existing fleet value would violate uniqueness.",
      "error",
    )
    return
  }
  if (action.resolution.kind === HOLE_RESOLUTION_KIND.EMAIL_POLICY) {
    if (action.intentExpectedAuthored) {
      toast("This custom intent has no product-specific create plan. It can detect this missing value but will not apply a different Email policy.", "error")
      return
    }
    fillHole(action)
    return
  }
  const intended = action.resolution.candidates.find(
    (candidate) => candidate.canonical === action.intentExpectedCanonical,
  )
  if (intended) {
    fillHole(action, intended)
    return
  }
  if (action.intentGoverned
    && action.intentValueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.EXACT) {
    toast("No fleet source matches this intent value. Edit an existing value or use a product-specific create flow instead.", "error")
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

function cachedEmailRoutingRule(zone, action) {
  if (action.catchAll) {
    return zone.surfaces["email-catch-all"]?.result || null
  }
  return (zone.surfaces["email-rules"]?.result || [])
    .find((rule) => rule.id === action.ruleId) || null
}

function emailRoutingRuleLabel(rule, catchAll = false) {
  if (catchAll) return "Catch-all rule"
  return rule.name
    || rule.matchers?.find((matcher) => matcher.value)?.value
    || "Email Routing rule"
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
        text: "No cached fields. Use Show raw JSON to add a field.",
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

function createGenericValueEditorFragment(draft, editor = {}) {
  const fragment = document.createDocumentFragment()
  if (jsonValueKind(draft) !== JSON_VALUE_KIND.OBJECT) {
    fragment.append(createValueField(draft, [], "Value", editor))
    return fragment
  }
  const entries = orderedValueEntries(draft)
  if (entries.length === 0) {
    fragment.append(
      createElement("p", {
        className: "empty-value",
        text: "No fields. Use Show raw JSON to add an uncommon field.",
      }),
    )
    return fragment
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
  return fragment
}

function makeRedirectFieldFriendly(field, options = {}) {
  field.classList.add("redirect-editor-field")
  field.querySelector(":scope > .value-type")?.remove()
  const control = field.querySelector(".value-control")
  if (control && options.required) control.required = true
  if (control && options.help) {
    const help = createElement("small", {
      className: "value-help",
      text: options.help,
    })
    help.id = `${control.id}-help`
    control.setAttribute("aria-describedby", help.id)
    field.append(help)
  }
  return field
}

function createRedirectScalarField(value, path, label, options = {}) {
  return makeRedirectFieldFriendly(
    createScalarValueField(value, path, label),
    options,
  )
}

function createRedirectSelectField(label, className = "") {
  const field = createElement("div", {
    className: `value-field redirect-editor-field${className ? ` ${className}` : ""}`,
  })
  const controlId = valueEditorControlId()
  const heading = createElement("label", { text: label })
  const select = document.createElement("select")
  heading.htmlFor = controlId
  select.id = controlId
  select.className = "value-control"
  field.append(heading, select)
  return { field, select }
}

function appendRedirectSelectOption(select, value, label, selected = false) {
  const option = createElement("option", { text: label })
  option.value = String(value)
  option.selected = selected
  select.append(option)
}

function createRedirectStatusField(statusCode, path) {
  const { field, select } = createRedirectSelectField("HTTP response")
  if (statusCode === null) {
    appendRedirectSelectOption(select, "", "Choose a response code", true)
  } else if (!REDIRECT_STATUS_OPTIONS.some(({ value }) => value === statusCode)) {
    appendRedirectSelectOption(select, statusCode, `HTTP ${statusCode}`, true)
  }
  for (const option of REDIRECT_STATUS_OPTIONS) {
    appendRedirectSelectOption(
      select,
      option.value,
      option.label,
      option.value === statusCode,
    )
  }
  select.required = true
  select.dataset.valueKind = JSON_VALUE_KIND.NUMBER
  select.dataset.valuePath = encodeValuePath(path)
  return field
}

function createRedirectTargetKindField(targetKind) {
  const { field, select } = createRedirectSelectField("Destination type")
  appendRedirectSelectOption(
    select,
    REDIRECT_TARGET_KIND.STATIC,
    "Static URL",
    targetKind === REDIRECT_TARGET_KIND.STATIC,
  )
  appendRedirectSelectOption(
    select,
    REDIRECT_TARGET_KIND.DYNAMIC,
    "Dynamic expression",
    targetKind === REDIRECT_TARGET_KIND.DYNAMIC,
  )
  select.dataset.redirectTargetKind = ""
  return field
}

function createRedirectQueryField(preserveQueryString) {
  const { field, select } = createRedirectSelectField("Query string")
  appendRedirectSelectOption(
    select,
    REDIRECT_QUERY_CHOICE.KEEP,
    "Keep the original query string",
    preserveQueryString === true,
  )
  appendRedirectSelectOption(
    select,
    REDIRECT_QUERY_CHOICE.DROP,
    "Drop the original query string",
    preserveQueryString === false,
  )
  appendRedirectSelectOption(
    select,
    REDIRECT_QUERY_CHOICE.UNSPECIFIED,
    "Use Cloudflare's default",
    preserveQueryString === null,
  )
  select.dataset.redirectQuery = ""
  return field
}

function createRedirectEditorGroup(label, fields) {
  const group = document.createElement("fieldset")
  group.className = "value-group redirect-editor-group"
  group.append(createElement("legend", { text: label }))
  const contents = createElement("div", { className: "value-group-fields" })
  contents.append(...fields)
  group.append(contents)
  return group
}

function createRedirectEditorFields(editor) {
  const draft = editor.draft
  const redirect = presentRule(draft).redirect
  const fromValue = draft.action_parameters?.from_value
  if (!redirect
    || !fromValue
    || ![REDIRECT_TARGET_KIND.DYNAMIC, REDIRECT_TARGET_KIND.STATIC]
      .includes(redirect.targetKind)) {
    return null
  }

  const ruleFields = [createRedirectScalarField(
    typeof draft.description === "string" ? draft.description : "",
    ["description"],
    "Rule name",
    { help: "Shown in the matrix and Cloudflare rule lists" },
  )]
  ruleFields.push(createRedirectScalarField(
    draft.enabled !== false,
    ["enabled"],
    "Enabled",
  ))
  if (typeof draft.ref === "string") {
    ruleFields.push(createRedirectScalarField(
      draft.ref,
      ["ref"],
      "Stable reference",
      { help: "Preserved across rule versions" },
    ))
  }

  const matchField = createRedirectScalarField(
    typeof draft.expression === "string" ? draft.expression : "",
    ["expression"],
    "Request matching expression",
    {
      help: "A Cloudflare Rules expression that selects requests to redirect",
      required: true,
    },
  )
  matchField.classList.add("multiline")

  const targetFieldName = redirect.targetKind === REDIRECT_TARGET_KIND.STATIC
    ? "value"
    : "expression"
  const targetPath = [
    ...REDIRECT_FROM_VALUE_PATH,
    "target_url",
    targetFieldName,
  ]
  const targetField = createRedirectScalarField(
    redirect.target,
    targetPath,
    redirect.targetKind === REDIRECT_TARGET_KIND.STATIC
      ? "Destination URL"
      : "Destination expression",
    {
      help: redirect.targetKind === REDIRECT_TARGET_KIND.STATIC
        ? "The complete URL returned in the Location header"
        : "A Cloudflare Rules expression that evaluates to the destination URL",
      required: true,
    },
  )
  targetField.classList.add("multiline")
  if (redirect.targetKind === REDIRECT_TARGET_KIND.STATIC) {
    const targetControl = targetField.querySelector(".value-control")
    targetControl.type = "url"
    targetControl.inputMode = "url"
  }

  const responseFields = [
    createRedirectTargetKindField(redirect.targetKind),
    createRedirectStatusField(
      redirect.statusCode,
      [...REDIRECT_FROM_VALUE_PATH, "status_code"],
    ),
    targetField,
    createRedirectQueryField(redirect.preserveQueryString),
  ]
  const fields = [
    createRedirectEditorGroup("Rule", ruleFields),
    createRedirectEditorGroup("When", [matchField]),
    createRedirectEditorGroup("Then redirect", responseFields),
  ]
  const additionalFields = Object.entries(draft)
    .filter(([key]) => !REDIRECT_PRIMARY_RULE_FIELDS.has(key))
    .map(([key, value]) => createValueField(
      value,
      [key],
      humanizeValueField(key),
      editor,
    ))
  if (additionalFields.length > 0) {
    fields.push(createRedirectEditorGroup("Additional settings", additionalFields))
  }

  const entry = selectedEditorEntry()
  elements.valueEditorContext.textContent = [
    entry?.presentation?.phase
      ? rulePhaseLabel(entry.presentation.phase)
      : "Single redirect",
    redirect.targetKindLabel,
  ].join(" | ")
  return fields
}

function renderValueEditor() {
  const editor = state.editor
  if (!editor) return
  const draft = editor.draft
  if (jsonValueKind(draft) === JSON_VALUE_KIND.OBJECT) {
    const redirectFields = createRedirectEditorFields(editor)
    if (redirectFields) {
      elements.valueEditorFields.replaceChildren(...redirectFields)
      return
    }
  }
  elements.valueEditorFields.replaceChildren(
    createGenericValueEditorFragment(draft, editor),
  )
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

function resetRedirectTargetDrafts(editor) {
  editor.redirectTargetDrafts = new Map()
  const redirect = presentRule(editor.draft).redirect
  if (redirect && [REDIRECT_TARGET_KIND.DYNAMIC, REDIRECT_TARGET_KIND.STATIC]
    .includes(redirect.targetKind)) {
    editor.redirectTargetDrafts.set(redirect.targetKind, redirect.target)
  }
}

function initialRedirectTargetForKind(redirect, targetKind) {
  if (targetKind === REDIRECT_TARGET_KIND.DYNAMIC) {
    return redirect.targetKind === REDIRECT_TARGET_KIND.STATIC
      ? JSON.stringify(redirect.target)
      : redirect.target
  }
  if (redirect.targetKind === REDIRECT_TARGET_KIND.DYNAMIC) {
    try {
      const literal = JSON.parse(redirect.target)
      return typeof literal === "string" ? literal : ""
    } catch {
      return ""
    }
  }
  return redirect.target
}

function changeRedirectTargetKind(event) {
  const control = event.target.closest("[data-redirect-target-kind]")
  const editor = state.editor
  if (!control || !editor) return
  const redirect = presentRule(editor.draft).redirect
  const targetKind = control.value
  if (!redirect
    || targetKind === redirect.targetKind
    || ![REDIRECT_TARGET_KIND.DYNAMIC, REDIRECT_TARGET_KIND.STATIC]
      .includes(targetKind)) {
    return
  }
  editor.redirectTargetDrafts.set(redirect.targetKind, redirect.target)
  const target = editor.redirectTargetDrafts.get(targetKind)
    ?? initialRedirectTargetForKind(redirect, targetKind)
  editor.redirectTargetDrafts.set(targetKind, target)
  const field = targetKind === REDIRECT_TARGET_KIND.STATIC
    ? "value"
    : "expression"
  replaceEditorDraft(replaceValueAtPath(
    editor.draft,
    [...REDIRECT_FROM_VALUE_PATH, "target_url"],
    { [field]: target },
  ))
  requestAnimationFrame(() => focusValueEditorPath([
    ...REDIRECT_FROM_VALUE_PATH,
    "target_url",
    field,
  ]))
}

function changeRedirectQuery(event) {
  const control = event.target.closest("[data-redirect-query]")
  const editor = state.editor
  if (!control || !editor) return
  const fromValue = {
    ...editor.draft.action_parameters?.from_value,
  }
  if (control.value === REDIRECT_QUERY_CHOICE.UNSPECIFIED) {
    delete fromValue.preserve_query_string
  } else {
    fromValue.preserve_query_string = control.value === REDIRECT_QUERY_CHOICE.KEEP
  }
  replaceEditorDraft(replaceValueAtPath(
    editor.draft,
    REDIRECT_FROM_VALUE_PATH,
    fromValue,
  ), { render: false })
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
  resetRedirectTargetDrafts(state.editor)
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
    resetRedirectTargetDrafts(state.editor)
    elements.editorValue.removeAttribute("aria-invalid")
    clearFieldError(elements.editorValue, elements.editorError)
    renderValueEditor()
  } catch {
    elements.editorValue.setAttribute("aria-invalid", "true")
  }
}

function focusDraftEditorPath(container, path) {
  const encoded = encodeValuePath(path)
  const control = [...container.querySelectorAll(".value-control")]
    .find((candidate) => candidate.dataset.valuePath === encoded)
  control?.focus()
}

function focusValueEditorPath(path) {
  focusDraftEditorPath(elements.valueEditorFields, path)
}

function mainValueDraftContext() {
  if (!state.editor) return null
  return {
    container: elements.valueEditorFields,
    draft: state.editor.draft,
    replaceDraft: replaceEditorDraft,
  }
}

function intentPolicyValueDraftContext() {
  if (!state.intentPolicyDraft) return null
  return {
    container: elements.intentPolicyCustomFields,
    draft: state.intentPolicyDraft.customDraft,
    replaceDraft: replaceIntentPolicyCustomDraft,
  }
}

function updateDraftEditorControl(event, context) {
  const control = event.target.closest("[data-value-path]")
  if (!control || !context) return
  const path = decodeValuePath(control.dataset.valuePath)
  try {
    const value = parseScalarControl(
      control.dataset.valueKind,
      control.value,
      control.checked,
    )
    control.setCustomValidity("")
    context.replaceDraft(
      replaceValueAtPath(context.draft, path, value),
      { render: false },
    )
  } catch (error) {
    control.setCustomValidity(error instanceof Error ? error.message : String(error))
  }
}

function updateGeneratedEditorControl(event) {
  updateDraftEditorControl(event, mainValueDraftContext())
}

function updateIntentPolicyCustomControl(event) {
  updateDraftEditorControl(event, intentPolicyValueDraftContext())
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

function renameDraftEditorObjectKey(event, context) {
  const control = event.target.closest("[data-object-key-path]")
  if (!control || !context) return
  const path = decodeValuePath(control.dataset.objectKeyPath)
  const currentKey = control.dataset.objectKeyOriginal
  const desiredKey = control.value.trim()
  try {
    if (!HTTP_HEADER_NAME_PATTERN.test(desiredKey)) {
      throw new TypeError("Enter a valid HTTP header name")
    }
    const object = valueAtPath(context.draft, path)
    const collision = Object.keys(object).find(
      (key) => key !== currentKey
        && key.toLowerCase() === desiredKey.toLowerCase(),
    )
    if (collision) throw new Error(`Header ${collision} already exists`)
    control.setCustomValidity("")
    const mapEntry = control.closest(".value-map-entry")
    const nextDraft = renameObjectKeyAtPath(
      context.draft,
      path,
      currentKey,
      desiredKey,
    )
    context.replaceDraft(
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

function renameGeneratedEditorObjectKey(event) {
  renameDraftEditorObjectKey(event, mainValueDraftContext())
}

function renameIntentPolicyCustomObjectKey(event) {
  renameDraftEditorObjectKey(event, intentPolicyValueDraftContext())
}

function changeDraftNullType(event, context) {
  const control = event.target.closest("[data-null-path]")
  if (!control || !context) return
  const path = decodeValuePath(control.dataset.nullPath)
  const replacement = defaultValueForKind(control.value)
  context.replaceDraft(
    replaceValueAtPath(context.draft, path, replacement),
  )
  requestAnimationFrame(() => focusDraftEditorPath(context.container, path))
}

function changeNullEditorType(event) {
  changeDraftNullType(event, mainValueDraftContext())
}

function changeIntentPolicyCustomNullType(event) {
  changeDraftNullType(event, intentPolicyValueDraftContext())
}

function handleDraftEditorAction(event, context) {
  const add = event.target.closest(".value-array-add")
  if (add && context) {
    const path = decodeValuePath(add.dataset.arrayPath)
    const nextIndex = valueAtPath(context.draft, path).length
    context.replaceDraft(appendArrayItemAtPath(context.draft, path))
    requestAnimationFrame(() => focusDraftEditorPath(
      context.container,
      [...path, nextIndex],
    ))
    return
  }
  const remove = event.target.closest(".value-array-remove")
  if (!remove || !context) return
  const path = decodeValuePath(remove.dataset.arrayPath)
  context.replaceDraft(
    removeArrayItemAtPath(
      context.draft,
      path,
      Number(remove.dataset.arrayIndex),
    ),
  )
  requestAnimationFrame(() => {
    const encoded = encodeValuePath(path)
    const addButton = [...context.container.querySelectorAll(".value-array-add")]
      .find((candidate) => candidate.dataset.arrayPath === encoded)
    addButton?.focus()
  })
}

function handleValueEditorAction(event) {
  handleDraftEditorAction(event, mainValueDraftContext())
}

function handleIntentPolicyCustomAction(event) {
  handleDraftEditorAction(event, intentPolicyValueDraftContext())
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
  const fallbackFocus = () => {
    const target = editor.cell.querySelector(".edit-cell")
    if (!target || !matrixActionIsAvailable(target)) return elements.matrixShell
    syncMatrixActionTabStop(target)
    return target
  }
  closeInlineEditor({ restoreFocus: false })
  await applyPlans("Update zone setting", createLivePlanSet([plan]), {
    fallbackFocus,
  })
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
    zone,
  } = options
  state.editor = {
    action,
    afterApply,
    entries,
    suggestions,
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
  if (action.type === READ_ACTION.EMAIL_RULE_EDIT) {
    const rule = cachedEmailRoutingRule(zone, action)
    if (!rule) {
      toast("The selected Email Routing rule is no longer available", "error")
      return
    }
    const label = emailRoutingRuleLabel(rule, action.catchAll)
    entries = [
      {
        id: rule.id || action.ruleIdentifier,
        label,
        value: editableEmailRoutingRulePayload(rule, {
          catchAll: action.catchAll,
        }),
      },
    ]
    suggestions = collectValueSuggestions(entries.map((entry) => entry.value))
    kind = action.catchAll
      ? "Email Routing catch-all"
      : "Email Routing rule"
    title = label
    valueLabel = "Desired route definition"
  } else if (action.type === "zone-setting") {
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
    const applied = await applyPlans(title, createLivePlanSet([plan]))
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

async function planEmailRoutingRuleEdit(editor, desiredDefinition) {
  const readAction = {
    ruleIdentifier: editor.action.ruleIdentifier,
    type: READ_ACTION.EMAIL_RULE_EDIT,
    zoneId: editor.zone.meta.id,
  }
  const resourceId = actionResourceId(readAction)
  const liveData = await runWritePreflight(
    `${emailRoutingRuleLabel(editor.entries[0]?.value, editor.action.catchAll)} on ${editor.zone.meta.name}`,
    () => executePreflightRead([
      readAction,
    ]),
  )
  const liveRule = liveData.resources.get(resourceId)
  if (!liveRule) {
    throw new Error("Email Routing rule live validation returned no definition")
  }
  return buildEmailRoutingRuleEditPlan(
    editor.zone,
    liveRule,
    desiredDefinition,
    {
      catchAll: editor.action.catchAll,
    },
  )
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
    if (editor.action.type === READ_ACTION.EMAIL_RULE_EDIT) {
      plan = await planEmailRoutingRuleEdit(editor, desired)
      confirmationTitle = "Update Email Routing rule"
    } else if (editor.action.type === "zone-setting") {
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
  )
  await editor.afterApply?.(applied)
}

function renderInventory(inventory, source) {
  const observedMatrix = buildMatrix(inventory)
  const evaluation = evaluateFleetIntent(
    state.intent,
    inventory,
    observedMatrix,
  )
  const nextMatrix = {
    ...observedMatrix,
    rows: observedMatrix.rows.map((row) => {
      const rowState = evaluation.rowStates.get(
        fleetIntentFacetId(row.category, row.key),
      )
      return {
        ...row,
        actionable: rowState.actionable,
        intentState: rowState,
      }
    }),
    summary: {
      ...observedMatrix.summary,
      differences: evaluation.summary.actionableRows,
      rawDifferences: observedMatrix.summary.differences,
    },
  }
  const nextMatrixRenderKey = `${matrixRenderKey(inventory, observedMatrix)}\u0000${state.intent.revision}`
  const matrixChanged = nextMatrixRenderKey !== state.matrixRenderKey
  state.inventory = inventory
  state.inventorySource = source
  state.matrix = nextMatrix
  state.matrixRenderKey = nextMatrixRenderKey
  state.intentEvaluation = evaluation

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
  if (elements.intentDialog.open) renderIntentManager()
  if (elements.rulesetComparisonDialog.open) renderRulesetComparison()
  if (elements.valueComparisonDialog.open) renderValueComparison()
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
  if (options.staleCache) {
    setRefreshDetail(
      `Cached full audit is older than ${CACHE_MAX_AGE_HOURS} hours; automatic refresh running`,
    )
  }
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
  try {
    renderOperationActivity()
    await Promise.all([
      syncFleetIntent({ silent: true }),
      loadOperationActivity({ silent: true }),
    ])
    if (cachedRecord) {
      state.startupCacheLoadedAt = cachedRecord.loadedAt
      renderInventory(cachedRecord.inventory, INVENTORY_SOURCE.CACHE)
      restoreInventoryStatus()
      if (!cacheRecordIsFresh(cachedRecord)) {
        await refreshInventory({
          preserveSelection: true,
          staleCache: true,
        })
      }
      return
    }
    await refreshInventory()
  } finally {
    application.dataset.initializing = "false"
  }
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
  syncRedirectTypeAvailability()
  renderCategoryCapability()
  filterRows()
})
elements.scope.addEventListener("change", filterRows)
elements.dnsType.addEventListener("change", filterRows)
elements.redirectType.addEventListener("change", filterRows)
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
elements.changeSupportToggle.addEventListener("click", () => {
  const next = elements.changeSupportToggle.getAttribute("aria-pressed") !== "true"
  elements.changeSupportToggle.setAttribute("aria-pressed", String(next))
  filterRows()
})
elements.filterPanelToggle.addEventListener("click", () => {
  state.filterPanelExpanded = !state.filterPanelExpanded
  syncMatrixFilterControls()
})
elements.filterReset.addEventListener("click", resetMatrixFilters)
elements.matrixFocus.addEventListener("click", () => {
  setMatrixFocus(!document.body.classList.contains(MATRIX_FOCUS_CLASS))
})
elements.mobileMatrixFocus.addEventListener("click", () => {
  setMatrixFocus(!document.body.classList.contains(MATRIX_FOCUS_CLASS))
})
compactFilterMedia.addEventListener("change", syncResponsiveFilterPanel)
elements.matrixGuide.addEventListener("keydown", handleMatrixGuideKeydown)
elements.matrixHead.addEventListener("change", (event) => {
  const checkbox = event.target.closest("input[data-zone-id]")
  if (!checkbox) return
  if (checkbox.checked) state.selectedZoneIds.add(checkbox.dataset.zoneId)
  else state.selectedZoneIds.delete(checkbox.dataset.zoneId)
  updateSelectionStyles()
})
elements.matrixBody.addEventListener("click", (event) => {
  const intentCorrectionButton = event.target.closest(".apply-intent-correction")
  if (intentCorrectionButton) {
    const correction = intentCorrectionByButton.get(intentCorrectionButton)
    if (!correction) {
      toast("The selected intent correction is no longer available", "error")
      return
    }
    reviewDnssecIntentCorrection(correction)
    return
  }
  const valueComparisonButton = event.target.closest(".compare-values")
  if (valueComparisonButton) {
    const row = valueComparisonRowByButton.get(valueComparisonButton)
    if (!row) {
      toast("The selected value comparison is no longer available", "error")
      return
    }
    showValueComparison(row)
    return
  }
  const rulesetComparisonButton = event.target.closest(
    ".review-ruleset-comparison",
  )
  if (rulesetComparisonButton) {
    const row = rulesetComparisonRowByButton.get(rulesetComparisonButton)
    if (!row) {
      toast("The selected ruleset comparison is no longer available", "error")
      return
    }
    showRulesetComparison(row)
    return
  }
  const intentCellButton = event.target.closest(
    ".acknowledge-intent, .remove-acknowledgement",
  )
  if (intentCellButton) {
    activateIntentCellAction(intentCellButton)
    return
  }
  const intentPolicyButton = event.target.closest(".intent-set-policy")
  if (intentPolicyButton) {
    activateIntentPolicyRow(intentPolicyButton)
    return
  }
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
  selectZoneIds(workflowOrIntentDriftZoneIds())
})
elements.chooseTargets.addEventListener("click", showTargetDialog)
elements.matrixChooseTargets.addEventListener("click", showTargetDialog)
elements.selectedColumnsOnly.addEventListener("click", () => {
  state.selectedColumnsOnly = !state.selectedColumnsOnly
  updateSelectionStyles()
})
elements.reviewNeedsAttention.addEventListener("click", showNeedsAttention)
elements.showSupportedChanges.addEventListener("click", showSupportedChanges)
elements.showDnssecWorkflow.addEventListener("click", showDnssecWorkflow)
elements.showActivity.addEventListener("click", openOperationActivity)
elements.activityRefresh.addEventListener("click", () => loadOperationActivity())
elements.activityFilter.addEventListener("change", renderOperationActivity)
elements.activityList.addEventListener("click", (event) => {
  const button = event.target.closest(".activity-undo")
  if (!button) return
  const entry = activityEntryByButton.get(button)
  if (!entry) {
    toast("The selected operation record is no longer available", "error")
    return
  }
  undoOperationActivity(entry)
})
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
  selectZoneIds(workflowOrIntentDriftZoneIds())
})
elements.targetClear.addEventListener("click", () => {
  selectZoneIds([])
})
elements.coverageGroups.addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-coverage-section]")
  if (!toggle) return
  const section = toggle.dataset.coverageSection
  if (!Object.values(COVERAGE_SECTION).includes(section)) return
  state.coverageExpanded[section] = !state.coverageExpanded[section]
  syncCoverageVisibility()
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
elements.valueEditorFields.addEventListener("change", changeRedirectTargetKind)
elements.valueEditorFields.addEventListener("change", changeRedirectQuery)
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
elements.rulesetComparisonGroups.addEventListener("click", (event) => {
  const intentButton = event.target.closest(
    ".acknowledge-intent, .remove-acknowledgement",
  )
  if (intentButton) {
    activateIntentCellAction(intentButton)
    return
  }
  const button = event.target.closest(".open-ruleset")
  if (!button) return
  const action = workspaceActionByButton.get(button)
  if (!action || action.type !== RULESET_ACTION_KIND.OPEN) {
    toast("The selected ruleset is no longer available", "error")
    return
  }
  openRulesetWorkspace(action)
})
elements.rulesetComparisonShowRules.addEventListener("click", showRulesetChildRows)
elements.rulesetComparisonUseBaseline.addEventListener(
  "click",
  editRulesetExactCountIntent,
)
elements.rulesetComparisonAllowDifferences.addEventListener(
  "click",
  allowRulesetCountDifferences,
)
elements.rulesetComparisonDialog.addEventListener("close", () => {
  state.rulesetComparisonRowKey = null
})
elements.valueComparisonDialog.addEventListener("close", () => {
  state.valueComparisonRowKey = null
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
elements.manageIntent.addEventListener("click", openIntentManager)
elements.intentReviewUngoverned.addEventListener("click", openIntentAdoption)
elements.intentAdoptionAddGroup.addEventListener("click", () => {
  openIntentGroupEditor(null, { returnToAdoption: true })
})
elements.intentAdoptionSearch.addEventListener("input", filterIntentAdoptionCandidates)
elements.intentAdoptionPattern.addEventListener("change", filterIntentAdoptionCandidates)
elements.intentAdoptionCategory.addEventListener("change", filterIntentAdoptionCandidates)
elements.intentAdoptionSelectClear.addEventListener(
  "click",
  selectClearIntentAdoptionCandidates,
)
elements.intentAdoptionClear.addEventListener("click", clearIntentAdoptionSelection)
elements.intentAdoptionSave.addEventListener("click", saveIntentAdoption)
elements.intentAdoptionDialog.addEventListener("close", () => {
  state.intentAdoptionDraft = null
})
elements.coverageIntentReason.addEventListener("input", () => {
  clearFieldError(
    elements.coverageIntentReason,
    elements.coverageIntentError,
  )
})
elements.coverageIntentForm.addEventListener("submit", saveCoverageIntent)
elements.coverageIntentDialog.addEventListener("close", () => {
  state.coverageIntentDraft = null
})
elements.intentAddGroup.addEventListener("click", () => openIntentGroupEditor())
elements.intentGroupMembers.addEventListener("change", updateIntentGroupSelectionSummary)
elements.intentGroupSelectAll.addEventListener("click", () => {
  for (const checkbox of elements.intentGroupMembers.querySelectorAll("input")) {
    checkbox.checked = true
  }
  updateIntentGroupSelectionSummary()
})
elements.intentGroupClear.addEventListener("click", () => {
  for (const checkbox of elements.intentGroupMembers.querySelectorAll("input")) {
    checkbox.checked = false
  }
  updateIntentGroupSelectionSummary()
})
elements.intentGroupName.addEventListener("input", () => {
  clearFieldError(elements.intentGroupName, elements.intentGroupError)
})
elements.intentGroupForm.addEventListener("submit", saveIntentGroup)
elements.intentGroupDialog.addEventListener("close", () => {
  state.intentGroupDraft = null
})
elements.intentPolicyAddGroup.addEventListener("click", () => {
  openIntentGroupEditor(null, { returnToPolicy: true })
})
elements.intentPolicyGroup.addEventListener("change", changeIntentPolicyGroup)
elements.intentPolicyModeObserved.addEventListener("change", changeIntentPolicyValueMode)
elements.intentPolicyModeCustom.addEventListener("change", changeIntentPolicyValueMode)
elements.intentPolicyPresenceRequired.addEventListener("change", changeIntentPolicyPresenceConstraint)
elements.intentPolicyPresenceOptional.addEventListener("change", changeIntentPolicyPresenceConstraint)
elements.intentPolicyPresenceForbidden.addEventListener("change", changeIntentPolicyPresenceConstraint)
elements.intentPolicyConstraintExact.addEventListener("change", changeIntentPolicyValueConstraint)
elements.intentPolicyConstraintMayDiffer.addEventListener("change", changeIntentPolicyValueConstraint)
elements.intentPolicyConstraintMustDiffer.addEventListener("change", changeIntentPolicyValueConstraint)
elements.intentPolicyValues.addEventListener("change", (event) => {
  if (event.target.matches('input[name="intent-policy-value"]')) {
    changeObservedIntentPolicyValue()
  }
})
elements.intentPolicyCustomKind.addEventListener("change", changeIntentPolicyCustomKind)
elements.intentPolicyCustomRaw.addEventListener("input", syncIntentPolicyCustomFromJson)
elements.intentPolicyCustomFields.addEventListener("input", updateIntentPolicyCustomControl)
elements.intentPolicyCustomFields.addEventListener("change", changeIntentPolicyCustomNullType)
elements.intentPolicyCustomFields.addEventListener("change", renameIntentPolicyCustomObjectKey)
elements.intentPolicyCustomFields.addEventListener("click", handleIntentPolicyCustomAction)
elements.intentPolicyForm.addEventListener("submit", saveIntentPolicy)
elements.intentPolicyDialog.addEventListener("close", () => {
  state.intentPolicyDraft = null
})
elements.intentAcknowledgementReason.addEventListener("input", () => {
  clearFieldError(
    elements.intentAcknowledgementReason,
    elements.intentAcknowledgementError,
  )
})
elements.intentAcknowledgementForm.addEventListener(
  "submit",
  saveIntentAcknowledgement,
)
elements.intentAcknowledgementDialog.addEventListener("close", () => {
  state.intentAcknowledgementDraft = null
})
elements.intentDeleteForm.addEventListener("submit", applyIntentRemoval)
elements.intentDeleteDialog.addEventListener("close", () => {
  state.intentDeleteDraft = null
})
elements.emailPolicyExceptions.addEventListener("click", openPolicyExceptionDialog)
window.addEventListener("focus", () => {
  syncFleetIntent({ silent: true })
  if (elements.activityDialog.open) loadOperationActivity({ silent: true })
})
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return
  syncFleetIntent({ silent: true })
  if (elements.activityDialog.open) loadOperationActivity({ silent: true })
})
setInterval(() => {
  if (document.visibilityState === "visible") syncFleetIntent({ silent: true })
}, INTENT_SYNC_INTERVAL_MS)
document.addEventListener("click", closeMatrixGuideOnOutsideClick)
document.addEventListener("click", followSkipLink)
document.addEventListener("keydown", handleGlobalShortcut)

syncResponsiveFilterPanel()
initialize()
