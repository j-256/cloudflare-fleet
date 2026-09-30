import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import path from "node:path"
import { isDeepStrictEqual, promisify } from "node:util"

import { CliUsageError, parseCliOptions } from "../src/cli-options.mjs"
import { isMainModule } from "../src/entrypoint.mjs"
import { MAX_RELEASE_INPUT_BYTES, readRegularReleaseFile } from "../src/release-files.mjs"
import { RELEASE_VERSION_PATTERN, releaseHash } from "../src/self-hosted-release.mjs"
import { compareReleaseVersions } from "./prepare-release.mjs"

const executeFile = promisify(execFile)
const SOURCE_PATTERN = /^[a-f0-9]{40}$/u
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u
const RUN_ID_PATTERN = /^[1-9][0-9]*$/u
const API_TIMEOUT_MS = 30_000
const MAX_API_BYTES = 64 * 1024 * 1024
const RELEASE_PAGE_SIZE = 100
const MAX_RELEASE_PAGES = 10
const AUTOMATION_ACTOR = "github-actions[bot]"

export class ReleasePublicationError extends Error {
  constructor(message, code = "validation-failed", details = {}) {
    super(message)
    this.name = "ReleasePublicationError"
    this.code = code
    this.details = details
  }
}

function contentType(name) {
  return name.endsWith(".sha256") ? "text/plain" : "application/gzip"
}

async function archiveJson(file, member, execute = executeFile) {
  try {
    const { stdout } = await execute("tar", ["-xOf", file, member], { timeout: API_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 })
    return JSON.parse(stdout.toString("utf8"))
  } catch (error) {
    if (error.code === "ENOENT") throw error
    throw new ReleasePublicationError(`Release archive metadata is missing or malformed: ${member}`, "artifact-invalid")
  }
}

export async function inspectReleaseArtifacts(directory, expectedSourceRevision, dependencies = {}) {
  if (!SOURCE_PATTERN.test(expectedSourceRevision || "")) throw new CliUsageError("--source requires a complete lowercase commit SHA")
  const entries = await fs.readdir(directory, { withFileTypes: true })
  if (!entries.every(entry => entry.isFile() && !entry.isSymbolicLink())) throw new ReleasePublicationError("Release artifacts must be bounded regular files", "artifact-invalid")
  const archiveMatches = entries.map(entry => entry.name).filter(name => /^cloudflare-fleet-(.+)-self-hosted\.tgz$/u.test(name))
  if (archiveMatches.length !== 1) throw new ReleasePublicationError("Expected exactly one self-hosting archive", "artifact-invalid")
  const version = archiveMatches[0].match(/^cloudflare-fleet-(.+)-self-hosted\.tgz$/u)[1]
  if (!RELEASE_VERSION_PATTERN.test(version)) throw new ReleasePublicationError("Artifact filename does not contain a valid release version", "artifact-invalid")
  const archiveName = `cloudflare-fleet-${version}-self-hosted.tgz`
  const checksumName = `${archiveName}.sha256`
  const packageName = `cloudflare-fleet-${version}.tgz`
  const expectedNames = [archiveName, checksumName, packageName].sort()
  const names = entries.map(entry => entry.name).sort()
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) throw new ReleasePublicationError("Release artifact set contains missing or unexpected files", "artifact-invalid", { expectedNames, names })
  const contents = new Map()
  for (const name of names) {
    const limit = name.endsWith(".sha256") ? 1024 : MAX_RELEASE_INPUT_BYTES
    contents.set(name, (await readRegularReleaseFile(path.join(directory, name), limit, dependencies)).content)
  }
  const archiveHash = releaseHash(contents.get(archiveName))
  if (contents.get(checksumName).toString("utf8") !== `${archiveHash}  ${archiveName}\n`) {
    throw new ReleasePublicationError("Self-hosting archive checksum differs", "artifact-invalid")
  }
  const run = dependencies.execute ?? executeFile
  const manifest = await archiveJson(path.join(directory, archiveName), "package/release-manifest.json", run)
  const identity = await archiveJson(path.join(directory, archiveName), "package/release-identity.json", run)
  const metadata = await archiveJson(path.join(directory, archiveName), "package/package.json", run)
  const lock = await archiveJson(path.join(directory, archiveName), "package/package-lock.json", run)
  const packedMetadata = await archiveJson(path.join(directory, packageName), "package/package.json", run)
  if (manifest.version !== version || identity.version !== version || metadata.version !== version || lock.version !== version
    || lock.packages?.[""]?.version !== version || packedMetadata.version !== version || packedMetadata.name !== "cloudflare-fleet") {
    throw new ReleasePublicationError("Release artifact versions do not agree", "artifact-invalid")
  }
  if (manifest.sourceRevision !== expectedSourceRevision || identity.sourceRevision !== expectedSourceRevision
    || manifest.releaseId !== identity.releaseId) {
    throw new ReleasePublicationError("Release artifact source or content identity differs from the verified CI revision", "artifact-invalid")
  }
  return {
    version,
    tag: `v${version}`,
    sourceRevision: expectedSourceRevision,
    releaseId: identity.releaseId,
    assets: names.map(name => ({
      name,
      file: path.join(directory, name),
      size: contents.get(name).length,
      sha256: releaseHash(contents.get(name)),
      contentType: contentType(name),
      content: contents.get(name),
    })),
  }
}

