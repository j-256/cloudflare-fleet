import { promises as fs } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { isMainModule } from "../src/entrypoint.mjs"

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DOCS_ROOT = path.join(PROJECT_ROOT, "docs")
const REQUIRED_FILES = Object.freeze([
  ".github/workflows/ci.yml",
  ".github/workflows/pages.yml",
  ".github/workflows/release.yml",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "docs/.nojekyll",
  "docs/architecture.html",
  "docs/deployment.html",
  "docs/diagrams/architecture.svg",
  "docs/diagrams/intent-alignment.svg",
  "docs/diagrams/write-flow.svg",
  "docs/getting-started.html",
  "docs/index.html",
  "docs/screenshots/alignment-blocked.png",
  "docs/screenshots/cover.png",
  "docs/screenshots/dashboard-overview.png",
  "docs/screenshots/fleet-intent.png",
  "docs/screenshots/intent-alignment.png",
  "docs/screenshots/mobile-dashboard.png",
  "docs/screenshots/reviewed-write.png",
  "docs/security.html",
  "docs/styles.css",
  "fleet-policy.example.json",
  "scripts/check-install.mjs",
  "scripts/check-release-tag.mjs",
  "wrangler.example.jsonc",
])
const PRIVATE_TRACKED_FILES = new Set([
  "fleet-policy.json",
  "wrangler.jsonc",
])
const ALLOWED_SYMBOLIC_LINKS = Object.freeze({
  "CLAUDE.md": "AGENTS.md",
})
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const TEXT_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".md",
  ".mjs",
  ".sh",
  ".sql",
  ".svg",
  ".yml",
  ".yaml",
])
const DISALLOWED_PROSE_CODE_POINTS = new Set([
  0x2018,
  0x2019,
  0x201c,
  0x201d,
  0x2014,
])

