import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { test } from "node:test"

import { startReleaseChecks } from "../scripts/start-release-checks.mjs"

const execute = promisify(execFile)
const repository = "owner/project"
const sourceSha = "a".repeat(40)
const headSha = "b".repeat(40)

function fixture() {
  const pr = {
    state: "open", draft: false, changed_files: 2,
    base: { ref: "main", sha: sourceSha, repo: { full_name: repository } },
    head: { ref: "automation/release-v1.2.3", sha: headSha, repo: { full_name: repository } },
    user: { login: "github-actions[bot]" },
  }
  const files = [
    { filename: "package.json", status: "modified" },
    { filename: "package-lock.json", status: "modified" },
  ]
  const run = { id: 123, event: "pull_request", head_sha: headSha, head_repository: { full_name: repository }, path: ".github/workflows/ci.yml", conclusion: "action_required", pull_requests: [{ number: 42 }] }
  const content = {
    head: {
      "package.json": { name: "cloudflare-fleet", version: "1.2.3", private: true },
      "package-lock.json": { name: "cloudflare-fleet", version: "1.2.3", packages: { "": { name: "cloudflare-fleet", version: "1.2.3" } } },
    },
    base: {
      "package.json": { name: "cloudflare-fleet", version: "1.2.2", private: true },
      "package-lock.json": { name: "cloudflare-fleet", version: "1.2.2", packages: { "": { name: "cloudflare-fleet", version: "1.2.2" } } },
    },
  }
  const writes = []
  let time = 0
  const options = {
    repository, sourceSha, number: 42, version: "1.2.3", workflows: ["ci.yml"],
    now: () => time, sleep: async milliseconds => { time += milliseconds }, log: () => {},
    api: async (requestPath, method = "GET") => {
      if (method === "POST") { writes.push(requestPath); return null }
      if (requestPath.endsWith("/files")) return files
      if (requestPath.includes("/actions/runs?")) return { total_count: 1, workflow_runs: [run] }
      if (requestPath.includes("/contents/")) {
        const name = requestPath.includes("package-lock.json") ? "package-lock.json" : "package.json"
        const revision = requestPath.endsWith(sourceSha) ? "base" : "head"
        return { encoding: "base64", content: Buffer.from(JSON.stringify(content[revision][name])).toString("base64") }
      }
      return pr
    },
  }
  return { pr, files, run, writes, content, options }
}

test("starts CI only for the exact version-only release PR", async () => {
  const data = fixture()
  await startReleaseChecks(data.options)
  assert.deepEqual(data.writes, [`repos/${repository}/actions/runs/123/approve`])
})

for (const [name, tamper] of [
  ["source change", data => { data.files[0].filename = "src/app.mjs" }],
  ["missing lockfile", data => { data.files.pop(); data.pr.changed_files = 1 }],
  ["different branch", data => { data.pr.head.ref = "automation/release-v1.2.4" }],
  ["different base", data => { data.pr.base.sha = "c".repeat(40) }],
  ["different author", data => { data.pr.user.login = "maintainer" }],
  ["different package version", data => { data.content.head["package.json"].version = "1.2.4" }],
  ["extra package change", data => { data.content.head["package.json"].private = false }],
]) {
  test(`refuses ${name} without approving checks`, async () => {
    const data = fixture()
    tamper(data)
    await assert.rejects(startReleaseChecks(data.options))
    assert.deepEqual(data.writes, [])
  })
}

test("command exposes help and rejects missing workflow context", async () => {
  const script = new URL("../scripts/start-release-checks.mjs", import.meta.url).pathname
  assert.match((await execute(process.execPath, [script, "--help"])).stdout, /version-only release PR/u)
  await assert.rejects(execute(process.execPath, [script, "42"], { env: {} }), error => error.code === 2 && /GH_TOKEN is required/u.test(error.stderr))
})
