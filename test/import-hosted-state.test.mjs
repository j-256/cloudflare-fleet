import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  databaseIdFromWrangler,
  importHostedState,
  parseImportHostedStateArguments,
} from "../scripts/import-hosted-state.mjs"
import { hostedD1Fixture } from "./hosted-d1.fixture.mjs"
import { hostedWorkerStore } from "../src/hosted/worker-store.mjs"
import { localWorkerStore } from "../src/worker-store.mjs"
import { workerFixture } from "./worker.fixture.mjs"

test("hosted state import accepts an explicit state and config", () => {
  const parsed = parseImportHostedStateArguments([
    "--force",
    "--config",
    "deployment/wrangler.jsonc",
    "profiles/team.json",
  ])

  assert.equal(parsed.force, true)
  assert.equal(parsed.configFile, path.resolve("deployment/wrangler.jsonc"))
  assert.equal(parsed.stateFile, path.resolve("profiles/team.json"))
})

test("hosted state import defaults to durable state and working-directory config", () => {
  const parsed = parseImportHostedStateArguments([], {
    XDG_STATE_HOME: "/state",
  })

  assert.equal(parsed.configFile, path.resolve("wrangler.jsonc"))
  assert.equal(parsed.stateFile, "/state/cloudflare-fleet/state.json")
  assert.throws(
    () => parseImportHostedStateArguments([], {
      CLOUDFLARE_FLEET_STATE_FILE: "relative/state.json",
    }),
    /must be an absolute path/,
  )
  assert.equal(
    parseImportHostedStateArguments(["--help"], {
      CLOUDFLARE_FLEET_STATE_FILE: "relative/state.json",
    }).help,
    true,
  )
})

test("hosted state import resolves its D1 database from Wrangler", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-import-config-test."))
  const configFile = path.join(root, "wrangler.jsonc")
  context.after(() => fs.rm(root, { force: true, recursive: true }))
  await fs.writeFile(configFile, JSON.stringify({
    d1_databases: [
      {
        binding: "OTHER_DB",
        database_id: "other-id",
      },
      {
        binding: "FLEET_DB",
        database_id: "fleet-database-id",
      },
    ],
  }))

  assert.equal(
    await databaseIdFromWrangler(configFile),
    "fleet-database-id",
  )
})

test("hosted state import retains Worker incident documents and refuses occupied state", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-import-workers-"))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const fixture = workerFixture()
  await fixture.service.record({ worker: "example-worker" })
  const stateFile = path.join(root, "state.json")
  await localWorkerStore(stateFile, fixture.api.accountId).write("", await fixture.store.read())
  const database = hostedD1Fixture(context)
  const originalFetch = globalThis.fetch
  context.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (url, request) => {
    assert.match(String(url), /\/accounts\/example-account\/d1\/database\/fixture-database\/query$/)
    const body = JSON.parse(request.body)
    const result = body.batch
      ? await database.batch(body.batch.map((item) => database.prepare(item.sql).bind(...item.params)))
      : [await database.prepare(body.sql).bind(...body.params).all()]
    return Response.json({ success: true, result })
  }
  const input = { accountId: fixture.api.accountId, apiToken: "fixture-token", databaseId: "fixture-database", stateFile }
  await importHostedState(input)
  assert.deepEqual(await hostedWorkerStore(database, fixture.api.accountId).read(), await fixture.store.read())
  await assert.rejects(importHostedState(input), /already exists/)
  await importHostedState({ ...input, force: true })
  assert.equal((await hostedWorkerStore(database, fixture.api.accountId).read()).records.length, 1)
})
