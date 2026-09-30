import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { CliUsageError, parseCliOptions } from "../src/cli-options.mjs"
import { isMainModule } from "../src/entrypoint.mjs"
import { RELEASE_VERSION_PATTERN } from "../src/self-hosted-release.mjs"

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url))

function releaseVersionParts(version) {
  if (!RELEASE_VERSION_PATTERN.test(version || "")) throw new CliUsageError("--version requires an exact release version, such as 1.2.3")
  const separator = version.indexOf("-")
  const core = separator === -1 ? version : version.slice(0, separator)
  const prerelease = separator === -1 ? null : version.slice(separator + 1)
  return {
    core: core.split(".").map((part) => BigInt(part)),
    prerelease: prerelease?.split(".") ?? null,
  }
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/u.test(left)
  const rightNumeric = /^\d+$/u.test(right)
  if (leftNumeric && rightNumeric) {
    const leftNumber = BigInt(left)
    const rightNumber = BigInt(right)
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
  return left.localeCompare(right, "en")
}

export function compareReleaseVersions(left, right) {
  const leftParts = releaseVersionParts(left)
  const rightParts = releaseVersionParts(right)
  for (let index = 0; index < leftParts.core.length; index += 1) {
    if (leftParts.core[index] !== rightParts.core[index]) return leftParts.core[index] < rightParts.core[index] ? -1 : 1
  }
  if (leftParts.prerelease === null || rightParts.prerelease === null) {
    return leftParts.prerelease === rightParts.prerelease ? 0 : leftParts.prerelease === null ? 1 : -1
  }
  const length = Math.max(leftParts.prerelease.length, rightParts.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    if (leftParts.prerelease[index] === undefined) return -1
    if (rightParts.prerelease[index] === undefined) return 1
    const comparison = compareIdentifiers(leftParts.prerelease[index], rightParts.prerelease[index])
    if (comparison !== 0) return comparison
  }
  return 0
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"))
}

async function writeJsonPair(files) {
  const prepared = []
  try {
    for (const { file, value, mode } of files) {
      const temporary = `${file}.${randomUUID()}.tmp`
      await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode })
      prepared.push({ file, temporary })
    }
    for (const { file, temporary } of prepared) await fs.rename(temporary, file)
  } finally {
    await Promise.all(prepared.map(({ temporary }) => fs.rm(temporary, { force: true })))
  }
}

export async function prepareReleaseFiles(root, nextVersion) {
  releaseVersionParts(nextVersion)
  const packageFile = path.join(root, "package.json")
  const lockFile = path.join(root, "package-lock.json")
  const [metadata, lock, packageStat, lockStat] = await Promise.all([
    readJson(packageFile), readJson(lockFile), fs.stat(packageFile), fs.stat(lockFile),
  ])
  const currentVersions = [metadata.version, lock.version, lock.packages?.[""]?.version]
  if (!currentVersions.every((version) => version === currentVersions[0] && RELEASE_VERSION_PATTERN.test(version || ""))) {
    throw new Error("Package metadata versions do not agree")
  }
  if (compareReleaseVersions(nextVersion, metadata.version) <= 0) {
    throw new CliUsageError(`Release version ${nextVersion} must be newer than ${metadata.version}`)
  }
  metadata.version = nextVersion
  lock.version = nextVersion
  lock.packages[""].version = nextVersion
  await writeJsonPair([
    { file: packageFile, value: metadata, mode: packageStat.mode & 0o777 },
    { file: lockFile, value: lock, mode: lockStat.mode & 0o777 },
  ])
  return { previousVersion: currentVersions[0], version: nextVersion, files: ["package.json", "package-lock.json"] }
}

export function prepareReleaseUsage() {
  return [
    "Usage: prepare-release.mjs --version VERSION [--root DIRECTORY]",
    "Update package.json and package-lock.json to one strictly newer release version.",
    "  -V, --version VERSION  Exact semver-compatible release version",
    "  -r, --root DIRECTORY   Package root (default: repository root)",
    "  -h, --help             Show this help",
    "Dependencies: Node.js; no credentials or network access.",
    "Result JSON goes to stdout; errors go to stderr.",
    "Exit: 0 success/help, 1 file failure, 2 usage or version precondition.",
  ].join("\n")
}

if (isMainModule(import.meta.url)) {
  try {
    const options = parseCliOptions(process.argv.slice(2), [
      { name: "help", short: "h", value: false },
      { name: "version", short: "V", value: true },
      { name: "root", short: "r", value: true, default: PROJECT_ROOT },
    ])
    if (options.help) console.log(prepareReleaseUsage())
    else {
      if (!options.version) throw new CliUsageError("--version is required")
      console.log(JSON.stringify(await prepareReleaseFiles(path.resolve(options.root), options.version)))
    }
  } catch (error) {
    console.error(`prepare-release: ${error.message}`)
    process.exitCode = error instanceof CliUsageError ? 2 : 1
  }
}
