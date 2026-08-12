import { copyFile, mkdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.dirname(SCRIPT_DIR)
const DEFAULT_DESTINATION = path.join(PROJECT_ROOT, ".worker-assets")
const ENTRYPOINT = path.join(PROJECT_ROOT, "src", "app.mjs")
const ROOT_ASSETS = Object.freeze([
  "index.html",
  "styles.css",
])
const IMPORT_PATTERN = /(?:\bfrom\s+|^\s*import\s+)["'](\.[^"']+)["']/gm

function projectRelative(filePath) {
  const relative = path.relative(PROJECT_ROOT, filePath)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Browser import escapes the project root: ${filePath}`)
  }
  return relative
}

function relativeImports(source) {
  return [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1])
}

export async function collectBrowserModules(entrypoint = ENTRYPOINT) {
  const pending = [entrypoint]
  const modules = new Set()
  while (pending.length > 0) {
    const filePath = path.resolve(pending.pop())
    if (modules.has(filePath)) continue
    const relative = projectRelative(filePath)
    if (!relative.startsWith(`src${path.sep}`) || path.extname(filePath) !== ".mjs") {
      throw new Error(`Browser module is outside src/*.mjs: ${relative}`)
    }
    modules.add(filePath)
    const source = await readFile(filePath, "utf8")
    for (const specifier of relativeImports(source)) {
      const imported = path.resolve(path.dirname(filePath), specifier)
      pending.push(imported)
    }
  }
  return [...modules].sort()
}

export async function buildWorkerAssets(destination = DEFAULT_DESTINATION) {
  await rm(destination, { force: true, recursive: true })
  await mkdir(path.join(destination, "src"), { recursive: true })
  for (const relative of ROOT_ASSETS) {
    await copyFile(path.join(PROJECT_ROOT, relative), path.join(destination, relative))
  }
  const modules = await collectBrowserModules()
  for (const sourcePath of modules) {
    const relative = projectRelative(sourcePath)
    const destinationPath = path.join(destination, relative)
    await mkdir(path.dirname(destinationPath), { recursive: true })
    await copyFile(sourcePath, destinationPath)
  }
  return {
    destination,
    files: [...ROOT_ASSETS, ...modules.map(projectRelative)].sort(),
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  buildWorkerAssets().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`)
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