export class GitHubReleaseApi {
  constructor({ repository, token, apiUrl = "https://api.github.com", fetchImpl = globalThis.fetch }) {
    if (!REPOSITORY_PATTERN.test(repository || "")) throw new CliUsageError("GITHUB_REPOSITORY must be owner/name")
    if (!token) throw new CliUsageError("GH_TOKEN is required")
    this.repository = repository
    this.token = token
    this.apiUrl = apiUrl.replace(/\/$/u, "")
    this.fetchImpl = fetchImpl
  }

  url(resource) {
    return resource.startsWith("https://") ? resource : `${this.apiUrl}/repos/${this.repository}/${resource}`
  }

  async response(resource, { method = "GET", body, headers = {}, allowNotFound = false } = {}) {
    let response
    try {
      response = await this.fetchImpl(this.url(resource), {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body && !Buffer.isBuffer(body) ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
        redirect: "follow",
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      })
    } catch {
      throw new ReleasePublicationError("GitHub request failed before a response; inspect release state before retrying", method === "GET" ? "github-read-failed" : "github-write-uncertain")
    }
    if (allowNotFound && response.status === 404) return null
    if (!response.ok) throw new ReleasePublicationError(`GitHub ${method} request returned HTTP ${response.status}`, method === "GET" ? "github-read-failed" : "github-write-uncertain", { httpStatus: response.status })
    return response
  }

  async json(resource, options) {
    const response = await this.response(resource, options)
    return response ? response.json() : null
  }

  async bytes(resource, options) {
    const response = await this.response(resource, options)
    if (Number(response.headers.get("content-length") || 0) > MAX_API_BYTES) throw new ReleasePublicationError("Published asset exceeds the verification size limit", "published-asset-invalid")
    const content = Buffer.from(await response.arrayBuffer())
    if (content.length > MAX_API_BYTES) throw new ReleasePublicationError("Published asset exceeds the verification size limit", "published-asset-invalid")
    return content
  }

  async upload(uploadUrl, asset) {
    const url = `${uploadUrl.replace(/\{.*$/u, "")}?name=${encodeURIComponent(asset.name)}`
    return this.json(url, {
      method: "POST",
      body: asset.content,
      headers: { "Content-Type": asset.contentType, "Content-Length": String(asset.size) },
    })
  }
}

function decodeContent(response, label) {
  if (response?.encoding !== "base64" || typeof response.content !== "string") throw new ReleasePublicationError(`Cannot read ${label} at the verified revision`, "source-invalid")
  try {
    return JSON.parse(Buffer.from(response.content.replaceAll("\n", ""), "base64").toString("utf8"))
  } catch {
    throw new ReleasePublicationError(`${label} is not valid JSON at the verified revision`, "source-invalid")
  }
}

