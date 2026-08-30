import assert from "node:assert/strict"
import test from "node:test"

import { z } from "zod"

import { createEmptyFleetIntentDocument } from "../src/fleet-intent.mjs"
import {
  fleetChangeSchema,
  fleetIntentDocumentSchema,
  runtimeStatusInputSchema,
  runtimeStatusOutputSchema,
} from "../src/interface-schemas.mjs"

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
  const intentSchema = JSON.stringify(z.toJSONSchema(fleetIntentDocumentSchema))

  assert.match(changeSchema, /zone-setting-update/)
  assert.doesNotMatch(changeSchema, /"method"|"path"/)
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
