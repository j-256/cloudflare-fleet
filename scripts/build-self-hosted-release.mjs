import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"

import { CliUsageError, parseCliOptions } from "../src/cli-options.mjs"
import { isMainModule } from "../src/entrypoint.mjs"
import { RELEASE_IDENTITY, RELEASE_MANIFEST, RELEASE_SCHEMA_VERSION, releaseContentId, releaseHash, releasePathIsSafe } from "../src/self-hosted-release.mjs"

const execute = promisify(execFile)
const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url))
const TAR_BLOCK_SIZE = 512

function tarFile(name, content, executable) {
  if (Buffer.byteLength(name) > 100) throw new Error(`Archive path is too long: ${name}`)
  const header = Buffer.alloc(TAR_BLOCK_SIZE)
  header.write(name, 0, 100)
  for (const [offset, width, value] of [[100, 8, executable ? 0o755 : 0o644], [108, 8, 0], [116, 8, 0], [124, 12, content.length], [136, 12, 0]]) {
    header.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset, width)
  }
  header.fill(32, 148, 156)
  header.write("0", 156)
  header.write("ustar\0", 257)
  header.write("00", 263)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8)
  return Buffer.concat([header, content, Buffer.alloc((TAR_BLOCK_SIZE - content.length % TAR_BLOCK_SIZE) % TAR_BLOCK_SIZE)])
}

export async function buildSelfHostedRelease({ outputDirectory, requireClean = false, root = PROJECT_ROOT }) {
  const options = { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }
  const before = (await execute("git", ["status", "--porcelain", "--untracked-files=all"], options)).stdout
  if (requireClean && before.trim()) throw new Error("Published self-hosting releases require a clean committed source tree")
  const sourceRevision = before.trim() ? null : (await execute("git", ["rev-parse", "HEAD"], options)).stdout.trim()
  const report = JSON.parse((await execute("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], options)).stdout)[0]
  const names = [...new Set([...report.files.map((file) => file.path), "package-lock.json"])].sort()
  const contents = new Map()
  const modes = new Map()
  const files = {}
  for (const name of names) {
    if (!releasePathIsSafe(name)) throw new Error(`File is outside the release boundary: ${name}`)
    const source = path.join(root, name)
    const metadata = await fs.lstat(source)
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Release source is not a regular file: ${name}`)
    const content = await fs.readFile(source)
    contents.set(name, content)
    modes.set(name, Boolean(metadata.mode & 0o111))
    files[name] = releaseHash(content)
  }
  const version = JSON.parse(contents.get("package.json")).version
  const releaseId = releaseContentId({ version, sourceRevision, files })
  const identity = { schemaVersion: RELEASE_SCHEMA_VERSION, version, sourceRevision, releaseId }
  const identityContent = Buffer.from(`${JSON.stringify(identity, null, 2)}\n`)
  contents.set(RELEASE_IDENTITY, identityContent)
  files[RELEASE_IDENTITY] = releaseHash(identityContent)
  const manifest = { ...identity, files }
  contents.set(RELEASE_MANIFEST, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`))
  if (requireClean && (await execute("git", ["status", "--porcelain", "--untracked-files=all"], options)).stdout.trim()) throw new Error("Source changed while the release was being assembled")
  for (const [name, hash] of Object.entries(files)) {
    if (name !== RELEASE_IDENTITY && releaseHash(await fs.readFile(path.join(root, name))) !== hash) throw new Error("Source changed while the release was being assembled")
  }
  const archive = gzipSync(Buffer.concat([
    ...[...contents].sort(([left], [right]) => left.localeCompare(right, "en")).map(([name, content]) => tarFile(`package/${name}`, content, modes.get(name))),
    Buffer.alloc(TAR_BLOCK_SIZE * 2),
  ]), { level: 9 })
  const filename = `cloudflare-fleet-${version}-self-hosted.tgz`
  await fs.mkdir(outputDirectory, { recursive: true })
  const archiveFile = path.join(outputDirectory, filename)
  await fs.writeFile(archiveFile, archive, { flag: "wx" })
  try {
    await fs.writeFile(path.join(outputDirectory, `${filename}.sha256`), `${releaseHash(archive)}  ${filename}\n`, { flag: "wx" })
  } catch (error) {
    await fs.rm(archiveFile)
    throw error
  }
  return { filename, version, sourceRevision, releaseId, sha256: releaseHash(archive) }
}

if (isMainModule(import.meta.url)) {
  try {
    const options = parseCliOptions(process.argv.slice(2), [
      { name: "help", short: "h", value: false },
      { name: "output", short: "o", value: true },
      { name: "require-clean", key: "requireClean", value: false },
    ])
    if (options.help) console.log("Usage: build-self-hosted-release.mjs --output DIRECTORY [--require-clean]\nBuild a locked self-hosting source archive and SHA-256 checksum from the package allowlist.\nDependencies: Node.js, npm, Git; no Cloudflare credentials or network reads.\nExisting archive files are never overwritten. --require-clean rejects uncommitted source.\nExit: 0 success/help, 1 build failure, 2 usage, 3 missing dependency.")
    else {
      if (!options.output) throw new CliUsageError("--output is required")
      console.log(JSON.stringify(await buildSelfHostedRelease({ outputDirectory: path.resolve(options.output), requireClean: options.requireClean })))
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = error instanceof CliUsageError ? 2 : error.code === "ENOENT" ? 3 : 1
  }
}