export async function inspectReleaseCandidate(api, runId, sourceRevision) {
  if (!SOURCE_PATTERN.test(sourceRevision || "")) throw new CliUsageError("--source requires a complete lowercase commit SHA")
  if (!RUN_ID_PATTERN.test(String(runId || ""))) throw new CliUsageError("--run-id requires a positive workflow run ID")
  const run = await api.json(`actions/runs/${runId}`)
  if (run.name !== "CI" || run.path !== ".github/workflows/ci.yml" || run.event !== "push" || run.conclusion !== "success"
    || run.head_branch !== "main" || run.head_sha !== sourceRevision || run.head_repository?.full_name !== api.repository) {
    throw new ReleasePublicationError("Release source is not the exact successful main CI run", "source-invalid")
  }
  const comparison = await api.json(`compare/${sourceRevision}...main`)
  if (!["ahead", "identical"].includes(comparison.status)) throw new ReleasePublicationError("Verified release source is no longer contained in main", "source-invalid")
  const metadata = decodeContent(await api.json(`contents/package.json?ref=${sourceRevision}`), "package.json")
  const lock = decodeContent(await api.json(`contents/package-lock.json?ref=${sourceRevision}`), "package-lock.json")
  const version = metadata.version
  if (!RELEASE_VERSION_PATTERN.test(version || "") || lock.version !== version || lock.packages?.[""]?.version !== version) {
    throw new ReleasePublicationError("Verified source package versions do not agree", "source-invalid")
  }
  const commit = await api.json(`commits/${sourceRevision}`)
  const parent = commit.parents?.[0]?.sha
  if (!SOURCE_PATTERN.test(parent || "")) throw new ReleasePublicationError("Verified source has no release baseline parent", "source-invalid")
  const previousMetadata = decodeContent(await api.json(`contents/package.json?ref=${parent}`), "parent package.json")
  const previous = previousMetadata.version
  if (previous === version) return { candidate: false, reason: "package-version-unchanged", version, previousVersion: previous, sourceRevision }
  const previousLock = decodeContent(await api.json(`contents/package-lock.json?ref=${parent}`), "parent package-lock.json")
  if (!RELEASE_VERSION_PATTERN.test(previous || "") || previousLock.version !== previous
    || previousLock.packages?.[""]?.version !== previous || compareReleaseVersions(version, previous) <= 0) {
    throw new ReleasePublicationError(`Release version ${version} is not newer than ${previous}`, "source-invalid")
  }
  const change = await api.json(`compare/${parent}...${sourceRevision}`)
  const files = (change.files || []).map(file => [file.filename, file.status]).sort(([left], [right]) => left.localeCompare(right, "en"))
  const expected = [["package-lock.json", "modified"], ["package.json", "modified"]]
  if (JSON.stringify(files) !== JSON.stringify(expected)) throw new ReleasePublicationError("Release candidate commit changes more than the package version files", "source-invalid", { files })
  previousMetadata.version = version
  previousLock.version = version
  previousLock.packages[""].version = version
  if (!isDeepStrictEqual(metadata, previousMetadata) || !isDeepStrictEqual(lock, previousLock)) {
    throw new ReleasePublicationError("Release candidate changes more than the package version fields", "source-invalid")
  }
  const pullRequests = await api.json(`commits/${sourceRevision}/pulls`)
  const expectedBranch = `automation/release-v${version}`
  const releasePullRequests = Array.isArray(pullRequests) ? pullRequests.filter(pr => pr.merged_at
    && pr.base?.ref === "main" && pr.base?.repo?.full_name === api.repository
    && pr.head?.ref === expectedBranch && pr.head?.repo?.full_name === api.repository
    && pr.user?.login === AUTOMATION_ACTOR) : []
  if (releasePullRequests.length !== 1) {
    throw new ReleasePublicationError("Release source is not the unique merged automation pull request", "source-invalid")
  }
  return {
    candidate: true,
    reason: "package-version-increased",
    version,
    previousVersion: previous,
    sourceRevision,
    parentRevision: parent,
    pullRequestNumber: releasePullRequests[0].number,
  }
}

async function requireAnnotatedTag(api, artifact) {
  const refs = await api.json(`git/matching-refs/tags/${artifact.tag}`)
  const exact = refs.filter(entry => entry.ref === `refs/tags/${artifact.tag}`)
  if (exact.length > 1) throw new ReleasePublicationError("GitHub returned duplicate exact release refs", "tag-conflict")
  if (exact.length === 0) {
    const tag = await api.json("git/tags", {
      method: "POST",
      body: { tag: artifact.tag, message: `Cloudflare Fleet ${artifact.tag}\n`, object: artifact.sourceRevision, type: "commit" },
    })
    await api.json("git/refs", { method: "POST", body: { ref: `refs/tags/${artifact.tag}`, sha: tag.sha } })
    return { created: true, objectSha: tag.sha }
  }
  if (exact[0].object?.type !== "tag") throw new ReleasePublicationError("Existing release tag is not annotated", "tag-conflict")
  const tag = await api.json(`git/tags/${exact[0].object.sha}`)
  if (tag.tag !== artifact.tag || tag.object?.type !== "commit" || tag.object.sha !== artifact.sourceRevision) {
    throw new ReleasePublicationError("Existing release tag points to a different source revision", "tag-conflict")
  }
  return { created: false, objectSha: exact[0].object.sha }
}

