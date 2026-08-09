import assert from "node:assert/strict"
import test from "node:test"

import {
  DEFAULT_VIEW_STATE,
  decodeViewState,
  encodeViewState,
} from "../src/url-state.mjs"

test("a default view encodes to an empty query string", () => {
  assert.equal(encodeViewState(DEFAULT_VIEW_STATE), "")
})

test("only non-default fields are written, differences-only as an off switch", () => {
  const encoded = encodeViewState({
    ...DEFAULT_VIEW_STATE,
    query: "waf test",
    scope: "all",
    changeableOnly: true,
    differencesOnly: false,
  })
  const params = new URLSearchParams(encoded)
  assert.equal(params.get("q"), "waf test")
  assert.equal(params.get("scope"), "all")
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
    { ...DEFAULT_VIEW_STATE, scope: "zone-specific", sort: "category", recordType: "TXT", differencesOnly: false, changeableOnly: true, targetHolesOnly: true },
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
