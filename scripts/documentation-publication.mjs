import { createHash } from "node:crypto"
import { constants as fsConstants, promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))

export const PROJECT_ROOT = path.dirname(MODULE_DIRECTORY)
export const DOCUMENTATION_SOURCE_ROOT = path.join(PROJECT_ROOT, "docs")
export const DOCUMENTATION_OUTPUT_ROOT = path.join(PROJECT_ROOT, "documentation-dist")
export const DOCUMENTATION_MANIFEST_FORMAT = "cloudflare-fleet.documentation.v1"
export const DOCUMENTATION_MANIFEST_PATH = "publication-manifest.json"
export const DOCUMENTATION_ASSETS_IGNORE_PATH = ".assetsignore"
export const DOCUMENTATION_SOURCE_PATHS = Object.freeze([
  "404.html",
  "architecture.html",
  "deployment.html",
  "diagrams/architecture.svg",
  "diagrams/intent-alignment.svg",
  "diagrams/write-flow.svg",
  "favicon.svg",
  "fixtures/observability-console-missing-outcome.json",
  "getting-started.html",
  "index.html",
  "screenshots/alignment-blocked.png",
  "screenshots/cover.png",
  "screenshots/dashboard-overview.png",
  "screenshots/fleet-intent.png",
  "screenshots/intent-alignment.png",
  "screenshots/mobile-dashboard.png",
  "screenshots/reviewed-write.png",
  "screenshots/worker-diagnostics.png",
  "security.html",
  "styles.css",
])

const DOCUMENTATION_MANIFEST_BYTE_LIMIT = 1024 * 1024
const DOCUMENTATION_OUTPUT_BYTE_LIMIT = 25 * 1024 * 1024
const DOCUMENTATION_REQUEST_TIMEOUT_MS = 15_000
const DOCUMENTATION_SOURCE_OPEN_FLAGS = typeof fsConstants.O_NOFOLLOW === "number"
  ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
  : "r"
const SHA256_PATTERN = /^[0-9a-f]{64}$/u

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    )
  }
  return value
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value))
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

export function documentationAssetsIgnore(sourcePaths = DOCUMENTATION_SOURCE_PATHS) {
  return [
    "*",
    "!*/",
    ...[...sourcePaths, DOCUMENTATION_MANIFEST_PATH]
      .sort()
      .map((file) => `!/${file}`),
    "",
  ].join("\n")
}

function assertObject(value, label) {
  invariant(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  )
}

function assertExactKeys(value, keys, label) {
  assertObject(value, label)
  invariant(
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()),
    `${label} fields are invalid`,
  )
}

function assertSafeRelativePath(value, label) {
  invariant(typeof value === "string" && value.length > 0, `${label} path is invalid`)
  invariant(!value.includes("\\") && !value.includes("\0"), `${label} path is unsafe`)
  invariant(!value.startsWith("/") && !value.startsWith("../"), `${label} path is unsafe`)
  invariant(!value.includes("?") && !value.includes("#"), `${label} path is unsafe`)
  invariant(path.posix.normalize(value) === value, `${label} path is not canonical`)
}

export function validateDocumentationManifest(manifest, options = {}) {
  assertExactKeys(manifest, ["format", "outputs", "package"], "documentation manifest")
  invariant(
    manifest.format === DOCUMENTATION_MANIFEST_FORMAT,
    "documentation manifest format is invalid",
  )
  assertExactKeys(manifest.package, ["name", "version"], "documentation package")
  invariant(
    manifest.package.name === "cloudflare-fleet",
    "documentation package name is invalid",
  )
  invariant(
    typeof manifest.package.version === "string" && manifest.package.version.length > 0,
    "documentation package version is invalid",
  )
  if (options.packageIdentity) {
    invariant(
      canonicalJson(manifest.package) === canonicalJson(options.packageIdentity),
      "documentation package identity is stale",
    )
  }
  invariant(
    Array.isArray(manifest.outputs) && manifest.outputs.length > 0,
    "documentation outputs are missing",
  )
  const outputPaths = []
  for (const output of manifest.outputs) {
    assertExactKeys(output, ["path", "sha256", "size"], "documentation output")
    assertSafeRelativePath(output.path, "documentation output")
    invariant(
      output.path !== DOCUMENTATION_MANIFEST_PATH,
      "documentation manifest cannot include itself as an output",
    )
    invariant(SHA256_PATTERN.test(output.sha256), "documentation output digest is invalid")
    invariant(
      Number.isSafeInteger(output.size)
        && output.size >= 0
        && output.size <= DOCUMENTATION_OUTPUT_BYTE_LIMIT,
      "documentation output size is invalid",
    )
    outputPaths.push(output.path)
  }
  invariant(
    new Set(outputPaths).size === outputPaths.length,
    "documentation output paths must be unique",
  )
  invariant(
    canonicalJson(outputPaths) === canonicalJson([...outputPaths].sort()),
    "documentation outputs must use canonical path order",
  )
  return {
    outputCount: manifest.outputs.length,
    packageName: manifest.package.name,
    version: manifest.package.version,
  }
}

