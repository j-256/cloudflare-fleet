import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const launcher = path.join(projectRoot, "launch.sh")

test("launcher accepts short option aliases", async () => {
  const readOnly = await execFileAsync(
    "/bin/bash",
    [
      launcher,
      "-r",
      "-f",
      "-d",
      "9224",
      "-s",
      "profiles/state.json",
      "-p",
      "profiles/policy.json",
      "-h",
    ],
  )
  const readWrite = await execFileAsync(
    "/bin/bash",
    [launcher, "-w", "-c", "-h"],
  )

  assert.match(readOnly.stdout, /-r, --read-only/)
  assert.match(readOnly.stdout, /-d, --debug-port PORT/)
  assert.match(readOnly.stdout, /-s, --state-file PATH/)
  assert.match(readOnly.stdout, /-p, --policy-file PATH/)
  assert.match(readWrite.stdout, /-w, --write/)
  assert.match(readWrite.stdout, /-c, --clear-cache/)
})

test("launcher accepts bundled flags, glued values, and long equals", async () => {
  const bundled = await execFileAsync(
    "/bin/bash",
    [launcher, "-rfd9224", "-sprofiles/state.json", "-pprofiles/policy.json", "-h"],
  )
  const longEquals = await execFileAsync(
    "/bin/bash",
    [
      launcher,
      "--debug-port=9224",
      "--state-file=profiles/state.json",
      "--policy-file=profiles/policy.json",
      "--help",
    ],
  )

  assert.match(bundled.stdout, /-d, --debug-port PORT/)
  assert.match(longEquals.stdout, /EXIT STATUS/)
})

test("launcher presents the canonical dispatcher name when delegated", async () => {
  const result = await execFileAsync(
    "/bin/bash",
    [launcher, "--help"],
    {
      env: {
        ...process.env,
        CLOUDFLARE_FLEET_COMMAND_NAME: "cloudflare-fleet dashboard",
      },
    },
  )

  assert.match(result.stdout, /cloudflare-fleet dashboard \[-r \| -w\]/)
})

test("launcher applies short option validation", async () => {
  await assert.rejects(
    execFileAsync("/bin/bash", [launcher, "-r", "-w"]),
    (error) => {
      assert.equal(error.code, 2)
      assert.match(error.stderr, /--read-only and --write cannot be combined/)
      return true
    },
  )
  await assert.rejects(
    execFileAsync("/bin/bash", [launcher, "-d"]),
    (error) => {
      assert.equal(error.code, 2)
      assert.match(error.stderr, /--debug-port requires a value/)
      return true
    },
  )
})

test("launcher resolves its project directory through a symlink", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudflare-fleet-launch."))
  const launcherLink = path.join(root, "cf-fleet")
  try {
    await fs.symlink(launcher, launcherLink)
    const { stderr, stdout } = await execFileAsync(
      "/bin/bash",
      ["-x", launcherLink, "--help"],
    )

    assert.match(stdout, /SYNOPSIS\n  cf-fleet /)
    assert.equal(stderr.includes(`+ SCRIPT_DIR=${projectRoot}`), true)
  } finally {
    await fs.rm(root, {
      force: true,
      recursive: true,
    })
  }
})
