import assert from "node:assert/strict"
import test from "node:test"

import {
  MATRIX_CATEGORY,
  matrixCategoryLabel,
} from "../src/constants.mjs"

test("legacy firewall facets are presented as a priority projection", () => {
  assert.equal(MATRIX_CATEGORY.LEGACY_FIREWALL_VIEW, "Legacy firewall view")
  assert.equal(
    matrixCategoryLabel(MATRIX_CATEGORY.LEGACY_FIREWALL_VIEW),
    "Legacy firewall priority projection",
  )
  assert.equal(
    matrixCategoryLabel(MATRIX_CATEGORY.RULESET_RULES),
    MATRIX_CATEGORY.RULESET_RULES,
  )
})
