import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { buildWorkerAssets } from "../scripts/build-worker-assets.mjs"
import { createRemoteFleetService } from "../src/remote-fleet-service.mjs"
import { hostedStateReconciliation } from "../src/hosted/state-reconciliation.mjs"

// Exercise the runtime and bundler pinned by Wrangler, not a second independently resolved runtime
const require = createRequire(import.meta.url)
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"))
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare")
const { build } = wranglerRequire("esbuild")

test("actual Worker runtime shares command persistence, browser reads and recovery archives", async (context) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "fleet-shared-runtime-"))
  context.after(() => rm(scratch, { recursive: true, force: true }))
  const assets = path.join(scratch, "assets")
  await buildWorkerAssets(assets)
  const bundle = await build({
    entryPoints: [new URL("./shared-hosted-runtime.fixture.mjs", import.meta.url).pathname],
    bundle: true, write: false, format: "esm", platform: "neutral", external: ["node:*"],
  })
  const runtime = new Miniflare(convertV4MiniflareOptions({
    name: "fleet", modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-08-11",
    d1Databases: { FLEET_DB: "shared-test" },
    assets: { directory: assets, binding: "ASSETS", run_worker_first: true, routerConfig: { has_user_worker: true } },
  }))
  context.after(() => runtime.dispose())
  const db = await runtime.getD1Database("FLEET_DB")
  const migrationDirectory = new URL("../migrations/", import.meta.url)
  for (const name of (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = await readFile(new URL(name, migrationDirectory), "utf8")
    for (const statement of sql.split(/;\s*\n\s*\n/).map((part) => part.trim()).filter(Boolean)) {
      await db.prepare(statement).run()
    }
  }
  const remote = createRemoteFleetService({
    environment: {
      CLOUDFLARE_FLEET_URL: "https://fleet.example.com",
      CLOUDFLARE_FLEET_ACCOUNT_ID: "account-one",
      CLOUDFLARE_FLEET_ACCESS_CLIENT_ID: "synthetic",
      CLOUDFLARE_FLEET_ACCESS_CLIENT_SECRET: "synthetic",
    },
    fetchImpl: async (_url, options) => {
      const response = await runtime.dispatchFetch("http://localhost/api/commands", options)
      if (!response.headers.get("Content-Type")?.includes("application/json")) context.diagnostic(`HTTP ${response.status}: ${(await response.clone().text()).slice(0,1500)}`)
      assert.match(response.headers.get("Content-Type") || "", /application\/json/, `HTTP ${response.status}: ${(await response.clone().text()).slice(0,1500)}`)
      return response
    },
  })
  assert.equal((await remote.status()).backend, "hosted")
  const original = await remote.getState()
  const input = { state: structuredClone(original.state), intentSource: "incoming" }
  input.state.intent.groups.push({
    id: "runtime-group", name: "Shared runtime group", nameSource: "custom", mode: "members",
    members: [{ zoneId: "zone-one", zoneName: "example.com" }],
  })
  const plan = await remote.planState(input)
  const result = await remote.applyState(input, plan.planSet.digest)
  assert.equal(result.applied, true)
  const browser = await runtime.dispatchFetch("http://localhost/api/intent")
  assert.equal(browser.status, 200)
  assert.equal((await browser.json()).result.groups.some((group) => group.id === "runtime-group"), true)
  assert.deepEqual((await remote.getState(result.archiveId)).state, original.state)
  const document = (await remote.getIntent()).document
  document.groups.find((group) => group.id === "runtime-group").name = "Updated from remote client"
  const intentPlan = await remote.planIntent(document)
  assert.equal((await remote.applyIntent(document, intentPlan.planSet.digest)).applied, true)
  const bootstrap = await runtime.dispatchFetch("http://localhost/intent.js")
  assert.match(await bootstrap.text(), /Updated from remote client/)
  assert.equal((await runtime.dispatchFetch("http://localhost/")).status, 200)
  assert.equal((await remote.audit()).accountId, "account-one")
  assert.equal((await remote.audit({ deep: true })).accountId, "account-one")
  const change = { kind: "zone-setting-update", zoneId: "zone-one", settingId: "always_use_https", desired: "on" }
  const writePlan = await remote.planChange(change)
  assert.equal(writePlan.status, "planned")
  const written = await remote.applyChange(change, writePlan.planSet.digest)
  assert.equal(written.status, "verified")
  assert.equal(written.inverse.available, true)
  const browserActivity = await runtime.dispatchFetch("http://localhost/api/activity")
  assert.equal((await browserActivity.json()).result.entries[0].id, written.activity.id)
  const undo = await remote.planActivityUndo(written.activity.id)
  assert.equal((await remote.applyActivityUndo(written.activity.id, undo.planSet.digest)).status, "verified")
  assert.equal((await remote.planChange(change)).status, "planned")
  const recoveredState = (await remote.getState()).state
  assert.equal(recoveredState.activity.entries.length, 2)
  assert.equal(recoveredState.activity.entries[1].undoOf, written.activity.id)
  const secondAccount = hostedStateReconciliation(db, "account-two")
  const merge = { state: { ...recoveredState, accountId: "account-two", intent: { ...recoveredState.intent, accountId: "account-two" } }, intentSource: "incoming" }
  merge.state.activity.entries.reverse()
  const mergePlan = await secondAccount.planState(merge)
  const merged = await secondAccount.applyState(merge, mergePlan.planSet.digest)
  assert.equal(merged.state.activity.entries[0].id, written.activity.id)
  assert.equal(merged.state.activity.entries[1].undoOf, written.activity.id)
  const failingAccount = hostedStateReconciliation(db, "account-three")
  const beforeFailure = (await failingAccount.getState()).state
  const failedInput = { state: { ...merge.state, accountId: "account-three", intent: { ...merge.state.intent, accountId: "account-three" } }, intentSource: "incoming" }
  const failedPlan = await failingAccount.planState(failedInput)
  await db.prepare("CREATE TRIGGER reject_test_merge BEFORE INSERT ON operation_activity WHEN NEW.account_id = 'account-three' BEGIN SELECT RAISE(ABORT, 'Synthetic persistence failure'); END").run()
  await assert.rejects(() => failingAccount.applyState(failedInput, failedPlan.planSet.digest), /Synthetic persistence failure/)
  const afterFailure = await failingAccount.getState()
  assert.deepEqual(afterFailure.state, beforeFailure)
  assert.equal(afterFailure.archives.length, 0)
})
