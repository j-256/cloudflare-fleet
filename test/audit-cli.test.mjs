import assert from "node:assert/strict"
import test from "node:test"

import {
  fleetAuditUsage,
  parseFleetAuditArguments,
} from "../src/audit.mjs"

test("fleet audit arguments default to a core markdown report", () => {
  assert.deepEqual(parseFleetAuditArguments([]), {
    deep: false,
    format: "markdown",
    help: false,
    stateFile: null,
  })
})

test("fleet audit arguments accept deep JSON output and an explicit state file", () => {
  assert.deepEqual(parseFleetAuditArguments([
    "--deep",
    "--format=json",
    "--state-file",
    "/tmp/fleet-state.json",
  ]), {
    deep: true,
    format: "json",
    help: false,
    stateFile: "/tmp/fleet-state.json",
  })
})

test("fleet audit arguments reject unsupported formats and unknown options", () => {
  assert.throws(
    () => parseFleetAuditArguments(["--format", "yaml"]),
    /Unsupported audit format/,
  )
  assert.throws(
    () => parseFleetAuditArguments(["--mutate"]),
    /Unknown option/,
  )
})

test("fleet audit usage labels the command as read-only", () => {
  assert.match(fleetAuditUsage(), /without writing/)
  assert.match(fleetAuditUsage(), /--deep/)
})
