import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  fleetPolicyScript,
  prepareFleetPolicyScript,
  readFleetPolicyConfiguration,
} from "../src/fleet-policy-store.mjs"

const POLICY = {
  emailDnsRecordExceptions: [
    {
      component: "spf",
      expected: {
        content: "v=spf1 include:_spf.example.net -all",
        ttl: 300,
      },
      reason: "Approved sender policy",
      zoneName: "special.example",
    },
  ],
  schemaVersion: 1,
}

test("missing fleet policy configuration produces an empty document", async () => {
  const configuration = await readFleetPolicyConfiguration(
    path.join(os.tmpdir(), `missing-fleet-policy-${process.pid}.json`),
  )

  assert.deepEqual(configuration.emailDnsRecordExceptions, [])
})

test("fleet policy preparation emits safe browser configuration", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-policy-store-test."))
  const policyFile = path.join(root, "fleet-policy.json")
  const outputPath = path.join(root, "policy.js")
  context.after(() => fs.rm(root, { force: true, recursive: true }))
  await fs.writeFile(policyFile, `${JSON.stringify(POLICY)}\n`)

  const configuration = await prepareFleetPolicyScript({
    outputPath,
    policyFile,
  })
  const source = await fs.readFile(outputPath, "utf8")

  assert.equal(configuration.emailDnsRecordExceptions.length, 1)
  assert.match(source, /__CLOUDFLARE_FLEET_POLICY_CONFIG__/)
  assert.match(source, /special\.example/)
  assert.equal(fleetPolicyScript(POLICY).includes("</script>"), false)
})

test("fleet policy store rejects invalid JSON and schema", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-policy-invalid-test."))
  const policyFile = path.join(root, "fleet-policy.json")
  context.after(() => fs.rm(root, { force: true, recursive: true }))

  await fs.writeFile(policyFile, "not json\n")
  await assert.rejects(
    readFleetPolicyConfiguration(policyFile),
    /not valid JSON/,
  )
  await fs.writeFile(policyFile, "{}\n")
  await assert.rejects(
    readFleetPolicyConfiguration(policyFile),
    /configuration is invalid/,
  )
})
