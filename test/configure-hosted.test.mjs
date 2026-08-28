import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  hostedWranglerConfiguration,
  parseHostedConfigurationArguments,
  writeHostedWranglerConfiguration,
} from "../scripts/configure-hosted.mjs"

const CONFIGURE_SCRIPT = fileURLToPath(
  new URL("../scripts/configure-hosted.mjs", import.meta.url),
)

function options(root) {
  return {
    accessAudience: "b".repeat(64),
    accessTeamDomain: "https://team.cloudflareaccess.com",
    accountId: "a".repeat(32),
    databaseId: "11111111-2222-4333-8444-555555555555",
    hostname: "fleet.example.com",
    outputFile: path.join(root, "wrangler.jsonc"),
    policyFile: path.join(root, "fleet-policy.json"),
    readOnly: true,
    workerName: "cloudflare-fleet",
  }
}

test("hosted configuration arguments default to read-only deployment", () => {
  const parsed = parseHostedConfigurationArguments([], {
    CLOUDFLARE_ACCESS_AUD: "b".repeat(64),
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_FLEET_D1_DATABASE_ID: "11111111-2222-4333-8444-555555555555",
    CLOUDFLARE_FLEET_HOSTNAME: "fleet.example.com",
  })

  assert.equal(parsed.readOnly, true)
  assert.equal(parsed.hostname, "fleet.example.com")
  assert.equal(parsed.outputFile, path.resolve("wrangler.jsonc"))
  assert.equal(parseHostedConfigurationArguments(["--write"], {}).readOnly, false)
})

test("hosted configuration defaults fleet policy to the user config directory", () => {
  const parsed = parseHostedConfigurationArguments([], {
    XDG_CONFIG_HOME: "/config",
  })

  assert.equal(
    parsed.policyFile,
    "/config/cloudflare-fleet/fleet-policy.json",
  )
  assert.throws(
    () => parseHostedConfigurationArguments([], {
      CLOUDFLARE_FLEET_POLICY_FILE: "relative/policy.json",
    }),
    /must be an absolute path/,
  )
  assert.equal(
    parseHostedConfigurationArguments(["--policy-file", "policy.json"], {
      CLOUDFLARE_FLEET_POLICY_FILE: "relative/policy.json",
    }).policyFile,
    path.resolve("policy.json"),
  )
  assert.equal(
    parseHostedConfigurationArguments(["--help"], {
      CLOUDFLARE_FLEET_POLICY_FILE: "relative/policy.json",
    }).help,
    true,
  )
})

test("hosted configuration writes portable Wrangler bindings", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-hosted-config-test."))
  context.after(() => fs.rm(root, { force: true, recursive: true }))
  const configured = options(root)

  const configuration = await writeHostedWranglerConfiguration(configured)
  const persisted = JSON.parse(await fs.readFile(configured.outputFile, "utf8"))
  const mode = (await fs.stat(configured.outputFile)).mode & 0o777

  assert.deepEqual(persisted, configuration)
  assert.equal(configuration.routes[0].pattern, "fleet.example.com")
  assert.equal(configuration.vars.FLEET_READ_ONLY, "true")
  assert.deepEqual(configuration.triggers.crons, [])
  assert.deepEqual(configuration.services, [])
  assert.deepEqual(JSON.parse(configuration.vars.FLEET_POLICY_JSON), {
    emailDnsRecordExceptions: [],
    schemaVersion: 1,
  })
  assert.deepEqual(configuration.secrets.required, ["CLOUDFLARE_API_TOKEN"])
  assert.equal(mode, 0o600)
})

test("hosted configuration rejects incomplete deployment identity", async () => {
  const configured = options(os.tmpdir())

  await assert.rejects(
    hostedWranglerConfiguration({ ...configured, hostname: "https://fleet.example.com" }),
    /hostname is invalid/,
  )
  await assert.rejects(
    hostedWranglerConfiguration({ ...configured, accountId: "account" }),
    /account ID is invalid/,
  )
})

test("hosted configuration CLI resolves a symlinked entry path", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-hosted-config-cli."))
  context.after(() => fs.rm(root, { force: true, recursive: true }))
  const entryPath = path.join(root, "configure-hosted.mjs")
  const outputFile = path.join(root, "wrangler.jsonc")
  await fs.symlink(CONFIGURE_SCRIPT, entryPath)

  const result = spawnSync(process.execPath, [
    entryPath,
    "--access-aud", "b".repeat(64),
    "--access-team-domain", "https://team.cloudflareaccess.com",
    "--account-id", "a".repeat(32),
    "--database-id", "11111111-2222-4333-8444-555555555555",
    "--hostname", "fleet.example.com",
    "--output", outputFile,
  ], { encoding: "utf8" })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).hostname, "fleet.example.com")
  const persisted = JSON.parse(await fs.readFile(outputFile, "utf8"))
  assert.equal(persisted.name, "cloudflare-fleet")
  assert.deepEqual(persisted.services, [])
})
