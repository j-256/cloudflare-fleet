import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { test } from "node:test"

import { inspectReleaseArtifacts, inspectReleaseCandidate, publishRelease } from "../scripts/publish-release.mjs"
import { releaseHash } from "../src/self-hosted-release.mjs"

const execute = promisify(execFile)
const sourceRevision = "a".repeat(40)
const parentRevision = "d".repeat(40)
const repository = "owner/project"
const version = "1.2.3"
const previousVersion = "1.2.2"

async function artifactFixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-publish-artifact-"))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const hostedRoot = path.join(root, "hosted", "package")
  const cliRoot = path.join(root, "cli", "package")
  const output = path.join(root, "artifacts")
  await fs.mkdir(hostedRoot, { recursive: true })
  await fs.mkdir(cliRoot, { recursive: true })
  await fs.mkdir(output)
  const identity = { schemaVersion: 1, version, sourceRevision, releaseId: "b".repeat(64) }
  const metadata = { name: "cloudflare-fleet", version, private: true }
  const lock = { name: "cloudflare-fleet", version, packages: { "": { name: "cloudflare-fleet", version } } }
  await fs.writeFile(path.join(hostedRoot, "release-manifest.json"), JSON.stringify({ ...identity, files: {} }))
  await fs.writeFile(path.join(hostedRoot, "release-identity.json"), JSON.stringify(identity))
  await fs.writeFile(path.join(hostedRoot, "package.json"), JSON.stringify(metadata))
  await fs.writeFile(path.join(hostedRoot, "package-lock.json"), JSON.stringify(lock))
  await fs.writeFile(path.join(cliRoot, "package.json"), JSON.stringify(metadata))
  const archiveName = `cloudflare-fleet-${version}-self-hosted.tgz`
  const packageName = `cloudflare-fleet-${version}.tgz`
  await execute("tar", ["-czf", path.join(output, archiveName), "-C", path.dirname(hostedRoot), "package"])
  await execute("tar", ["-czf", path.join(output, packageName), "-C", path.dirname(cliRoot), "package"])
  const archive = await fs.readFile(path.join(output, archiveName))
  await fs.writeFile(path.join(output, `${archiveName}.sha256`), `${releaseHash(archive)}  ${archiveName}\n`)
  return output
}

function encoded(value) {
  return { encoding: "base64", content: Buffer.from(JSON.stringify(value)).toString("base64") }
}

class MockGitHubApi {
  constructor(artifact) {
    this.repository = repository
    this.artifact = artifact
    this.tag = null
    this.release = null
    this.assets = []
    this.calls = []
  }

  async json(resource, options = {}) {
    this.calls.push([options.method || "GET", resource])
    if (resource === "actions/runs/123") return {
      name: "CI", path: ".github/workflows/ci.yml", event: "push", conclusion: "success",
      head_branch: "main", head_sha: sourceRevision, head_repository: { full_name: repository },
    }
    if (resource === `compare/${sourceRevision}...main`) return { status: "identical" }
    if (resource === `compare/${parentRevision}...${sourceRevision}`) return { files: [
      { filename: "package-lock.json", status: "modified" },
      { filename: "package.json", status: "modified" },
    ] }
    if (resource === `commits/${sourceRevision}`) return { parents: [{ sha: parentRevision }] }
    if (resource === `commits/${sourceRevision}/pulls`) return [{
      number: 42,
      merged_at: "2026-09-30T00:00:00Z",
      base: { ref: "main", repo: { full_name: repository } },
      head: { ref: `automation/release-v${version}`, repo: { full_name: repository } },
      user: { login: "github-actions[bot]" },
    }]
    if (resource === `contents/package.json?ref=${parentRevision}`) return encoded({ name: "cloudflare-fleet", version: previousVersion, private: true })
    if (resource === `contents/package-lock.json?ref=${parentRevision}`) return encoded({ name: "cloudflare-fleet", version: previousVersion, packages: { "": { name: "cloudflare-fleet", version: previousVersion } } })
    if (resource.startsWith("contents/package.json")) return encoded({ name: "cloudflare-fleet", version, private: true })
    if (resource.startsWith("contents/package-lock.json")) return encoded({ name: "cloudflare-fleet", version, packages: { "": { name: "cloudflare-fleet", version } } })
    if (resource.startsWith("git/matching-refs/")) return this.tag ? [{ ref: `refs/tags/${this.artifact.tag}`, object: { type: "tag", sha: this.tag.sha } }] : []
    if (resource === "git/tags" && options.method === "POST") {
      this.tag = { sha: "c".repeat(40), tag: options.body.tag, object: { type: "commit", sha: options.body.object } }
      return this.tag
    }
    if (resource === "git/refs" && options.method === "POST") return { ref: options.body.ref }
    if (resource.startsWith("git/tags/")) return this.tag
    if (resource === `releases/tags/${this.artifact.tag}`) return this.release?.draft ? null : this.release
    if (resource === "releases" && options.method === "POST") {
      this.release = { id: 7, tag_name: this.artifact.tag, draft: true, prerelease: false, upload_url: "https://uploads.example/releases/7/assets{?name,label}", html_url: "https://example.test/release" }
      return this.release
    }
    if (resource === "releases/7" && options.method === "PATCH") {
      this.release = { ...this.release, draft: false }
      return this.release
    }
    throw new Error(`Unexpected JSON request: ${resource}`)
  }

