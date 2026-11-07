import assert from "node:assert/strict"
import test from "node:test"
import { createDemoFleet, DEMO_ZONE } from "./demo-fleet.mjs"
import { buildMatrix } from "../src/matrix.mjs"
import { evaluateFleetIntent, isFleetIntentDocument } from "../src/fleet-intent.mjs"
import { buildReviewQueues } from "../src/review-queues.mjs"

const FIXED_TIME = "2026-08-12T12:00:00.000Z"

test("demo models a varied synthetic Free fleet with layered saved intent", () => {
  const { inventory, intent } = createDemoFleet({ loadedAt: FIXED_TIME })
  assert.equal(isFleetIntentDocument(intent, inventory.account.id), true)
  assert.ok(inventory.zones.length >= 16)
  assert.ok(intent.policies.length >= 100)
  assert.ok(intent.groups.length >= 17)
  assert.ok(inventory.zones.every((zone) => zone.meta.plan.name === "Free Website"))
  assert.ok(inventory.zones.every((zone) => zone.meta.name.endsWith(".example")))
  assert.ok(inventory.zones.every((zone) => zone.surfaces.settings.result.length >= 50))
  const matrix = buildMatrix(inventory)
  assert.ok(new Set(matrix.rows.map((row) => row.category)).size >= 10)
  const types = new Set(inventory.zones.flatMap((zone) => zone.surfaces.dns.result.map((record) => record.type)))
  for (const type of ["A", "AAAA", "CNAME", "MX", "TXT", "CAA"]) assert.ok(types.has(type))
  const cacheRules = inventory.zones.flatMap((zone) => zone.ruleDetails.filter((detail) => detail.result.phase === "http_request_cache_settings").flatMap((detail) => detail.result.rules))
  assert.ok(cacheRules.length > 0)
  assert.ok(cacheRules.every((rule) => rule.action_parameters.edge_ttl.default >= 7200))
  assert.ok(intent.policies.some((policy) => policy.presenceConstraint === "optional"))
  assert.ok(intent.policies.some((policy) => policy.presenceConstraint === "forbidden"))
})

test("demo starts with actionable work, intentional exceptions and honest unknowns", () => {
  const { inventory, intent } = createDemoFleet({ loadedAt: FIXED_TIME })
  const matrix = buildMatrix(inventory)
  const evaluation = evaluateFleetIntent(intent, inventory, matrix)
  const queues = buildReviewQueues({ inventory, intent, matrix, evaluation })
  assert.ok(queues.misalignments.length > 5)
  assert.ok(queues.decisions.length > 5)
  assert.ok(queues.reads.length >= 2)
  assert.ok(queues.summary.expectedReadGaps > 0)
  assert.ok(queues.summary.acknowledgedCells > 0)
  assert.equal(queues.summary.complete, false)
  const https = queues.misalignments.find((item) => item.facet.key === "always_use_https")
  assert.ok(https.observed.some((entry) => entry.zoneName === DEMO_ZONE.DRIFT))
  assert.ok(!https.observed.some((entry) => entry.zoneName === DEMO_ZONE.EXCEPTION))
})

test("demo generation is repeatable and does not share mutable records", () => {
  const first = createDemoFleet({ loadedAt: FIXED_TIME })
  const second = createDemoFleet({ loadedAt: FIXED_TIME })
  assert.deepEqual(first, second)
  first.inventory.zones[0].surfaces.settings.result[0].value = "changed"
  assert.notDeepEqual(first.inventory, second.inventory)
})
