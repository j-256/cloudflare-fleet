import { promises as fs } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { isMainModule } from "../src/entrypoint.mjs"

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PRIVATE_FILES = new Set([
  "fleet-policy.json",
  "wrangler.jsonc",
])
const ALLOWED_SYMBOLIC_LINKS = Object.freeze({
  "CLAUDE.md": "AGENTS.md",
})

function isPrivateFile(file) {
  return PRIVATE_FILES.has(file)
    || file.startsWith(".dev.vars")
    || file.startsWith(".env")
    || /^state.*\.json$/.test(file)
}

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

export function standaloneExportUsage() {
  return [
    "Usage: export-standalone.mjs --output DIRECTORY",
    "",
    "Options:",
    "  -o, --output DIRECTORY   Export into an empty DIRECTORY",
    "  -h, --help               Show this help",
  ].join("\n")
}

export function parseStandaloneExportArguments(argv) {
  let outputDirectory = ""
  let help = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "-h" || argument === "--help") {
      help = true
      continue
    }
    if (argument === "-o" || argument === "--output" || argument.startsWith("--output=")) {
      const value = argument.startsWith("--output=")
        ? argument.slice("--output=".length)
        : argv[index + 1]
      if (!value || value.startsWith("-")) {
        throw new Error("--output requires a directory")
      }
      outputDirectory = path.resolve(value)
      if (!argument.startsWith("--output=")) index += 1
      continue
    }
    throw new Error(`Unknown option: ${argument}`)
  }
  if (!outputDirectory && !help) {
    throw new Error(standaloneExportUsage())
  }
  return { help, outputDirectory }
}

function trackedProjectFiles() {
  return gitOutput(["ls-files", "-z", "--", "."])
    .split("\0")
    .filter(Boolean)
    .filter((file) => !isPrivateFile(file))
    .sort()
}

async function assertSafeDestination(outputDirectory) {
  if (outputDirectory === PROJECT_ROOT
    || outputDirectory.startsWith(`${PROJECT_ROOT}${path.sep}`)
    || PROJECT_ROOT.startsWith(`${outputDirectory}${path.sep}`)) {
    throw new Error("Export destination must be separate from the project tree")
  }
  try {
    const entries = await fs.readdir(outputDirectory)
    if (entries.length > 0) throw new Error("Export destination must be empty")
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
}

export async function exportStandalone(options) {
  const outputDirectory = path.resolve(options.outputDirectory)
  await assertSafeDestination(outputDirectory)
  const files = trackedProjectFiles()
  await fs.mkdir(outputDirectory, { recursive: true })
  for (const file of files) {
    const source = path.join(PROJECT_ROOT, file)
    const destination = path.join(outputDirectory, file)
    const metadata = await fs.lstat(source)
    if (metadata.isSymbolicLink()) {
      const expectedTarget = ALLOWED_SYMBOLIC_LINKS[file]
      const actualTarget = await fs.readlink(source)
      if (!expectedTarget || actualTarget !== expectedTarget) {
        throw new Error(`Publication export does not allow symbolic link: ${file} -> ${actualTarget}`)
      }
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.symlink(actualTarget, destination)
      continue
    }
    if (!metadata.isFile()) {
      throw new Error(`Publication export supports regular files only: ${file}`)
    }
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.copyFile(source, destination)
    await fs.chmod(destination, metadata.mode & 0o777)
  }
  return { files: files.length, outputDirectory }
}

if (isMainModule(import.meta.url)) {
  let options
  try {
    options = parseStandaloneExportArguments(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
  if (options) {
    if (options.help) {
      process.stdout.write(`${standaloneExportUsage()}\n`)
    } else exportStandalone(options).then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`)
    }).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
  }
}
