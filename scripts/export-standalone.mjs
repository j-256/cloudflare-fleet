import { promises as fs } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PRIVATE_FILES = new Set([
  "fleet-policy.json",
  "wrangler.jsonc",
])

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

function parseArguments(argv) {
  let outputDirectory = ""
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--output" || argument.startsWith("--output=")) {
      const value = argument.startsWith("--output=")
        ? argument.slice("--output=".length)
        : argv[index + 1]
      if (!value || value.startsWith("--")) {
        throw new Error("--output requires a directory")
      }
      outputDirectory = path.resolve(value)
      if (argument === "--output") index += 1
      continue
    }
    throw new Error(`Unknown option: ${argument}`)
  }
  if (!outputDirectory) {
    throw new Error("Usage: export-standalone.mjs --output DIRECTORY")
  }
  return { outputDirectory }
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
    if (!metadata.isFile()) {
      throw new Error(`Publication export supports regular files only: ${file}`)
    }
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.copyFile(source, destination)
    await fs.chmod(destination, metadata.mode & 0o777)
  }
  return { files: files.length, outputDirectory }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  let options
  try {
    options = parseArguments(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
  if (options) {
    exportStandalone(options).then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`)
    }).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
  }
}