  async response(resource) {
    this.calls.push(["GET", resource])
    if (resource === "releases?per_page=100&page=1") {
      return { headers: new Headers(), json: async () => this.release ? [this.release] : [] }
    }
    if (resource !== "releases/7/assets?per_page=100") throw new Error(`Unexpected response request: ${resource}`)
    return { headers: new Headers(), json: async () => this.assets }
  }

  async bytes(resource) {
    const asset = this.assets.find(candidate => candidate.url === resource)
    if (!asset) throw new Error(`Unexpected asset request: ${resource}`)
    return asset.content
  }

  async upload(_url, asset) {
    this.calls.push(["UPLOAD", asset.name])
    this.assets.push({ id: this.assets.length + 1, name: asset.name, size: asset.size, state: "uploaded", url: `https://api.example/assets/${this.assets.length + 1}`, content: asset.content })
  }
}

test("inspects the exact artifact set and source identity", async context => {
  const directory = await artifactFixture(context)
  const artifact = await inspectReleaseArtifacts(directory, sourceRevision)
  assert.equal(artifact.version, version)
  assert.equal(artifact.tag, `v${version}`)
  assert.equal(artifact.sourceRevision, sourceRevision)
  assert.deepEqual(artifact.assets.map(asset => asset.name), [
    `cloudflare-fleet-${version}-self-hosted.tgz`,
    `cloudflare-fleet-${version}-self-hosted.tgz.sha256`,
    `cloudflare-fleet-${version}.tgz`,
  ])
})

test("selects only a strictly newer version-only main commit", async context => {
  const directory = await artifactFixture(context)
  const artifact = await inspectReleaseArtifacts(directory, sourceRevision)
  const api = new MockGitHubApi(artifact)
  assert.deepEqual(await inspectReleaseCandidate(api, "123", sourceRevision), {
    candidate: true,
    reason: "package-version-increased",
    version,
    previousVersion: "1.2.2",
    sourceRevision,
    parentRevision,
    pullRequestNumber: 42,
  })
  const original = api.json.bind(api)
  api.json = async (resource, options) => resource === `contents/package.json?ref=${parentRevision}`
    ? encoded({ name: "cloudflare-fleet", version, private: true })
    : original(resource, options)
  assert.deepEqual(await inspectReleaseCandidate(api, "123", sourceRevision), {
    candidate: false,
    reason: "package-version-unchanged",
    version,
    previousVersion: version,
    sourceRevision,
  })
})

test("refuses a version change mixed with application changes", async context => {
  const directory = await artifactFixture(context)
  const artifact = await inspectReleaseArtifacts(directory, sourceRevision)
  const api = new MockGitHubApi(artifact)
  const original = api.json.bind(api)
  api.json = async (resource, options) => resource === `compare/${parentRevision}...${sourceRevision}`
    ? { files: [{ filename: "package.json", status: "modified" }, { filename: "src/app.mjs", status: "modified" }] }
    : original(resource, options)
  await assert.rejects(inspectReleaseCandidate(api, "123", sourceRevision), /changes more than/u)
})

