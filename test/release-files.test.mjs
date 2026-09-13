import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { readRegularReleaseFile } from "../src/release-files.mjs"

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-release-input-"))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, "input")
  await fs.writeFile(file, "verified", { mode: 0o700 })
  return { root, file }
}

test("release inputs read bounded content and mode from the opened regular file", async (context) => {
  const { file } = await fixture(context)
  const result = await readRegularReleaseFile(file, 8)
  assert.equal(result.content.toString(), "verified")
  assert.equal(result.mode & 0o777, 0o700)
  await fs.writeFile(file, "")
  assert.equal((await readRegularReleaseFile(file)).content.length, 0)
})

test("release inputs reject symlinks, directories, and oversized files", async (context) => {
  const { root, file } = await fixture(context)
  const link = path.join(root, "link")
  await fs.symlink(file, link)
  await assert.rejects(readRegularReleaseFile(link))
  await assert.rejects(readRegularReleaseFile(root), /regular file/)
  await assert.rejects(readRegularReleaseFile(file, 7), /regular file/)
})

test("release inputs reject growth during a bounded read and always close the descriptor", async (context) => {
  const { file } = await fixture(context)
  let closed = false
  const open = async (...args) => {
    const handle = await fs.open(...args)
    return {
      stat: () => handle.stat(),
      async read(...selected) {
        await fs.appendFile(file, " changed")
        return handle.read(...selected)
      },
      async close() { closed = true; await handle.close() },
    }
  }
  await assert.rejects(readRegularReleaseFile(file, 8, { open }), /changed while/)
  assert.equal(closed, true)
})

test("release inputs reject replacement between opening and validation", async (context) => {
  const { root, file } = await fixture(context)
  let closed = false
  const open = async (...args) => {
    const handle = await fs.open(...args)
    await fs.rename(file, path.join(root, "original"))
    await fs.writeFile(file, "replacement")
    return {
      stat: () => handle.stat(),
      read: (...selected) => handle.read(...selected),
      async close() { closed = true; await handle.close() },
    }
  }
  await assert.rejects(readRegularReleaseFile(file, 100, { open }), /regular file/)
  assert.equal(closed, true)
})
