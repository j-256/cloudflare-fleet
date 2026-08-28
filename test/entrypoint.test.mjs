import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"

import { isMainModule } from "../src/entrypoint.mjs"

test("main module detection resolves synthetic and symlinked entry paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudflare-fleet-entrypoint."))
  const physicalDirectory = path.join(root, "physical")
  const linkedDirectory = path.join(root, "linked")
  const modulePath = path.join(physicalDirectory, "runner.mjs")
  try {
    await fs.mkdir(physicalDirectory)
    await fs.writeFile(modulePath, "\n")
    await fs.symlink(physicalDirectory, linkedDirectory)

    assert.equal(
      isMainModule(
        pathToFileURL(modulePath).href,
        path.join(linkedDirectory, "runner.mjs"),
      ),
      true,
    )
    assert.equal(
      isMainModule(
        pathToFileURL(modulePath).href,
        path.join(linkedDirectory, "other.mjs"),
      ),
      false,
    )
    assert.equal(isMainModule(pathToFileURL(modulePath).href, ""), false)
  } finally {
    await fs.rm(root, {
      force: true,
      recursive: true,
    })
  }
})
