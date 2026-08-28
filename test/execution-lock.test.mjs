import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { withFleetExecutionLock } from "../src/execution-lock.mjs"

async function fixture(context) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudflare-fleet-execution-lock-test."),
  )
  context.after(() => fs.rm(directory, { force: true, recursive: true }))
  return path.join(directory, "state.json")
}

test("fleet execution lock exists for the operation and is released afterward", async (context) => {
  const stateFile = await fixture(context)
  const lockPath = `${stateFile}.execution-lock`

  const result = await withFleetExecutionLock(stateFile, async () => {
    assert.equal((await fs.stat(lockPath)).isDirectory(), true)
    return "complete"
  })

  assert.equal(result, "complete")
  await assert.rejects(fs.stat(lockPath), { code: "ENOENT" })
})

test("fleet execution lock is released when the operation fails", async (context) => {
  const stateFile = await fixture(context)
  const lockPath = `${stateFile}.execution-lock`

  await assert.rejects(
    withFleetExecutionLock(stateFile, async () => {
      throw new Error("Operation failed")
    }),
    /Operation failed/,
  )

  await assert.rejects(fs.stat(lockPath), { code: "ENOENT" })
})
