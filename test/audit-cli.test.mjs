import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

import {
  collectFleetAudit,
  FLEET_AUDIT_EXIT_CODE,
  fleetAuditExitCode,
  fleetAuditUsage,
  parseFleetAuditArguments,
  resolvePolicyFile,
  resolveStateFile,
} from "../src/audit.mjs"

test("fleet audit arguments default to a core markdown report", () => {
  assert.deepEqual(parseFleetAuditArguments([]), {
    deep: false,
    failOn: null,
    format: "markdown",
    help: false,
    policyFile: null,
    stateFile: null,
  })
})

test("fleet audit arguments accept deep JSON output and an explicit state file", () => {
  assert.deepEqual(parseFleetAuditArguments([
    "--deep",
    "--fail-on=warning",
    "--format=json",
    "--state-file",
    "/tmp/fleet-state.json",
  ]), {
    deep: true,
    failOn: "warning",
    format: "json",
    help: false,
    policyFile: null,
    stateFile: "/tmp/fleet-state.json",
  })
})

test("fleet audit arguments accept a self-contained HTML report", () => {
  assert.deepEqual(parseFleetAuditArguments(["--format=html"]), {
    deep: false,
    failOn: null,
    format: "html",
    help: false,
    policyFile: null,
    stateFile: null,
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
  assert.throws(
    () => parseFleetAuditArguments(["--fail-on", "urgent"]),
    /Unsupported audit fail threshold/,
  )
})

test("fleet audit exit policy honors severity thresholds", () => {
  const report = {
    findings: [
      { severity: "warning" },
      { severity: "review" },
    ],
  }

  assert.equal(fleetAuditExitCode(report, null), FLEET_AUDIT_EXIT_CODE.SUCCESS)
  assert.equal(FLEET_AUDIT_EXIT_CODE.ERROR, 1)
  assert.equal(FLEET_AUDIT_EXIT_CODE.FINDINGS, 4)
  assert.equal(fleetAuditExitCode(report, "critical"), FLEET_AUDIT_EXIT_CODE.SUCCESS)
  assert.equal(fleetAuditExitCode(report, "warning"), FLEET_AUDIT_EXIT_CODE.FINDINGS)
  assert.equal(fleetAuditExitCode(report, "review"), FLEET_AUDIT_EXIT_CODE.FINDINGS)
  assert.equal(fleetAuditExitCode(report, "info"), FLEET_AUDIT_EXIT_CODE.FINDINGS)
  assert.equal(
    fleetAuditExitCode({ findings: [] }, "info"),
    FLEET_AUDIT_EXIT_CODE.SUCCESS,
  )
  assert.throws(
    () => fleetAuditExitCode(report, "urgent"),
    /Unsupported audit fail threshold/,
  )
  assert.throws(
    () => fleetAuditExitCode({ findings: [{ severity: "urgent" }] }, "info"),
    /Unsupported audit finding severity/,
  )
})

test("fleet audit usage labels the command as read-only", () => {
  assert.match(fleetAuditUsage(), /without writing/)
  assert.match(fleetAuditUsage(), /--deep/)
  assert.match(fleetAuditUsage(), /--fail-on LEVEL/)
  assert.match(fleetAuditUsage(), /markdown\|json\|html/)
})

test("fleet audit arguments keep supported short options equivalent", () => {
  const cases = [
    [["-d"], ["--deep"]],
    [["-f", "json"], ["--format", "json"]],
    [["-p", "policy.json"], ["--policy-file", "policy.json"]],
    [["-s", "state.json"], ["--state-file", "state.json"]],
    [["-h"], ["--help"]],
  ]
  for (const [shortArguments, longArguments] of cases) {
    assert.deepEqual(
      parseFleetAuditArguments(shortArguments),
      parseFleetAuditArguments(longArguments),
    )
  }
  assert.throws(() => parseFleetAuditArguments(["-F"]), /Unknown option: -F/)
})

test("resolveStateFile accepts an explicit relative --state-file even if it equals the env var", () => {
  // Only the env var must be absolute; an explicit flag value may be relative
  assert.equal(
    resolveStateFile("shared/state.json", { CLOUDFLARE_FLEET_STATE_FILE: "shared/state.json" }),
    path.resolve("shared/state.json"),
  )
})

test("resolveStateFile still requires CLOUDFLARE_FLEET_STATE_FILE to be absolute", () => {
  assert.throws(
    () => resolveStateFile(undefined, { CLOUDFLARE_FLEET_STATE_FILE: "relative/state.json" }),
    /CLOUDFLARE_FLEET_STATE_FILE must be an absolute path/,
  )
  assert.equal(
    resolveStateFile(undefined, { CLOUDFLARE_FLEET_STATE_FILE: "/abs/state.json" }),
    path.resolve("/abs/state.json"),
  )
  assert.equal(
    resolveStateFile(undefined, { XDG_STATE_HOME: "/state" }),
    "/state/cloudflare-fleet/state.json",
  )
})

test("fleet audit arguments accept a policy file", () => {
  assert.equal(
    parseFleetAuditArguments(["--policy-file", "config/policy.json"]).policyFile,
    "config/policy.json",
  )
})

test("resolvePolicyFile accepts an explicit path and requires an absolute env path", () => {
  assert.equal(
    resolvePolicyFile("config/policy.json", {}),
    path.resolve("config/policy.json"),
  )
  assert.throws(
    () => resolvePolicyFile(undefined, {
      CLOUDFLARE_FLEET_POLICY_FILE: "config/policy.json",
    }),
    /CLOUDFLARE_FLEET_POLICY_FILE must be an absolute path/,
  )
  assert.equal(
    resolvePolicyFile(undefined, { XDG_CONFIG_HOME: "/config" }),
    "/config/cloudflare-fleet/fleet-policy.json",
  )
})

test("collectFleetAudit supports an injected API without requiring a token", async (context) => {
  const stateFile = path.resolve(
    "test-results",
    `audit-service-${context.name.replaceAll(" ", "-")}.json`,
  )
  const policyFile = path.resolve("fleet-policy.example.json")
  const api = {
    accountId: "account-one",
    async listEmailAddresses() {
      return []
    },
    async listZones() {
      return []
    },
  }

  const report = await collectFleetAudit({
    api,
    environment: {},
    now: 0,
    policyFile,
    stateFile,
  })

  assert.equal(report.summary.zones, 0)
  assert.equal(report.generatedAt, "1970-01-01T00:00:00.000Z")
})
