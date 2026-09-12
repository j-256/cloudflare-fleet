import assert from "node:assert/strict"
import test from "node:test"

import { z } from "zod"

import { createEmptyFleetIntentDocument } from "../src/fleet-intent.mjs"
import { workerFixture } from "./worker.fixture.mjs"
import {
  fleetChangeSchema,
  fleetChangesSchema,
  fleetIntentDocumentSchema,
  runtimeStatusInputSchema,
  runtimeStatusOutputSchema,
  workerInspectionSchema,
  workerReportOutputSchema,
} from "../src/interface-schemas.mjs"

test("Worker inspection schemas require an explicit supported selector and describe partial handler evidence", () => {
  const findingId = "deep.worker-trigger-coverage-unknown:example-worker"
  for (const input of [{}, { logs: false }, { worker_name: "example-worker" }, { worker: "" }, { findingId: "unrelated" }, { findingId: "" }]) {
    assert.equal(workerInspectionSchema.safeParse(input).success, false, JSON.stringify(input))
  }
  for (const input of [{ worker: "example-worker" }, { findingId }, { worker: "example-worker", findingId }]) {
    const parsed = workerInspectionSchema.parse(input)
    assert.equal(parsed.logs, true)
    assert.equal(parsed.limit, 50)
  }
  const schema = z.toJSONSchema(workerInspectionSchema, { io: "input" })
  assert.deepEqual(schema.anyOf.map((branch) => branch.required), [["worker"], ["findingId"]])
  const output = JSON.stringify(z.toJSONSchema(workerReportOutputSchema))
  assert.match(output, /handlerEvidence/)
  assert.match(output, /assets-only-metadata/)
  assert.match(output, /handlers-missing/)
  assert.match(output, /reasonCode/)
})

test("Worker output schemas still accept reports saved before independent handler evidence", async () => {
  const fixture = workerFixture()
  const report = await fixture.service.inspect({ worker: "example-worker", logs: false })
  delete report.versions[0].value.handlerEvidence
  assert.equal(workerReportOutputSchema.safeParse(report).success, true)
  report.versions[0] = { id: "version-serving", percentage: 100, status: "unknown", value: null, reason: "Read failed or returned unsupported metadata", httpStatus: null }
  assert.equal(workerReportOutputSchema.safeParse(report).success, true)
})

test("public fleet intent schema accepts current documents and rejects skeletal collections", () => {
  const document = createEmptyFleetIntentDocument("account-one")
  assert.equal(fleetIntentDocumentSchema.safeParse(document).success, true)

  const invalid = {
    ...structuredClone(document),
    groups: [{ id: "all-zones" }],
  }
  assert.equal(fleetIntentDocumentSchema.safeParse(invalid).success, false)
})

test("public JSON schemas describe bounded requests and complete intent entries", () => {
  const changeSchema = JSON.stringify(z.toJSONSchema(fleetChangeSchema))
  const changesSchema = JSON.stringify(z.toJSONSchema(fleetChangesSchema))
  const intentSchema = JSON.stringify(z.toJSONSchema(fleetIntentDocumentSchema))

  assert.match(changeSchema, /zone-setting-update/)
  assert.doesNotMatch(changeSchema, /"method"|"path"/)
  assert.match(changesSchema, /ruleset-rule-update/)
  assert.doesNotMatch(changesSchema, /worker-schedules-update/)
  assert.doesNotMatch(changesSchema, /"method"|"path"/)
  assert.match(intentSchema, /nameSource/)
  assert.match(intentSchema, /presenceConstraint/)
  assert.match(intentSchema, /observedCanonical/)
})

test("runtime status schemas expose bounded diagnostics without credential values", () => {
  const inputSchema = JSON.stringify(z.toJSONSchema(runtimeStatusInputSchema))
  const outputSchema = JSON.stringify(z.toJSONSchema(runtimeStatusOutputSchema))

  assert.match(inputSchema, /"live"/)
  assert.match(outputSchema, /"checks"/)
  assert.match(outputSchema, /"remedy"/)
  assert.match(outputSchema, /"present"/)
  assert.doesNotMatch(outputSchema, /apiTokenValue|accountIdValue/)
})