async function releaseAssets(api, release) {
  const response = await api.response(`releases/${release.id}/assets?per_page=100`)
  if ((response.headers.get("link") || "").includes('rel="next"')) throw new ReleasePublicationError("Release contains too many assets to verify safely", "published-asset-invalid")
  return response.json()
}

async function verifyRemoteAssets(api, release, artifacts) {
  const assets = await releaseAssets(api, release)
  const expected = new Map(artifacts.map(asset => [asset.name, asset]))
  if (assets.length !== expected.size || assets.some(asset => !expected.has(asset.name))) {
    throw new ReleasePublicationError("GitHub Release contains missing or unexpected assets", "published-asset-invalid", {
      expected: [...expected.keys()].sort(), actual: assets.map(asset => asset.name).sort(),
    })
  }
  const verified = []
  for (const remote of assets.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const local = expected.get(remote.name)
    if (remote.size !== local.size || remote.state !== "uploaded") throw new ReleasePublicationError(`Published asset metadata differs: ${remote.name}`, "published-asset-invalid")
    const content = await api.bytes(remote.url, { headers: { Accept: "application/octet-stream" } })
    const sha256 = createHash("sha256").update(content).digest("hex")
    if (content.length !== local.size || sha256 !== local.sha256) throw new ReleasePublicationError(`Published asset bytes differ: ${remote.name}`, "published-asset-invalid")
    verified.push({ name: remote.name, size: local.size, sha256 })
  }
  return verified
}

async function findRelease(api, tag) {
  const published = await api.json(`releases/tags/${tag}`, { allowNotFound: true })
  if (published) return published
  let match = null
  for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
    const response = await api.response(`releases?per_page=${RELEASE_PAGE_SIZE}&page=${page}`)
    const releases = await response.json()
    if (!Array.isArray(releases)) throw new ReleasePublicationError("GitHub returned an invalid release listing", "github-read-failed")
    const matches = releases.filter(release => release.tag_name === tag)
    if (matches.length > 1 || matches.length === 1 && match) throw new ReleasePublicationError("GitHub returned duplicate releases for the tag", "release-conflict")
    if (matches.length === 1) match = matches[0]
    if (!(response.headers.get("link") || "").includes('rel="next"')) return match
  }
  throw new ReleasePublicationError("Release history exceeds the bounded draft search", "release-conflict")
}

async function prepareDraft(api, artifact) {
  let release = await findRelease(api, artifact.tag)
  if (release && (release.tag_name !== artifact.tag || release.prerelease)) throw new ReleasePublicationError("Existing GitHub Release metadata conflicts with this release", "release-conflict")
  if (!release) {
    release = await api.json("releases", {
      method: "POST",
      body: { tag_name: artifact.tag, target_commitish: artifact.sourceRevision, name: artifact.tag, draft: true, prerelease: false, generate_release_notes: true },
    })
  }
  if (!release.draft) {
    const assets = await verifyRemoteAssets(api, release, artifact.assets)
    return { release, assets, alreadyPublished: true }
  }
  const existing = await releaseAssets(api, release)
  const expected = new Map(artifact.assets.map(asset => [asset.name, asset]))
  if (existing.some(asset => !expected.has(asset.name))) throw new ReleasePublicationError("Draft release contains an unexpected asset", "release-conflict")
  for (const remote of existing) {
    const local = expected.get(remote.name)
    const content = await api.bytes(remote.url, { headers: { Accept: "application/octet-stream" } })
    if (remote.size !== local.size || releaseHash(content) !== local.sha256) throw new ReleasePublicationError(`Draft release asset differs: ${remote.name}`, "release-conflict")
    expected.delete(remote.name)
  }
  for (const asset of expected.values()) await api.upload(release.upload_url, asset)
  const assets = await verifyRemoteAssets(api, release, artifact.assets)
  release = await api.json(`releases/${release.id}`, { method: "PATCH", body: { draft: false } })
  if (release.draft || release.tag_name !== artifact.tag) throw new ReleasePublicationError("GitHub Release did not become public", "release-verification-failed")
  return { release, assets, alreadyPublished: false }
}

