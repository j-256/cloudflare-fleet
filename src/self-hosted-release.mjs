import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"

export const RELEASE_MANIFEST = "release-manifest.json"
export const RELEASE_IDENTITY = "release-identity.json"
export const RELEASE_SCHEMA_VERSION = 1
export const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const SOURCE_PATTERN = /^[a-f0-9]{40}$/
const MAX_RELEASE_FILES = 2000
const MAX_RELEASE_FILE_BYTES = 20 * 1024 * 1024
const MAX_RELEASE_TOTAL_BYTES = 64 * 1024 * 1024
const MUTABLE_ROOTS = new Set(["node_modules", ".worker-assets", ".wrangler"])
const MUTABLE_FILES = new Set(["wrangler.jsonc", ".dev.vars", ".dev.vars.production", ".DS_Store"])

export function releaseHash(value) {
  return createHash("sha256").update(value).digest("hex")
}

export function releaseContentId({ version, sourceRevision, files }) {
  const content = Object.fromEntries(Object.entries(files)
    .filter(([file]) => file !== RELEASE_IDENTITY)
    .sort(([left], [right]) => left.localeCompare(right, "en")))
  return releaseHash(JSON.stringify({ version, sourceRevision, files: content }))
}

export function releasePathIsSafe(file) {
  return typeof file === "string" && file.length <= 200
    && /^[A-Za-z0-9_.\/-]+$/.test(file) && !path.posix.isAbsolute(file)
    && file.split("/").every((part) => part && part !== "." && part !== "..")
    && !file.startsWith(".env") && !file.startsWith(".dev.vars")
    && !["node_modules", ".git", ".worker-assets", ".wrangler", "test", "test-results"].includes(file.split("/")[0])
    && !["wrangler.jsonc", "fleet-policy.json", "state.json", "AGENTS.md", "CLAUDE.md"].includes(file)
}

async function regularFile(root, relative) {
  let current = root
  for (const part of relative.split("/")) {
    current = path.join(current, part)
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Release contains a symbolic link: ${relative}`)
  }
  const metadata = await fs.stat(current)
  if (!metadata.isFile() || metadata.size > MAX_RELEASE_FILE_BYTES) throw new Error(`Release file is invalid or too large: ${relative}`)
  return fs.readFile(current)
}

async function additionalFiles(root, files, relative = "") {
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const file = relative ? `${relative}/${entry.name}` : entry.name
    if (!relative && (MUTABLE_ROOTS.has(entry.name) || MUTABLE_FILES.has(entry.name))) continue
    if (file === RELEASE_MANIFEST) continue
    if (entry.isSymbolicLink()) throw new Error(`Release contains an unexpected symbolic link: ${file}`)
    if (entry.isDirectory()) await additionalFiles(root, files, file)
    else if (!Object.hasOwn(files, file)) throw new Error(`Release contains an unlisted file: ${file}`)
  }
}

export async function inspectSelfHostedRelease(root, expectedVersion) {
  if (!RELEASE_VERSION_PATTERN.test(expectedVersion || "")) throw new Error("Select an explicit package version, such as --version 1.2.3")
  const resolved = await fs.realpath(root)
  let manifest
  try { manifest = JSON.parse(await regularFile(resolved, RELEASE_MANIFEST)) } catch {
    throw new Error("A complete self-hosting archive with release-manifest.json is required; a CLI-only package or source checkout is not that archive")
  }
  if (manifest.schemaVersion !== RELEASE_SCHEMA_VERSION || manifest.version !== expectedVersion
    || manifest.sourceRevision !== null && !SOURCE_PATTERN.test(manifest.sourceRevision)
    || !HASH_PATTERN.test(manifest.releaseId || "") || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)
    || Object.keys(manifest.files).length > MAX_RELEASE_FILES) throw new Error("Release manifest or selected version does not match")
  for (const required of ["package.json", "package-lock.json", RELEASE_IDENTITY, "src/cli.mjs", "src/hosted/worker.mjs", "scripts/build-worker-assets.mjs"]) {
    if (!Object.hasOwn(manifest.files, required)) throw new Error(`Release is missing required file: ${required}`)
  }
  let totalBytes = 0
  for (const [file, hash] of Object.entries(manifest.files)) {
    if (!releasePathIsSafe(file) || !HASH_PATTERN.test(hash)) throw new Error("Release manifest contains an unsafe path or invalid checksum")
    const content = await regularFile(resolved, file)
    totalBytes += content.length
    if (totalBytes > MAX_RELEASE_TOTAL_BYTES) throw new Error("Release content exceeds the verification size limit")
    if (releaseHash(content) !== hash) throw new Error(`Release file checksum changed: ${file}`)
  }
  await additionalFiles(resolved, manifest.files)
  if (releaseContentId(manifest) !== manifest.releaseId) throw new Error("Release content identity does not match")
  const identity = JSON.parse(await regularFile(resolved, RELEASE_IDENTITY))
  if (identity.schemaVersion !== RELEASE_SCHEMA_VERSION || identity.releaseId !== manifest.releaseId || identity.version !== manifest.version
    || identity.sourceRevision !== manifest.sourceRevision) throw new Error("Bundled server identity does not match the release")
  const metadata = JSON.parse(await regularFile(resolved, "package.json"))
  const lock = JSON.parse(await regularFile(resolved, "package-lock.json"))
  if (metadata.version !== manifest.version || lock.version !== manifest.version
    || lock.packages?.[""]?.version !== manifest.version
    || !RELEASE_VERSION_PATTERN.test(metadata.devDependencies?.wrangler || "")
    || metadata.devDependencies.wrangler !== lock.packages?.[""]?.devDependencies?.wrangler
    || metadata.devDependencies.wrangler !== lock.packages?.["node_modules/wrangler"]?.version) throw new Error("Release package and dependency lock do not match")
  return { schemaVersion: identity.schemaVersion, version: identity.version, sourceRevision: identity.sourceRevision, releaseId: identity.releaseId,
    root: resolved, wranglerVersion: metadata.devDependencies.wrangler,
    migrations: Object.keys(manifest.files).filter((file) => /^migrations\/[^/]+\.sql$/.test(file)).map((file) => file.slice("migrations/".length)).sort(),
    provenance: manifest.sourceRevision ? "committed-source" : "development", verifiedFiles: Object.keys(manifest.files).length }
}