test("refuses unrelated changes inside package metadata", async context => {
  const directory = await artifactFixture(context)
  const artifact = await inspectReleaseArtifacts(directory, sourceRevision)
  const api = new MockGitHubApi(artifact)
  const original = api.json.bind(api)
  api.json = async (resource, options) => resource === `contents/package.json?ref=${sourceRevision}`
    ? encoded({ name: "cloudflare-fleet", version, private: false })
    : original(resource, options)
  await assert.rejects(inspectReleaseCandidate(api, "123", sourceRevision), /version fields/u)
})

test("refuses a version-only commit outside the reviewed automation pull request", async context => {
  const directory = await artifactFixture(context)
  const artifact = await inspectReleaseArtifacts(directory, sourceRevision)
  const api = new MockGitHubApi(artifact)
  const original = api.json.bind(api)
  api.json = async (resource, options) => resource === `commits/${sourceRevision}/pulls` ? [] : original(resource, options)
  await assert.rejects(inspectReleaseCandidate(api, "123", sourceRevision), /merged automation pull request/u)
})

test("refuses unexpected files and changed archive bytes", async context => {
  const directory = await artifactFixture(context)
  await fs.writeFile(path.join(directory, "unexpected.txt"), "unexpected")
  await assert.rejects(inspectReleaseArtifacts(directory, sourceRevision), /missing or unexpected/u)
  await fs.rm(path.join(directory, "unexpected.txt"))
  await fs.appendFile(path.join(directory, `cloudflare-fleet-${version}-self-hosted.tgz`), "changed")
  await assert.rejects(inspectReleaseArtifacts(directory, sourceRevision), /checksum differs/u)
})

test("publishes an annotated tag only after verified CI and exact draft assets", async context => {
  const directory = await artifactFixture(context)
  const artifact = await inspectReleaseArtifacts(directory, sourceRevision)
  const api = new MockGitHubApi(artifact)
  const progress = []
  const result = await publishRelease({ directory, sourceRevision, runId: "123", api, onProgress: record => progress.push(record) })
  assert.equal(result.status, "published")
  assert.equal(result.tagCreated, true)
  assert.equal(result.url, "https://example.test/release")
  assert.equal(api.release.draft, false)
  assert.deepEqual(api.assets.map(asset => asset.name).sort(), artifact.assets.map(asset => asset.name).sort())
  assert.ok(progress.some(record => record.stage === "release.final-state" && record.status === "pass"))

  const repeated = await publishRelease({ directory, sourceRevision, runId: "123", api })
  assert.equal(repeated.status, "verified")
  assert.equal(repeated.tagCreated, false)
  assert.equal(api.calls.filter(([method]) => method === "UPLOAD").length, artifact.assets.length)
})

test("resumes an authenticated draft that tag lookup cannot return", async context => {
  const directory = await artifactFixture(context)
  const artifact = await inspectReleaseArtifacts(directory, sourceRevision)
  const api = new MockGitHubApi(artifact)
  api.release = { id: 7, tag_name: artifact.tag, draft: true, prerelease: false, upload_url: "https://uploads.example/releases/7/assets{?name,label}", html_url: "https://example.test/release" }
  const result = await publishRelease({ directory, sourceRevision, runId: "123", api })
  assert.equal(result.status, "published")
  assert.equal(api.calls.filter(([method, resource]) => method === "POST" && resource === "releases").length, 0)
})

test("fails closed before tagging an unverified workflow source", async context => {
  const directory = await artifactFixture(context)
  const artifact = await inspectReleaseArtifacts(directory, sourceRevision)
  const api = new MockGitHubApi(artifact)
  const original = api.json.bind(api)
  api.json = async (resource, options) => resource === "actions/runs/123" ? { ...(await original(resource, options)), event: "pull_request" } : original(resource, options)
  await assert.rejects(publishRelease({ directory, sourceRevision, runId: "123", api }), /exact successful main CI run/u)
  assert.equal(api.tag, null)
  assert.equal(api.release, null)
})

test("refuses a published release with changed asset bytes", async context => {
  const directory = await artifactFixture(context)
  const artifact = await inspectReleaseArtifacts(directory, sourceRevision)
  const api = new MockGitHubApi(artifact)
  await publishRelease({ directory, sourceRevision, runId: "123", api })
  api.assets[0].content = Buffer.alloc(api.assets[0].size, 1)
  await assert.rejects(publishRelease({ directory, sourceRevision, runId: "123", api }), /asset bytes differ/u)
})
