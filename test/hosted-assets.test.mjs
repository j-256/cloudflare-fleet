import assert from "node:assert/strict"
import { access, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  buildWorkerAssets,
  collectBrowserModules,
} from "../scripts/build-worker-assets.mjs"

test("hosted asset build includes only the browser dependency graph", async (context) => {
  const destination = await mkdtemp(
    path.join(os.tmpdir(), "cloudflare-fleet-assets-test."),
  )
  context.after(() => rm(destination, { force: true, recursive: true }))

  const result = await buildWorkerAssets(destination)
  const modules = await collectBrowserModules()

  assert.equal(result.files.includes("index.html"), true)
  assert.equal(result.files.includes("styles.css"), true)
  assert.equal(result.files.includes("src/app.mjs"), true)
  assert.equal(result.files.includes("state.json"), false)
  assert.equal(result.files.includes("src/session-broker.mjs"), false)
  assert.equal(result.files.some((file) => file.startsWith("test/")), false)
  assert.deepEqual(
    result.files.filter((file) => file.startsWith("src/")),
    modules.map((file) => path.relative(
      path.dirname(path.dirname(fileURLToPath(import.meta.url))),
      file,
    )).sort(),
  )
  await Promise.all(result.files.map((file) => access(path.join(destination, file))))
})
