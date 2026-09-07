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

test("unified CLI redacts credentials from runtime diagnostics", async () => {
  const stdout = outputStream()
  const secret = "secret-token-value"
  await runFleetCli({
    argv: ["activity", "list", "--format=json"],
    environment: {
      CLOUDFLARE_ACCOUNT_ID: "account-one",
      CLOUDFLARE_API_TOKEN: secret,
    },
    service: {
      async listActivity() {
        throw new Error(`Request failed with ${secret}`)
      },
    },
    stderr: outputStream().stream,
    stdout: stdout.stream,
  })

  assert.match(stdout.value(), /\[redacted\]/)
  assert.doesNotMatch(stdout.value(), new RegExp(secret))
})

test("unified CLI preserves the existing audit help entry", async () => {
  const stdout = outputStream()
  await runFleetCommand({
    argv: ["audit", "--help"],
    stderr: outputStream().stream,
    stdout: stdout.stream,
  })

  assert.match(stdout.value(), /cloudflare-fleet audit/)
  assert.match(stdout.value(), /without writing/)
})

test("unified CLI serves namespace and leaf help without requiring operands", async () => {
  const cases = [
    [["alignment", "--help"], /cloudflare-fleet alignment/],
    [["alignment", "plan", "--help"], /SELECTOR/],
    [["intent", "--help"], /cloudflare-fleet intent/],
    [["change", "--help"], /cloudflare-fleet change/],
    [["config", "--help"], /cloudflare-fleet config/],
    [["config", "show", "--help"], /credential presence/],
    [["doctor", "--help"], /cloudflare-fleet doctor/],
    [["activity", "--help"], /cloudflare-fleet activity/],
    [["activity", "undo", "--help"], /guarded undo/],
    [["hosted", "--help"], /cloudflare-fleet hosted/],
    [["schema", "--help"], /cloudflare-fleet schema/],
    [["schema", "change", "--help"], /machine-readable public input schemas/],
    [["help", "intent"], /cloudflare-fleet intent/],
    [["help", "doctor"], /check selected-backend readiness/],
    [["state", "plan", "--help"], /intentSource/],
    [["recovery", "apply", "--help"], /unknown-outcome/],
  ]

  for (const [argv, pattern] of cases) {
    const stdout = outputStream()
    const exits = []
    await runFleetCommand({
      argv,
      onExitCode: (code) => exits.push(code),
      stderr: outputStream().stream,
      stdout: stdout.stream,
    })
    assert.match(stdout.value(), pattern)
    assert.deepEqual(exits, [FLEET_CLI_EXIT_CODE.SUCCESS])
  }
})

test("unified CLI help documents the bounded agent surface", () => {
  const usage = fleetUsage()
  assert.match(usage, /alignment apply/)
  assert.match(usage, /--expect-plan DIGEST/)
  assert.match(usage, /activity list/)
  assert.match(usage, /cloudflare-fleet mcp/)
  assert.match(usage, /cloudflare-fleet change plan/)
  assert.match(usage, /activity undo plan/)
  assert.match(usage, /config show/)
  assert.match(usage, /cloudflare-fleet doctor/)
})

test("unified CLI parses configuration and doctor diagnostics", () => {
  assert.deepEqual(
    parseFleetArguments([
      "config",
      "show",
      "--format=json",
      "--state-file",
      "profiles/state.json",
      "--policy-file=profiles/policy.json",
    ]),
    {
      command: "config-show",
      format: "json",
      policyFile: "profiles/policy.json",
      stateFile: "profiles/state.json",
    },
  )
  assert.deepEqual(
    parseFleetArguments(["doctor", "--live", "-fjson"]),
    {
      command: "doctor",
      format: "json",
      live: true,
      policyFile: null,
      stateFile: null,
    },
  )
})

