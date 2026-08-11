import assert from "node:assert/strict"
import test from "node:test"

import {
  DEFAULT_VIEW_STATE,
  decodeViewState,
  encodeViewState,
  VIEW_PANEL,
} from "../src/url-state.mjs"
import { INTENT_WORKFLOW_SCREEN } from "../src/intent-workflow.mjs"
import {
  MATRIX_INTENT_FILTER,
  MATRIX_SCOPE,
  MATRIX_SORT,
} from "../src/matrix-filter.mjs"
import { TXT_RECORD_PURPOSE } from "../src/dns-record-purpose.mjs"

test("a default view encodes to an empty query string", () => {
  assert.equal(encodeViewState(DEFAULT_VIEW_STATE), "")
})

test("only non-default fields are written, differences-only as an off switch", () => {
  const encoded = encodeViewState({
    ...DEFAULT_VIEW_STATE,
    query: "waf test",
    scope: "all",
    intentStatus: MATRIX_INTENT_FILTER.MATCH,
    changeableOnly: true,
    differencesOnly: false,
  })
  const params = new URLSearchParams(encoded)
  assert.equal(params.get("q"), "waf test")
  assert.equal(params.get("scope"), "all")
  assert.equal(params.get("intent"), "match")
  assert.equal(params.get("changeable"), "1")
  assert.equal(params.get("review"), "0")
  assert.equal(params.get("phase"), null)
  assert.equal(params.get("sort"), null)
})

test("encoding is canonical regardless of zone selection order", () => {
  const a = encodeViewState({ ...DEFAULT_VIEW_STATE, query: "x", selectedZoneIds: ["z2", "z1"] })
  const b = encodeViewState({ ...DEFAULT_VIEW_STATE, query: "x", selectedZoneIds: ["z1", "z2"] })
  assert.equal(a, b)
  assert.match(a, /zones=z1%2Cz2/)
})

test("round-trips representative states", () => {
  const states = [
    DEFAULT_VIEW_STATE,
    { ...DEFAULT_VIEW_STATE, query: "email dmarc", category: "DNS records" },
    { ...DEFAULT_VIEW_STATE, selectedZoneIds: ["zone-a", "zone-b"], selectedColumnsOnly: true },
    { ...DEFAULT_VIEW_STATE, scope: "zone-specific", sort: "category", recordType: "TXT", txtPurpose: TXT_RECORD_PURPOSE.SPF, intentStatus: MATRIX_INTENT_FILTER.DRIFT, differencesOnly: false, changeableOnly: true, targetHolesOnly: true },
    { ...DEFAULT_VIEW_STATE, panel: VIEW_PANEL.INTENT, intentScreen: INTENT_WORKFLOW_SCREEN.POLICY },
  ]
  for (const state of states) {
    assert.deepEqual(decodeViewState(encodeViewState(state)), state)
  }
})

test("decode is defensive: unknown keys, garbage, empty, and leading question mark", () => {
  assert.deepEqual(decodeViewState(""), DEFAULT_VIEW_STATE)
  assert.deepEqual(decodeViewState("?"), DEFAULT_VIEW_STATE)
  assert.deepEqual(decodeViewState("unknown=1&other=x"), DEFAULT_VIEW_STATE)
  const decoded = decodeViewState("?q=hi&mystery=42&changeable=maybe&cols=1")
  assert.equal(decoded.query, "hi")
  assert.equal(decoded.selectedColumnsOnly, true)
  // any truthy string for a boolean param reads as true
  assert.equal(decoded.changeableOnly, true)
})

test("boolean params are true only for the value 1", () => {
  assert.equal(decodeViewState("changeable=0").changeableOnly, false)
  assert.equal(decodeViewState("review=0").differencesOnly, false)
  assert.equal(decodeViewState("").differencesOnly, true)
})

test("zone lists parse empty, single, and many", () => {
  assert.deepEqual(decodeViewState("").selectedZoneIds, [])
  assert.deepEqual(decodeViewState("zones=only").selectedZoneIds, ["only"])
  assert.deepEqual(decodeViewState("zones=a,b,c").selectedZoneIds, ["a", "b", "c"])
})

test("duplicate keys take the first value", () => {
  assert.equal(decodeViewState("scope=all&scope=zone-specific").scope, "all")
})

test("returns a fresh object each call so callers cannot mutate the default", () => {
  const first = decodeViewState("")
  first.selectedZoneIds.push("x")
  assert.deepEqual(decodeViewState("").selectedZoneIds, [])
})

test("an unrecognized enum filter or sort falls back to the default", () => {
  // these selects have no empty option, so a blank value would hide the whole matrix
  assert.equal(decodeViewState("scope=bogus").scope, DEFAULT_VIEW_STATE.scope)
  assert.equal(decodeViewState("sort=bogus").sort, DEFAULT_VIEW_STATE.sort)
  assert.equal(decodeViewState("txt=bogus").txtPurpose, DEFAULT_VIEW_STATE.txtPurpose)
  assert.equal(
    decodeViewState("intent=bogus").intentStatus,
    DEFAULT_VIEW_STATE.intentStatus,
  )
  assert.equal(decodeViewState("panel=bogus").panel, VIEW_PANEL.NONE)
  assert.equal(
    decodeViewState("panel=intent&screen=bogus").intentScreen,
    INTENT_WORKFLOW_SCREEN.MANAGER,
  )
})

test("every valid scope, intent filter, and sort value round-trips through decode", () => {
  for (const value of Object.values(MATRIX_SCOPE)) {
    assert.equal(decodeViewState("scope=" + value).scope, value)
  }
  for (const value of Object.values(MATRIX_SORT)) {
    assert.equal(decodeViewState("sort=" + value).sort, value)
  }
  for (const value of Object.values(MATRIX_INTENT_FILTER)) {
    assert.equal(decodeViewState("intent=" + value).intentStatus, value)
  }
  for (const value of Object.values(TXT_RECORD_PURPOSE)) {
    assert.equal(decodeViewState("txt=" + value).txtPurpose, value)
  }
})

test("free-form string filters pass through verbatim", () => {
  assert.equal(decodeViewState("category=NoSuchCat").category, "NoSuchCat")
})

test("intent workflow routes use a canonical manager default", () => {
  assert.equal(
    encodeViewState({
      ...DEFAULT_VIEW_STATE,
      panel: VIEW_PANEL.INTENT,
    }),
    "panel=intent",
  )
  assert.equal(
    encodeViewState({
      ...DEFAULT_VIEW_STATE,
      panel: VIEW_PANEL.INTENT,
      intentScreen: INTENT_WORKFLOW_SCREEN.ADOPTION,
    }),
    "panel=intent&screen=adoption",
  )
  assert.equal(
    decodeViewState("screen=policy").intentScreen,
    INTENT_WORKFLOW_SCREEN.MANAGER,
  )
  assert.equal(
    encodeViewState({
      ...DEFAULT_VIEW_STATE,
      intentScreen: INTENT_WORKFLOW_SCREEN.POLICY,
    }),
    "",
  )
})
