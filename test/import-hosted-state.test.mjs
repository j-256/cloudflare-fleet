import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  databaseIdFromWrangler,
  parseImportHostedStateArguments,
} from "../scripts/import-hosted-state.mjs"

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
