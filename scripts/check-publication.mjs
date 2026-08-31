import { promises as fs } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { isMainModule } from "../src/entrypoint.mjs"
import { DOCUMENTATION_SOURCE_PATHS } from "./documentation-publication.mjs"

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DOCS_ROOT = path.join(PROJECT_ROOT, "docs")
const REQUIRED_FILES = Object.freeze([
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  ...DOCUMENTATION_SOURCE_PATHS.map((file) => `docs/${file}`),
  "fleet-policy.example.json",
  "scripts/build-documentation.mjs",
  "scripts/check-install.mjs",
  "scripts/check-public-documentation.mjs",
  "scripts/check-release-tag.mjs",
  "scripts/documentation-publication.mjs",
  "wrangler.docs.jsonc",
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
    for (const originalReference of localReferences(source)) {
      let reference = originalReference
      if (reference.startsWith("/")) {
        if (file !== "docs/404.html") {
          errors.push(`${file} uses a root-relative link: ${reference}`)
          continue
        }
        reference = reference === "/" ? "index.html" : reference.replace(/^\/+/, "")
      }
      let target = path.resolve(PROJECT_ROOT, path.dirname(file), reference)
      if (target !== DOCS_ROOT && !target.startsWith(`${DOCS_ROOT}${path.sep}`)) {
        errors.push(`${file} links outside the documentation source: ${reference}`)
        continue
      }
      try {
        const metadata = await fs.lstat(target)
        if (metadata.isDirectory()) target = path.join(target, "index.html")
      } catch {
        if (!path.extname(target)) target = `${target}.html`
      }
      try {
        await fs.access(target)
      } catch {
        errors.push(`${file} has a missing local link: ${originalReference}`)
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
  const documentationFiles = new Set(
    DOCUMENTATION_SOURCE_PATHS.map((file) => `docs/${file}`),
  )
  for (const required of REQUIRED_FILES) {
    if (!fileSet.has(required)) errors.push(`Required publication file is missing: ${required}`)
  }
  for (const obsolete of [".github/workflows/pages.yml", "docs/.nojekyll"]) {
    if (fileSet.has(obsolete)) errors.push(`Obsolete Pages file remains tracked: ${obsolete}`)
  }
  for (const file of files) {
    if (file.startsWith("docs/") && !documentationFiles.has(file)) {
      errors.push(`Documentation file is outside the deployment frontier: ${file}`)
    }
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
  const documentationWorker = JSON.parse(
    await fs.readFile(path.join(PROJECT_ROOT, "wrangler.docs.jsonc"), "utf8"),
  )
  if (documentationWorker.name !== "cloudflare-fleet-docs") {
    errors.push("wrangler.docs.jsonc must use the dedicated documentation Worker")
  }
  if (documentationWorker.workers_dev !== true
    || documentationWorker.preview_urls !== false
    || documentationWorker.send_metrics !== false) {
    errors.push("wrangler.docs.jsonc must retain its public bootstrap and telemetry policy")
  }
  if (documentationWorker.main !== undefined
    || documentationWorker.routes !== undefined
    || documentationWorker.assets?.binding !== undefined
    || documentationWorker.assets?.directory !== "./documentation-dist"
    || documentationWorker.assets?.html_handling !== "auto-trailing-slash"
    || documentationWorker.assets?.not_found_handling !== "404-page") {
    errors.push("wrangler.docs.jsonc must remain an assets-only documentation deployment")
  }
  if (packageMetadata.license !== "AGPL-3.0-only") {
    errors.push("package.json must declare AGPL-3.0-only")
  }
  if (packageMetadata.homepage !== "https://docs.cloudflare-fleet.lasers.app") {
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
  if (packageMetadata.scripts?.["build:docs"] !== "node scripts/build-documentation.mjs") {
    errors.push("package.json must retain the documentation build command")
  }
  if (packageMetadata.scripts?.["check:docs:public"] !== "node scripts/check-public-documentation.mjs") {
    errors.push("package.json must retain the public documentation verification command")
  }
  if (packageMetadata.scripts?.["deploy:docs"] !== "wrangler deploy --config wrangler.docs.jsonc") {
    errors.push("package.json must retain the documentation deployment command")
  }
  if (packageMetadata.scripts?.["deploy:docs:dry-run"] !== "wrangler deploy --dry-run --config wrangler.docs.jsonc --outdir .wrangler/docs-dry-run") {
    errors.push("package.json must retain the documentation deployment validation command")
  }
  const ciWorkflow = await fs.readFile(
    path.join(PROJECT_ROOT, ".github", "workflows", "ci.yml"),
    "utf8",
  )
  for (const required of [
    "environment:\n      name: documentation",
    "vars.CLOUDFLARE_FLEET_PUBLISH_DOCUMENTATION == 'true'",
    "url: ${{ vars.CLOUDFLARE_FLEET_DOCUMENTATION_URL }}",
    "CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}",
    "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_WORKERS_DEPLOY_TOKEN }}",
    "CLOUDFLARE_FLEET_DOCUMENTATION_URL: ${{ vars.CLOUDFLARE_FLEET_DOCUMENTATION_URL }}",
    "include-hidden-files: true",
    "npm run deploy:docs -- --message",
    "npm run check:docs:public -- --manifest documentation-dist/publication-manifest.json",
  ]) {
    if (!ciWorkflow.includes(required)) {
      errors.push(`CI lacks the verified documentation deployment contract: ${required}`)
    }
  }
  if (/deploy-pages|configure-pages|pages:\s*write/u.test(ciWorkflow)) {
    errors.push("CI retains obsolete GitHub Pages deployment authority")
  }
  if (ciWorkflow.includes("https://docs.cloudflare-fleet.lasers.app")) {
    errors.push("CI hardcodes the upstream documentation deployment target")
  }
  const artifactFiles = packedFiles()
  for (const required of [
    "README.md",
    "launch.sh",
    "src/cli.mjs",
    "src/mcp.mjs",
    "scripts/build-documentation.mjs",
    "scripts/check-public-documentation.mjs",
    "scripts/configure-hosted.mjs",
    "scripts/documentation-publication.mjs",
    "scripts/import-hosted-state.mjs",
    "wrangler.docs.jsonc",
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