test("configuration output explains resolved sources without requiring credentials", async () => {
  const stdout = outputStream()
  const exits = []
  await runFleetCommand({
    argv: ["config", "show"],
    inspectRuntimeConfiguration: async () => ({
      credentials: {
        accountId: { environmentName: "CLOUDFLARE_ACCOUNT_ID", present: false },
        apiToken: { environmentName: "CLOUDFLARE_API_TOKEN", present: false },
      },
      dashboard: { reason: "CLI remains available", status: "unsupported" },
      paths: {
        policy: {
          accessible: false,
          exists: false,
          parent: { existingPath: "/profiles", writable: true },
          path: "/profiles/policy.json",
          sourceName: "CLOUDFLARE_FLEET_POLICY_FILE",
        },
        state: {
          accessible: true,
          exists: true,
          kind: "file",
          mode: "0600",
          path: "/profiles/state.json",
          sourceName: "--state-file",
          symbolicLink: false,
        },
      },
      runtime: {
        architecture: "arm64",
        node: { version: "22.0.0" },
        packageVersion: "0.1.0",
        platform: "darwin",
      },
      schemaVersion: 1,
      status: "ok",
    }),
    onExitCode: (code) => exits.push(code),
    stderr: outputStream().stream,
    stdout: stdout.stream,
  })

  assert.match(stdout.value(), /State: \/profiles\/state.json/)
  assert.match(stdout.value(), /Source: --state-file/)
  assert.match(stdout.value(), /CLOUDFLARE_API_TOKEN: unset/)
  assert.match(stdout.value(), /Secret values are not displayed/)
  assert.deepEqual(exits, [FLEET_CLI_EXIT_CODE.SUCCESS])
})

test("doctor emits structured attention results with exit 4", async () => {
  const stdout = outputStream()
  const exits = []
  const result = {
    checks: [{
      detail: "CLOUDFLARE_API_TOKEN is unset",
      id: "credentials.api-token",
      label: "Cloudflare API token",
      remedy: "Export CLOUDFLARE_API_TOKEN",
      status: "fail",
    }],
    schemaVersion: 1,
    status: "attention",
    summary: { fail: 1, pass: 0, skip: 0, warning: 0 },
  }
  await runFleetCommand({
    argv: ["doctor", "--format", "json"],
    diagnoseRuntime: async () => result,
    onExitCode: (code) => exits.push(code),
    stderr: outputStream().stream,
    stdout: stdout.stream,
  })

  assert.deepEqual(JSON.parse(stdout.value()), result)
  assert.deepEqual(exits, [FLEET_CLI_EXIT_CODE.ATTENTION])
})

test("unified CLI parses canonical intent, change, undo, and schema commands", () => {
  assert.deepEqual(
    parseFleetArguments(["intent", "aliases", "--format=json"]),
    {
      command: "intent-aliases",
      expectedDigest: null,
      format: "json",
      input: null,
      stateFile: null,
    },
  )
  assert.deepEqual(
    parseFleetArguments(["intent", "rate-limits", "--format=json"]),
    {
      command: "intent-rate-limits",
      expectedDigest: null,
      format: "json",
      input: null,
      stateFile: null,
    },
  )
  assert.deepEqual(
    parseFleetArguments(["intent", "plan", "-iintent.json", "-fjson"]),
    {
      command: "intent-plan",
      expectedDigest: null,
      format: "json",
      input: "intent.json",
      stateFile: null,
    },
  )
  assert.deepEqual(
    parseFleetArguments([
      "change",
      "apply",
      "--input=change.json",
      "--expect-plan",
      "sha256:approved",
    ]),
    {
      command: "change-apply",
      expectedDigest: "sha256:approved",
      format: "text",
      input: "change.json",
      policyFile: null,
      stateFile: null,
    },
  )
  assert.equal(
    parseFleetArguments([
      "activity",
      "undo",
      "plan",
      "--id",
      "activity-one",
    ]).command,
    "activity-undo-plan",
  )
  assert.deepEqual(parseFleetArguments(["schema", "change"]), {
    command: "schema-change",
  })
})

test("unified CLI exposes reusable canonical alias templates without credentials", async () => {
  const stdout = outputStream()
  await runFleetCommand({
    argv: ["intent", "aliases", "--format=json"],
    environment: {},
    stderr: outputStream().stream,
    stdout: stdout.stream,
  })

  const result = JSON.parse(stdout.value())
  assert.equal(result.facet.key, "canonical-web-passthrough")
  assert.deepEqual(
    result.templates.map((template) => [
      template.sourceHost,
      template.value.redirect.targetHost,
      template.value.redirect.statusCode,
    ]),
    [
      ["j256.dev", "j-256.dev", 307],
      ["strangelaser.com", "strangelasers.com", 308],
      ["strangelasers.net", "strangelasers.com", 307],
    ],
  )
})