export async function publishRelease({ directory, sourceRevision, runId, api, inspect = inspectReleaseArtifacts, onProgress = () => {} }) {
  const requestId = randomUUID()
  const checks = []
  const stage = async (name, operation) => {
    const started = Date.now()
    onProgress({ requestId, stage: name, status: "started" })
    try {
      const result = await operation()
      const record = { requestId, stage: name, status: "pass", elapsedMs: Date.now() - started }
      checks.push(record)
      onProgress(record)
      return result
    } catch (error) {
      const record = { requestId, stage: name, status: "fail", code: error.code || "validation-failed", elapsedMs: Date.now() - started }
      onProgress(record)
      if (error instanceof ReleasePublicationError || error instanceof CliUsageError) throw error
      throw new ReleasePublicationError("Release publication failed; inspect the tag, draft, and assets before retrying", "publication-failed")
    }
  }
  const candidate = await stage("source.verified-main-ci", () => inspectReleaseCandidate(api, runId, sourceRevision))
  if (!candidate.candidate) throw new ReleasePublicationError("Selected main CI run does not introduce a release version", "not-a-release-candidate", candidate)
  const artifact = await stage("artifact.integrity", () => inspect(directory, sourceRevision))
  if (artifact.version !== candidate.version) throw new ReleasePublicationError("Release artifact version differs from the verified source", "artifact-invalid")
  const tag = await stage("tag.annotated-exact-source", () => requireAnnotatedTag(api, artifact))
  const published = await stage("release.stage-verify-publish", () => prepareDraft(api, artifact))
  const finalRelease = await stage("release.final-state", async () => {
    const release = await api.json(`releases/tags/${artifact.tag}`)
    if (release.draft || release.prerelease || release.tag_name !== artifact.tag) throw new ReleasePublicationError("Published GitHub Release metadata differs", "release-verification-failed")
    const assets = await verifyRemoteAssets(api, release, artifact.assets)
    return { release, assets }
  })
  return {
    requestId,
    status: published.alreadyPublished ? "verified" : "published",
    version: artifact.version,
    tag: artifact.tag,
    sourceRevision: artifact.sourceRevision,
    releaseId: artifact.releaseId,
    tagCreated: tag.created,
    url: finalRelease.release.html_url,
    assets: finalRelease.assets,
    checks,
  }
}

export function publishReleaseUsage() {
  return [
    "Usage: publish-release.mjs --directory DIRECTORY --source SHA --run-id ID",
    "       publish-release.mjs --check-candidate --source SHA --run-id ID",
    "Publish the exact verified artifact from one successful protected-main CI run.",
    "  -d, --directory DIRECTORY  Downloaded self-hosted-release artifact directory",
    "  -s, --source SHA           Exact source revision from the triggering CI run",
    "  -R, --run-id ID            Exact successful CI workflow run ID",
    "      --check-candidate       Report whether the source is a version-only release commit",
    "  -h, --help                 Show this help",
    "Requires Node.js, tar, GH_TOKEN, and GITHUB_REPOSITORY. GITHUB_API_URL is optional.",
    "Creates only an annotated tag, resumable draft, exact asset uploads, and final publication.",
    "JSON result goes to stdout; correlation and stage diagnostics go to stderr.",
    "Exit: 0 published/verified/help, 1 validation or uncertain write, 2 usage, 3 missing dependency.",
  ].join("\n")
}

if (isMainModule(import.meta.url)) {
  try {
    const options = parseCliOptions(process.argv.slice(2), [
      { name: "help", short: "h", value: false },
      { name: "directory", short: "d", value: true },
      { name: "source", short: "s", value: true },
      { name: "run-id", key: "runId", short: "R", value: true },
      { name: "check-candidate", key: "checkCandidate", value: false },
    ])
    if (options.help) console.log(publishReleaseUsage())
    else {
      if (!options.source || !options.runId || (!options.checkCandidate && !options.directory) || (options.checkCandidate && options.directory)) {
        throw new CliUsageError("Select --check-candidate, or provide --directory for publication; --source and --run-id are always required")
      }
      const api = new GitHubReleaseApi({
        repository: process.env.GITHUB_REPOSITORY,
        token: process.env.GH_TOKEN,
        apiUrl: process.env.GITHUB_API_URL,
      })
      if (options.checkCandidate) console.log(JSON.stringify(await inspectReleaseCandidate(api, options.runId, options.source)))
      else {
        console.log(JSON.stringify(await publishRelease({
          directory: path.resolve(options.directory), sourceRevision: options.source, runId: options.runId, api,
          onProgress: record => console.error(JSON.stringify(record)),
        })))
      }
    }
  } catch (error) {
    console.error(JSON.stringify({ status: "failed", code: error.code || "publication-failed", detail: error.message, ...(error.details ? { details: error.details } : {}) }))
    process.exitCode = error instanceof CliUsageError ? 2 : error.code === "ENOENT" ? 3 : 1
  }
}
