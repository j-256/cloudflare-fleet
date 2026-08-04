import assert from "node:assert/strict"
import test from "node:test"

import {
  MATRIX_CAPABILITY,
  matrixCapabilityCounts,
  matrixCategoryCapabilities,
  matrixRowCapabilities,
  matrixRowSupportsChanges,
} from "../src/capabilities.mjs"

function row(options = {}) {
  return {
    category: options.category || "TLS",
    cells: new Map(options.cells || []),
    fleetAction: options.fleetAction || null,
    key: options.key || "example",
    missingResolutions: new Map(options.missingResolutions || []),
  }
}

test("comparison-only rows separate expected state from Cloudflare changes", () => {
  const capabilities = matrixRowCapabilities(row())

  assert.deepEqual(capabilities, [
    MATRIX_CAPABILITY.COMPARE,
    MATRIX_CAPABILITY.EXPECTED_STATE,
    MATRIX_CAPABILITY.COMPARE_ONLY,
  ])
  assert.equal(matrixRowSupportsChanges(row()), false)
})

test("row capabilities detect direct, workspace, copy, and fleet adapters", () => {
  const editable = row({
    cells: [
      ["zone-a", {
        action: { type: "zone-setting" },
        secondaryAction: { type: "ruleset-rule-copy" },
        workspaceAction: { kind: "zone" },
      }],
    ],
    fleetAction: { type: "ruleset-rule-rename" },
  })

  assert.deepEqual(matrixRowCapabilities(editable), [
    MATRIX_CAPABILITY.COMPARE,
    MATRIX_CAPABILITY.EXPECTED_STATE,
    MATRIX_CAPABILITY.DIRECT_EDIT,
    MATRIX_CAPABILITY.WORKSPACE_EDIT,
    MATRIX_CAPABILITY.COPY_FILL,
    MATRIX_CAPABILITY.FLEET_RENAME,
  ])
  assert.equal(matrixRowSupportsChanges(editable), true)
})

test("managed ruleset workspaces remain inspection-only", () => {
  const managed = row({
    cells: [
      ["zone-a", {
        workspaceAction: { kind: "managed" },
      }],
    ],
  })

  assert.equal(
    matrixRowCapabilities(managed).includes(MATRIX_CAPABILITY.WORKSPACE_EDIT),
    false,
  )
  assert.equal(matrixRowSupportsChanges(managed), false)
})

test("DNSSEC configuration advertises its intent-driven status adapter", () => {
  const dnssec = row({
    category: "DNSSEC",
    key: "configuration",
  })

  assert.equal(
    matrixRowCapabilities(dnssec).includes(MATRIX_CAPABILITY.INTENT_FIX),
    true,
  )
  assert.equal(matrixRowSupportsChanges(dnssec), true)
})

test("category capability summaries count change support without hiding comparison", () => {
  const matrix = {
    categories: ["TLS", "DNS records"],
    rows: [
      row({ category: "TLS", key: "ssl" }),
      row({
        category: "DNS records",
        key: "A @",
        missingResolutions: [
          ["zone-b", { available: true }],
        ],
      }),
      row({ category: "DNS records", key: "unsupported" }),
    ],
  }

  assert.deepEqual(matrixCategoryCapabilities(matrix).map((entry) => ({
    category: entry.category,
    changeableRows: entry.changeableRows,
    rows: entry.rows,
  })), [
    { category: "TLS", changeableRows: 0, rows: 1 },
    { category: "DNS records", changeableRows: 1, rows: 2 },
  ])
  assert.deepEqual(matrixCapabilityCounts(matrix), {
    categories: 2,
    changeableCategories: 1,
    changeableRows: 1,
    compareOnlyCategories: 1,
    rows: 3,
  })
})