test("unified CLI exposes the hostname-scoped Free rate-limit relationship", async () => {
  const stdout = outputStream()
  await runFleetCommand({
    argv: ["intent", "rate-limits", "--format=json"],
    environment: {},
    stderr: outputStream().stream,
    stdout: stdout.stream,
  })

  const result = JSON.parse(stdout.value())
  assert.equal(result.facet.key, "hostname-scoped-free-rate-limit")
  assert.equal(result.relationship.firstPhase, "http_request_firewall_custom")
  assert.equal(result.relationship.ratePhase, "http_ratelimit")
  assert.equal(result.templates[0].value.rateRules.length, 0)
  assert.equal(result.templates[1].value.skipRules.length, 1)
})

test("unified CLI exports intent documents and accepts bounded JSON input", async () => {
  const intentOutput = outputStream()
  await runFleetCommand({
    argv: ["intent", "show"],
    service: {
      async getIntent() {
        return {
          accountId: "account-one",
          document: { accountId: "account-one", revision: "intent-one" },
          schemaVersion: 1,
          status: "ok",
        }
      },
    },
    stderr: outputStream().stream,
    stdout: intentOutput.stream,
  })
  assert.deepEqual(JSON.parse(intentOutput.value()), {
    accountId: "account-one",
    revision: "intent-one",
  })

  const changeOutput = outputStream()
  let requestedChange
  await runFleetCommand({
    argv: ["change", "plan", "--input", "-", "--format=json"],
    inputText: JSON.stringify({
      desired: "on",
      kind: "zone-setting-update",
      settingId: "always_use_https",
      zoneId: "zone-one",
    }),
    service: {
      async planChange(change) {
        requestedChange = change
        return {
          accountId: "account-one",
          change,
          planSet: null,
          reason: "Already aligned",
          schemaVersion: 1,
          status: "aligned",
          title: "Update zone setting",
        }
      },
    },
    stderr: outputStream().stream,
    stdout: changeOutput.stream,
  })
  assert.equal(requestedChange.kind, "zone-setting-update")
  assert.equal(JSON.parse(changeOutput.value()).status, "aligned")
})

test("unified CLI emits public input schemas without requiring credentials", async () => {
  const stdout = outputStream()
  await runFleetCommand({
    argv: ["schema", "change"],
    environment: {},
    stderr: outputStream().stream,
    stdout: stdout.stream,
  })

  const schema = JSON.parse(stdout.value())
  assert.equal(Array.isArray(schema.oneOf), true)
  assert.match(stdout.value(), /zone-setting-update/)
  assert.doesNotMatch(stdout.value(), /"method"/)
})

test("unified CLI maps invalid structured input to usage exit 2", async () => {
  const exits = []
  const stderr = outputStream()
  await runFleetCli({
    argv: ["change", "plan", "--input", "-"],
    environment: {},
    inputText: "{}",
    onExitCode: (code) => exits.push(code),
    stderr: stderr.stream,
    stdout: outputStream().stream,
  })

  assert.deepEqual(exits, [FLEET_CLI_EXIT_CODE.USAGE])
  assert.match(stderr.value(), /Fleet change is invalid/)
})

test("unified CLI maps missing operator configuration to exit 2", async () => {
  const exits = []
  const stdout = outputStream()
  await runFleetCli({
    argv: ["alignment", "list", "--format=json"],
    environment: {},
    onExitCode: (code) => exits.push(code),
    stderr: outputStream().stream,
    stdout: stdout.stream,
  })

  assert.deepEqual(exits, [FLEET_CLI_EXIT_CODE.USAGE])
  assert.equal(JSON.parse(stdout.value()).status, "configuration-error")
})

test("unified CLI delegates dashboard arguments through the canonical command", async () => {
  let arguments_
  const result = await runFleetCommand({
    argv: ["dashboard", "-rf", "--debug-port=9224"],
    environment: {},
    dashboardRunner(argv) {
      arguments_ = argv
      return "launched"
    },
    stderr: outputStream().stream,
    stdout: outputStream().stream,
  })

  assert.equal(result, "launched")
  assert.deepEqual(arguments_, ["-rf", "--debug-port=9224"])
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