async function packageIdentity(projectRoot) {
  const source = await fs.readFile(path.join(projectRoot, "package.json"), "utf8")
  const metadata = JSON.parse(source)
  return { name: metadata.name, version: metadata.version }
}

function localPath(root, relative) {
  return path.join(root, ...relative.split("/"))
}

async function readDocumentationSource(sourcePath, file) {
  let handle
  try {
    handle = await fs.open(sourcePath, DOCUMENTATION_SOURCE_OPEN_FLAGS)
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ELOOP") {
      throw new Error(`Documentation source has an unsupported entry: ${file}`)
    }
    throw error
  }
  try {
    const handleMetadata = await handle.stat()
    const source = await handle.readFile()
    const pathMetadata = await fs.lstat(sourcePath)
    invariant(
      handleMetadata.isFile()
        && pathMetadata.isFile()
        && !pathMetadata.isSymbolicLink()
        && handleMetadata.dev === pathMetadata.dev
        && handleMetadata.ino === pathMetadata.ino,
      `Documentation source has an unsupported entry: ${file}`,
    )
    return source
  } finally {
    await handle.close()
  }
}

export async function buildDocumentationArtifact(options = {}) {
  const projectRoot = options.projectRoot || PROJECT_ROOT
  const sourceRoot = options.sourceRoot || path.join(projectRoot, "docs")
  const outputRoot = options.outputRoot || path.join(projectRoot, "documentation-dist")
  const sourcePaths = options.sourcePaths || DOCUMENTATION_SOURCE_PATHS
  const stagingRoot = path.join(
    path.dirname(outputRoot),
    `.${path.basename(outputRoot)}.${process.pid}.tmp`,
  )
  await fs.rm(stagingRoot, { force: true, recursive: true })
  await fs.mkdir(stagingRoot, { recursive: true })
  try {
    invariant(
      Array.isArray(sourcePaths) && sourcePaths.length > 0,
      "documentation source paths are missing",
    )
    for (const file of sourcePaths) assertSafeRelativePath(file, "documentation source")
    const files = [...sourcePaths].sort()
    invariant(new Set(files).size === files.length, "documentation source paths must be unique")
    invariant(
      !files.includes(DOCUMENTATION_MANIFEST_PATH),
      `${DOCUMENTATION_MANIFEST_PATH} is reserved for the generated artifact`,
    )
    invariant(
      !files.includes(DOCUMENTATION_ASSETS_IGNORE_PATH),
      `${DOCUMENTATION_ASSETS_IGNORE_PATH} is reserved for the generated artifact`,
    )
    const outputs = []
    for (const file of files) {
      const sourcePath = localPath(sourceRoot, file)
      const source = await readDocumentationSource(sourcePath, file)
      const destination = localPath(stagingRoot, file)
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.writeFile(destination, source)
      outputs.push({ path: file, sha256: sha256(source), size: source.length })
    }
    const manifest = {
      format: DOCUMENTATION_MANIFEST_FORMAT,
      outputs,
      package: await packageIdentity(projectRoot),
    }
    validateDocumentationManifest(manifest, { packageIdentity: manifest.package })
    await fs.writeFile(
      path.join(stagingRoot, DOCUMENTATION_MANIFEST_PATH),
      `${JSON.stringify(manifest, null, 2)}\n`,
    )
    await fs.writeFile(
      path.join(stagingRoot, DOCUMENTATION_ASSETS_IGNORE_PATH),
      documentationAssetsIgnore(files),
    )
    await fs.rm(outputRoot, { force: true, recursive: true })
    await fs.rename(stagingRoot, outputRoot)
    return {
      manifest,
      manifestPath: path.join(outputRoot, DOCUMENTATION_MANIFEST_PATH),
      outputCount: outputs.length,
      outputRoot,
    }
  } finally {
    await fs.rm(stagingRoot, { force: true, recursive: true })
  }
}

export async function readDocumentationManifest(manifestPath) {
  let manifest
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"))
  } catch (error) {
    throw new Error(`Cannot read documentation manifest ${manifestPath}: ${error.message}`)
  }
  validateDocumentationManifest(manifest)
  return manifest
}

