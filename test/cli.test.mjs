import assert from "node:assert/strict"
import test from "node:test"

import {
  FLEET_CLI_EXIT_CODE,
  fleetUsage,
  parseFleetArguments,
  runFleetCli,
  runFleetCommand,
} from "../src/cli.mjs"
import { AlignmentPlanChangedError } from "../src/write-executor.mjs"

function outputStream() {
  let output = ""
  return {
    stream: {
      write(value) {
        output += value
      },
    },
    value() {
      return output
    },
  }
}

test("unified CLI parses policy, row, and cell alignment selectors", () => {
  assert.deepEqual(
    parseFleetArguments(["alignment", "plan", "--policy", "policy-one"]),
    {
      command: "alignment-plan",
      expectedDigest: null,
      format: "text",
      selector: { kind: "policy", policyId: "policy-one" },
      stateFile: null,
    },
  )
  assert.deepEqual(
    parseFleetArguments([
      "alignment",
      "plan",
      "--category=settings",
      "--key",
      "always_use_https",
    ]).selector,
    {
      category: "settings",
      key: "always_use_https",
      kind: "row",
      phase: "",
      zoneIds: null,
    },
  )
  assert.deepEqual(
    parseFleetArguments([
      "alignment",
      "apply",
      "--category",
      "settings",
      "--key",
      "always_use_https",
      "--zone-id",
      "zone-one",
      "--zone-id=zone-two",
      "--expect-plan",
      "sha256:approved",
    ]).selector.zoneIds,
    ["zone-one", "zone-two"],
  )
})

test("unified CLI rejects missing approval digests and conflicting selectors", () => {
  assert.throws(
    () => parseFleetArguments([
      "alignment",
      "apply",
      "--policy",
      "policy-one",
    ]),
    /requires --expect-plan/,
  )
  assert.throws(
    () => parseFleetArguments([
      "alignment",
      "plan",
      "--policy",
      "policy-one",
      "--category",
      "settings",
      "--key",
      "always_use_https",
    ]),
    /cannot include facet or zone fields/,
  )
})

test("unified CLI writes one structured JSON document and keeps progress on stderr", async () => {
  const stdout = outputStream()
  const stderr = outputStream()
  const exits = []
  const result = {
    accountId: "account-one",
    candidates: [],
    schemaVersion: 1,
    status: "ok",
    summary: {
      availableCandidates: 0,
      blockedCandidates: 0,
      candidates: 0,
      zones: 1,
    },
  }

  await runFleetCommand({
    argv: ["alignment", "list", "--format", "json"],
    onExitCode: (code) => exits.push(code),
    service: {
      async listAlignments(options) {
        options.onProgress({ message: "Reading live inventory" })
        return result
      },
    },
    stderr: stderr.stream,
    stdout: stdout.stream,
  })

  assert.deepEqual(JSON.parse(stdout.value()), result)
  assert.match(stderr.value(), /Reading live inventory/)
  assert.deepEqual(exits, [FLEET_CLI_EXIT_CODE.SUCCESS])
})

test("unified CLI reports blocked alignment with its named exit", async () => {
  const stdout = outputStream()
  const exits = []
  await runFleetCommand({
    argv: ["alignment", "apply", "--policy", "policy-one", "--expect-plan", "sha256:approved"],
    onExitCode: (code) => exits.push(code),
    service: {
      async applyAlignment() {
        return {
          accountId: "account-one",
          applied: false,
          facet: { label: "Always Use HTTPS" },
          planSet: null,
          reason: "Unsupported target",
          schemaVersion: 1,
          selector: { kind: "policy", policyId: "policy-one" },
          status: "blocked",
        }
      },
    },
    stderr: outputStream().stream,
    stdout: stdout.stream,
  })

  assert.match(stdout.value(), /Alignment blocked/)
  assert.deepEqual(exits, [FLEET_CLI_EXIT_CODE.BLOCKED])
})

test("unified CLI returns a structured plan-changed error without leaking credentials", async () => {
  const stdout = outputStream()
  const stderr = outputStream()
  const exits = []
  const secret = "secret-token-value"

  await runFleetCli({
    argv: [
      "alignment",
      "apply",
      "--policy",
      "policy-one",
      "--expect-plan",
      "sha256:reviewed",
      "--format=json",
    ],
    environment: {
      CLOUDFLARE_ACCOUNT_ID: "account-one",
      CLOUDFLARE_API_TOKEN: secret,
    },
    onExitCode: (code) => exits.push(code),
    service: {
      async applyAlignment() {
        throw new AlignmentPlanChangedError(
          "sha256:reviewed",
          "sha256:fresh",
        )
      },
    },
    stderr: stderr.stream,
    stdout: stdout.stream,
  })

  const result = JSON.parse(stdout.value())
  assert.equal(result.status, "plan-changed")
  assert.equal(result.error.expectedDigest, "sha256:reviewed")
  assert.equal(result.error.actualDigest, "sha256:fresh")
  assert.doesNotMatch(stdout.value(), new RegExp(secret))
  assert.equal(stderr.value(), "")
  assert.deepEqual(exits, [FLEET_CLI_EXIT_CODE.PLAN_CHANGED])
})

test("unified CLI preserves the existing audit help entry", async () => {
  const stdout = outputStream()
  await runFleetCommand({
    argv: ["audit", "--help"],
    stderr: outputStream().stream,
    stdout: stdout.stream,
  })

  assert.match(stdout.value(), /cloudflare-fleet-audit/)
  assert.match(stdout.value(), /without writing/)
})

test("unified CLI help documents the bounded agent surface", () => {
  const usage = fleetUsage()
  assert.match(usage, /alignment apply/)
  assert.match(usage, /--expect-plan DIGEST/)
  assert.match(usage, /activity list/)
  assert.match(usage, /cloudflare-fleet mcp/)
})

test("unified CLI parses MCP state and policy profiles", () => {
  assert.deepEqual(
    parseFleetArguments([
      "mcp",
      "--state-file",
      "profiles/state.json",
      "--policy-file=profiles/policy.json",
    ]),
    {
      command: "mcp",
      policyFile: "profiles/policy.json",
      stateFile: "profiles/state.json",
    },
  )
})

test("unified CLI keeps command-scoped short options equivalent", () => {
  const cases = [
    [
      ["alignment", "list", "-f", "json", "-s", "profiles/state.json"],
      ["alignment", "list", "--format", "json", "--state-file", "profiles/state.json"],
    ],
    [
      ["alignment", "plan", "-p", "policy-one"],
      ["alignment", "plan", "--policy", "policy-one"],
    ],
    [
      ["alignment", "plan", "-c", "settings", "-k", "always_use_https", "-z", "zone-one"],
      ["alignment", "plan", "--category", "settings", "--key", "always_use_https", "--zone-id", "zone-one"],
    ],
    [
      ["alignment", "apply", "-p", "policy-one", "-e", "sha256:approved"],
      ["alignment", "apply", "--policy", "policy-one", "--expect-plan", "sha256:approved"],
    ],
    [
      ["mcp", "-p", "profiles/policy.json", "-s", "profiles/state.json"],
      ["mcp", "--policy-file", "profiles/policy.json", "--state-file", "profiles/state.json"],
    ],
  ]

  for (const [shortArguments, longArguments] of cases) {
    assert.deepEqual(
      parseFleetArguments(shortArguments),
      parseFleetArguments(longArguments),
    )
  }
  assert.throws(
    () => parseFleetArguments(["alignment", "plan", "-P", "policy-one"]),
    /Unknown option: -P/,
  )
})
