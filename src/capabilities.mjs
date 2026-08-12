export const MATRIX_CAPABILITY = Object.freeze({
  COMPARE: "compare",
  COMPARE_ONLY: "compare-only",
  COPY_FILL: "copy-fill",
  DIRECT_EDIT: "direct-edit",
  EXPECTED_STATE: "expected-state",
  FLEET_RENAME: "fleet-rename",
  INTENT_FIX: "intent-fix",
  WORKSPACE_EDIT: "workspace-edit",
})

const CHANGE_CAPABILITIES = new Set([
  MATRIX_CAPABILITY.COPY_FILL,
  MATRIX_CAPABILITY.DIRECT_EDIT,
  MATRIX_CAPABILITY.FLEET_RENAME,
  MATRIX_CAPABILITY.INTENT_FIX,
  MATRIX_CAPABILITY.WORKSPACE_EDIT,
])

const EDITABLE_RULESET_KINDS = new Set([
  "custom",
  "zone",
])

const DNSSEC_CATEGORY = "DNSSEC"
const DNSSEC_CONFIGURATION_KEY = "configuration"

export const MATRIX_CAPABILITY_PRESENTATION = Object.freeze({
  [MATRIX_CAPABILITY.COMPARE]: Object.freeze({
    kind: "observe",
    label: "Compare",
  }),
  [MATRIX_CAPABILITY.EXPECTED_STATE]: Object.freeze({
    kind: "plan",
    label: "Set expected state",
  }),
  [MATRIX_CAPABILITY.DIRECT_EDIT]: Object.freeze({
    kind: "change",
    label: "Direct edit",
  }),
  [MATRIX_CAPABILITY.WORKSPACE_EDIT]: Object.freeze({
    kind: "change",
    label: "Editable workspace",
  }),
  [MATRIX_CAPABILITY.COPY_FILL]: Object.freeze({
    kind: "change",
    label: "Copy/fill",
  }),
  [MATRIX_CAPABILITY.FLEET_RENAME]: Object.freeze({
    kind: "change",
    label: "Fleet rename",
  }),
  [MATRIX_CAPABILITY.INTENT_FIX]: Object.freeze({
    kind: "change",
    label: "Intent-driven fix",
  }),
  [MATRIX_CAPABILITY.COMPARE_ONLY]: Object.freeze({
    kind: "limit",
    label: "No Cloudflare changes",
  }),
})

function rowCells(row) {
  return row?.cells instanceof Map ? [...row.cells.values()] : []
}

function actionHasEditableWorkspace(action) {
  return Boolean(action && EDITABLE_RULESET_KINDS.has(action.kind))
}

function rowHasEditableWorkspace(row) {
  return rowCells(row).some(
    (cell) => actionHasEditableWorkspace(cell.parentAction),
  )
}

function rowHasCopyOrFill(row) {
  if (rowCells(row).some((cell) => Boolean(cell.secondaryAction))) return true
  if (!(row?.missingResolutions instanceof Map)) return false
  return [...row.missingResolutions.values()].some(
    (resolution) => Boolean(resolution?.available),
  )
}

function rowHasIntentFix(row) {
  return row?.category === DNSSEC_CATEGORY
    && row?.key === DNSSEC_CONFIGURATION_KEY
}

export function matrixRowCapabilities(row) {
  const capabilities = new Set([
    MATRIX_CAPABILITY.COMPARE,
    MATRIX_CAPABILITY.EXPECTED_STATE,
  ])
  if (rowCells(row).some((cell) => Boolean(cell.action))) {
    capabilities.add(MATRIX_CAPABILITY.DIRECT_EDIT)
  }
  if (rowHasEditableWorkspace(row)) {
    capabilities.add(MATRIX_CAPABILITY.WORKSPACE_EDIT)
  }
  if (rowHasCopyOrFill(row)) {
    capabilities.add(MATRIX_CAPABILITY.COPY_FILL)
  }
  if (row?.fleetAction) {
    capabilities.add(MATRIX_CAPABILITY.FLEET_RENAME)
  }
  if (rowHasIntentFix(row)) {
    capabilities.add(MATRIX_CAPABILITY.INTENT_FIX)
  }
  if (![...capabilities].some((capability) => CHANGE_CAPABILITIES.has(capability))) {
    capabilities.add(MATRIX_CAPABILITY.COMPARE_ONLY)
  }
  return [...capabilities]
}

export function matrixRowSupportsChanges(row) {
  return matrixRowCapabilities(row).some(
    (capability) => CHANGE_CAPABILITIES.has(capability),
  )
}

export function matrixCategoryCapabilities(matrix) {
  return (matrix?.categories || []).map((category) => {
    const rows = matrix.rows.filter((row) => row.category === category)
    const capabilities = new Set()
    for (const row of rows) {
      for (const capability of matrixRowCapabilities(row)) {
        capabilities.add(capability)
      }
    }
    const changeableRows = rows.filter(matrixRowSupportsChanges).length
    if (changeableRows > 0) capabilities.delete(MATRIX_CAPABILITY.COMPARE_ONLY)
    return {
      capabilities: [...capabilities],
      category,
      changeableRows,
      rows: rows.length,
    }
  })
}

export function matrixCapabilityCounts(matrix) {
  const categories = matrixCategoryCapabilities(matrix)
  const changeableRows = (matrix?.rows || []).filter(matrixRowSupportsChanges).length
  return {
    categories: categories.length,
    changeableCategories: categories.filter((entry) => entry.changeableRows > 0).length,
    changeableRows,
    compareOnlyCategories: categories.filter((entry) => entry.changeableRows === 0).length,
    rows: matrix?.rows?.length || 0,
  }
}
