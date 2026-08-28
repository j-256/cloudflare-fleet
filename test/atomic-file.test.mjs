import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { atomicWriteFile } from "../src/atomic-file.mjs"

async function fixture(context) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudflare-fleet-atomic-test."),
  )
  context.after(() => fs.rm(directory, {
    force: true,
    recursive: true,
  }))
  return {
    directory,
    file: path.join(directory, "state.json"),
  }
}

test("atomic writes replace private files without temporary residue", async (context) => {
  const { directory, file } = await fixture(context)

  await atomicWriteFile(file, "first\n")
  await atomicWriteFile(file, "second\n")

  assert.equal(await fs.readFile(file, "utf8"), "second\n")
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
  assert.deepEqual(await fs.readdir(directory), ["state.json"])
})

test("atomic writes remove temporary files when content writing fails", async (context) => {
  const { directory, file } = await fixture(context)

  await assert.rejects(
    atomicWriteFile(file, Symbol("invalid content")),
    { code: "ERR_INVALID_ARG_TYPE" },
  )

  assert.deepEqual(await fs.readdir(directory), [])
})

test("concurrent atomic writes never expose partial content", async (context) => {
  const { directory, file } = await fixture(context)
  const left = `${"left".repeat(10000)}\n`
  const right = `${"right".repeat(10000)}\n`

  await Promise.all([
    atomicWriteFile(file, left),
    atomicWriteFile(file, right),
  ])

  assert.equal([left, right].includes(await fs.readFile(file, "utf8")), true)
  assert.deepEqual(await fs.readdir(directory), ["state.json"])
})