function gitOutput(args) {
  const result = spawnSync("git", args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  })
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`)
  }
  return result.stdout
}

function packedFiles() {
  const result = spawnSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
    },
  )
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "npm pack --dry-run failed")
  }
  let report
  try {
    report = JSON.parse(result.stdout)
  } catch {
    throw new Error("npm pack --dry-run returned invalid JSON")
  }
  return new Set(
    (report[0]?.files || []).map((entry) => entry.path),
  )
}

async function publicationFiles() {
  const source = gitOutput([
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ".",
  ])
  const files = source.split("\0").filter(Boolean)
  const existing = []
  for (const file of files) {
    try {
      await fs.lstat(path.join(PROJECT_ROOT, file))
      existing.push(file)
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
  }
  return [...new Set(existing)].sort()
}

function localReferences(source) {
  const references = []
  const pattern = /\b(?:href|src)=(['"])(.*?)\1/g
  for (const match of source.matchAll(pattern)) {
    const reference = match[2]
    if (!reference
      || reference.startsWith("#")
      || reference.startsWith("data:")
      || reference.startsWith("http:")
      || reference.startsWith("https:")
      || reference.startsWith("mailto:")) {
      continue
    }
    references.push(reference.split(/[?#]/, 1)[0])
  }
  return references
}

async function validateDocumentationLinks(files, errors) {
  for (const file of files.filter((entry) => (
    entry.startsWith("docs/") && entry.endsWith(".html")
  ))) {
    const source = await fs.readFile(path.join(PROJECT_ROOT, file), "utf8")
    for (const reference of localReferences(source)) {
      if (reference.startsWith("/")) {
        errors.push(`${file} uses a root-relative link: ${reference}`)
        continue
      }
      const target = path.resolve(PROJECT_ROOT, path.dirname(file), reference)
      if (!target.startsWith(`${DOCS_ROOT}${path.sep}`)) {
        errors.push(`${file} links outside the Pages source: ${reference}`)
        continue
      }
      try {
        await fs.access(target)
      } catch {
        errors.push(`${file} has a missing local link: ${reference}`)
      }
    }
  }
}

async function validatePng(file, errors) {
  const source = await fs.readFile(path.join(PROJECT_ROOT, file))
  if (source.length < 24 || !source.subarray(0, 8).equals(PNG_SIGNATURE)) {
    errors.push(`${file} is not a valid PNG`)
    return
  }
  const width = source.readUInt32BE(16)
  const height = source.readUInt32BE(20)
  if (width === 0 || height === 0) errors.push(`${file} has invalid dimensions`)
}

function privatePathPatterns() {
  return [
    new RegExp(["/", "Users", "/[A-Za-z0-9._-]+/"].join("")),
    new RegExp(["(^|[\\s'\"(])", "/", "[xcz]", "/"].join(""), "m"),
  ]
}

async function validateTextContent(files, errors) {
  const patterns = privatePathPatterns()
  for (const file of files) {
    if (!TEXT_EXTENSIONS.has(path.extname(file)) && !["LICENSE"].includes(file)) {
      continue
    }
    const source = await fs.readFile(path.join(PROJECT_ROOT, file), "utf8")
    if (/private\s+control\s+plane/i.test(source)) {
      errors.push(`${file} uses private-product language`)
    }
    if (patterns.some((pattern) => pattern.test(source))) {
      errors.push(`${file} contains a machine-private absolute path`)
    }
    if ([...source].some((character) => (
      DISALLOWED_PROSE_CODE_POINTS.has(character.codePointAt(0))
    ))) {
      errors.push(`${file} contains curly quotes or an em dash`)
    }
  }
}

export async function checkPublication() {
  const errors = []
  const files = await publicationFiles()
  const fileSet = new Set(files)
  for (const required of REQUIRED_FILES) {
    if (!fileSet.has(required)) errors.push(`Required publication file is missing: ${required}`)
  }
  for (const file of files) {
    if (PRIVATE_TRACKED_FILES.has(file)
      || file.startsWith(".dev.vars")
      || file.startsWith(".env")
      || /^state.*\.json$/.test(file)) {
      errors.push(`Operator-private file would be published: ${file}`)
    }
    const metadata = await fs.lstat(path.join(PROJECT_ROOT, file))
    if (metadata.isSymbolicLink()) {
      const expectedTarget = ALLOWED_SYMBOLIC_LINKS[file]
      const actualTarget = await fs.readlink(path.join(PROJECT_ROOT, file))
      if (!expectedTarget || actualTarget !== expectedTarget) {
        errors.push(`Symbolic link is not allowed in the publication tree: ${file} -> ${actualTarget}`)
      }
    }
  }
  await validateDocumentationLinks(files, errors)
  await validateTextContent(files, errors)
  for (const file of files.filter((entry) => entry.endsWith(".png"))) {
    await validatePng(file, errors)
  }
  const packageMetadata = JSON.parse(
    await fs.readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"),
  )
  if (packageMetadata.license !== "AGPL-3.0-only") {
    errors.push("package.json must declare AGPL-3.0-only")
  }
  if (packageMetadata.homepage !== "https://j-256.github.io/cloudflare-fleet/") {
    errors.push("package.json must link to the public documentation site")
  }
  if (!packageMetadata.private) {
    errors.push("package.json must prevent accidental npm publication")
  }
  if (packageMetadata.bin?.[packageMetadata.name] !== "src/cli.mjs") {
    errors.push("package.json must expose src/cli.mjs as the cloudflare-fleet binary")
  }
  if (packageMetadata.scripts?.["check:install"] !== "node scripts/check-install.mjs") {
    errors.push("package.json must retain the packed-install verification command")
  }
  if (packageMetadata.scripts?.["check:release-tag"] !== "node scripts/check-release-tag.mjs") {
    errors.push("package.json must retain the release-tag verification command")
  }
  const artifactFiles = packedFiles()
  for (const required of [
    "README.md",
    "launch.sh",
    "src/cli.mjs",
    "src/mcp.mjs",
    "scripts/configure-hosted.mjs",
    "scripts/import-hosted-state.mjs",
  ]) {
    if (!artifactFiles.has(required)) {
      errors.push(`Source package is missing required runtime file: ${required}`)
    }
  }
  for (const file of artifactFiles) {
    if (file.startsWith("test/")
      || file === "AGENTS.md"
      || file === "CLAUDE.md"
      || PRIVATE_TRACKED_FILES.has(file)
      || file.startsWith(".dev.vars")
      || file.startsWith(".env")) {
      errors.push(`Source package contains non-runtime or private file: ${file}`)
    }
  }
  if (errors.length > 0) {
    throw new Error(`Publication check failed:\n- ${errors.join("\n- ")}`)
  }
  return { files: files.length }
}

if (isMainModule(import.meta.url)) {
  checkPublication().then((result) => {
    process.stdout.write(`Publication tree is ready (${result.files} files checked)\n`)
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
