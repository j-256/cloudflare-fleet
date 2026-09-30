import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { test } from "node:test"

import { compareReleaseVersions, prepareReleaseFiles } from "../scripts/prepare-release.mjs"

const execute = promisify(execFile)

test("compares stable and prerelease versions", () => {
  for (const [left, right, expected] of [
    ["1.2.3", "1.2.3", 0],
    ["1.2.4", "1.2.3", 1],
    ["2.0.0", "10.0.0", -1],
    ["1.2.3-beta.2", "1.2.3-beta.11", -1],
    ["1.2.3-alpha-beta", "1.2.3-alpha", 1],
    ["1.2.3-beta", "1.2.3", -1],
    ["1.2.3", "1.2.3-rc.1", 1],
  ]) assert.equal(compareReleaseVersions(left, right), expected, `${left} compared with ${right}`)
})

test("updates only matching package version fields", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-release-prepare-"))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const metadata = { name: "example", version: "1.2.3", nested: { version: "preserve" } }
  const lock = { name: "example", version: "1.2.3", packages: { "": { name: "example", version: "1.2.3" }, "node_modules/example": { version: "9.9.9" } } }
  await fs.writeFile(path.join(root, "package.json"), `${JSON.stringify(metadata, null, 2)}\n`)
  await fs.writeFile(path.join(root, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`)
  assert.deepEqual(await prepareReleaseFiles(root, "1.3.0"), {
    previousVersion: "1.2.3", version: "1.3.0", files: ["package.json", "package-lock.json"],
  })
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "package.json"))), { ...metadata, version: "1.3.0" })
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "package-lock.json"))), {
    ...lock, version: "1.3.0", packages: { ...lock.packages, "": { ...lock.packages[""], version: "1.3.0" } },
  })
})

test("refuses stale, malformed, and inconsistent versions without writing", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-release-refuse-"))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const metadata = '{"name":"example","version":"1.2.3"}\n'
  const lock = '{"name":"example","version":"1.2.3","packages":{"":{"version":"1.2.2"}}}\n'
  await fs.writeFile(path.join(root, "package.json"), metadata)
  await fs.writeFile(path.join(root, "package-lock.json"), lock)
  await assert.rejects(prepareReleaseFiles(root, "1.3.0"), /versions do not agree/u)
  assert.equal(await fs.readFile(path.join(root, "package.json"), "utf8"), metadata)
  assert.equal(await fs.readFile(path.join(root, "package-lock.json"), "utf8"), lock)
  await assert.rejects(prepareReleaseFiles(root, "not-a-version"), /exact release version/u)
})

test("command exposes help and usage failures", async () => {
  const script = new URL("../scripts/prepare-release.mjs", import.meta.url).pathname
  assert.match((await execute(process.execPath, [script, "--help"])).stdout, /--version VERSION/u)
  assert.match((await execute(process.execPath, [script, "-h"])).stdout, /Exit: 0 success\/help/u)
  await assert.rejects(execute(process.execPath, [script]), error => error.code === 2 && /--version is required/u.test(error.stderr))
  await assert.rejects(execute(process.execPath, [script, "--unknown"]), error => error.code === 2 && /Unknown option/u.test(error.stderr))
})