function documentationUrl(baseUrl, relative, cacheKey) {
  const base = new URL(baseUrl)
  invariant(base.protocol === "https:", "documentation URL must use HTTPS")
  invariant(!base.username && !base.password, "documentation URL cannot contain credentials")
  base.search = ""
  base.hash = ""
  if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`
  const url = new URL(relative, base)
  url.searchParams.set("publication", cacheKey)
  return url
}

async function fetchBytes(fetchImplementation, url, byteLimit, label, expectedStatus = 200) {
  const response = await fetchImplementation(url, {
    cache: "no-store",
    headers: {
      "cache-control": "no-cache",
    },
    redirect: "error",
    signal: AbortSignal.timeout(DOCUMENTATION_REQUEST_TIMEOUT_MS),
  })
  invariant(response.status === expectedStatus, `${label} returned HTTP ${response.status}`)
  const contentLength = response.headers.get("content-length")
  if (contentLength !== null) {
    invariant(/^\d+$/u.test(contentLength), `${label} content length is invalid`)
    invariant(Number(contentLength) <= byteLimit, `${label} is larger than expected`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  invariant(bytes.length <= byteLimit, `${label} is larger than expected`)
  return { bytes, response }
}

function publicOutputRoute(outputPath, expectedFingerprint) {
  if (outputPath === "index.html") return ""
  if (outputPath === "404.html") {
    return `publication-missing-${expectedFingerprint}`
  }
  if (outputPath.endsWith(".html")) return outputPath.slice(0, -".html".length)
  return outputPath
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

async function verifyDocumentationAttempt(options, attempt, expectedFingerprint) {
  const cacheKey = `${expectedFingerprint}-${attempt}`
  const manifestUrl = documentationUrl(
    options.baseUrl,
    DOCUMENTATION_MANIFEST_PATH,
    cacheKey,
  )
  const manifestResponse = await fetchBytes(
    options.fetchImplementation,
    manifestUrl,
    DOCUMENTATION_MANIFEST_BYTE_LIMIT,
    "Public documentation manifest",
  )
  const contentType = manifestResponse.response.headers.get("content-type") || ""
  invariant(contentType.includes("application/json"), "Public documentation manifest is not JSON")
  let publicManifest
  try {
    publicManifest = JSON.parse(manifestResponse.bytes.toString("utf8"))
  } catch {
    throw new Error("Public documentation manifest contains invalid JSON")
  }
  validateDocumentationManifest(publicManifest, {
    packageIdentity: options.expectedManifest.package,
  })
  invariant(
    canonicalJson(publicManifest) === canonicalJson(options.expectedManifest),
    "Public documentation manifest differs from the verified artifact",
  )
  for (const output of options.expectedManifest.outputs) {
    const outputUrl = documentationUrl(
      options.baseUrl,
      publicOutputRoute(output.path, expectedFingerprint),
      cacheKey,
    )
    const result = await fetchBytes(
      options.fetchImplementation,
      outputUrl,
      output.size,
      `Public documentation output ${output.path}`,
      output.path === "404.html" ? 404 : 200,
    )
    invariant(
      result.bytes.length === output.size,
      `Public documentation output ${output.path} has the wrong size`,
    )
    invariant(
      sha256(result.bytes) === output.sha256,
      `Public documentation output ${output.path} has the wrong digest`,
    )
  }
  return {
    manifestUrl: manifestUrl.href,
    outputCount: options.expectedManifest.outputs.length,
    state: "exact",
    version: options.expectedManifest.package.version,
  }
}

export async function verifyPublicDocumentation(options) {
  const attempts = options.attempts ?? 1
  const delayMs = options.delayMs ?? 0
  const baseUrl = options.baseUrl
  const fetchImplementation = options.fetchImplementation || fetch
  validateDocumentationManifest(options.expectedManifest)
  invariant(
    typeof baseUrl === "string" && baseUrl.length > 0,
    "documentation URL is required",
  )
  invariant(
    Number.isSafeInteger(attempts) && attempts >= 1 && attempts <= 12,
    "documentation attempts are invalid",
  )
  invariant(
    Number.isSafeInteger(delayMs) && delayMs >= 0 && delayMs <= 10_000,
    "documentation delay is invalid",
  )
  invariant(
    typeof fetchImplementation === "function",
    "documentation fetch implementation is invalid",
  )
  const expectedFingerprint = sha256(canonicalJson(options.expectedManifest))
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await verifyDocumentationAttempt({
        baseUrl,
        expectedManifest: options.expectedManifest,
        fetchImplementation,
      }, attempt, expectedFingerprint)
    } catch (error) {
      lastError = error instanceof Error
        ? error
        : new Error("Public documentation verification failed without an error message")
      if (attempt === attempts) break
      options.onRetry?.(lastError, attempt, attempts)
      if (delayMs > 0) await wait(delayMs)
    }
  }
  throw lastError
}
