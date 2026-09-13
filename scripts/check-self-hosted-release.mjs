import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"
import { gunzipSync } from "node:zlib"

import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { CliUsageError, parseCliOptions } from "../src/cli-options.mjs"
import { isMainModule } from "../src/entrypoint.mjs"
import { readRegularReleaseFile } from "../src/release-files.mjs"
import { inspectSelfHostedRelease, releaseHash, releasePathIsSafe } from "../src/self-hosted-release.mjs"

const execute = promisify(execFile)
const ACCOUNT_ID = "a".repeat(32)
const DATABASE_ID = "11111111-1111-1111-1111-111111111111"
const LEGACY_MIGRATION = "0001_hosted_state.sql"
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const COMMAND_TIMEOUT_MS = 180000
const PRESERVED_TABLES = Object.freeze(["fleet_intent", "activity_meta", "operation_activity", "inventory_cache"])

// Only the builder's bounded regular-file USTAR format is accepted before system tar extracts it
export function validateReleaseArchive(archive) {
  const raw = gunzipSync(archive, { maxOutputLength: MAX_ARCHIVE_BYTES })
  const names = new Set()
  let offset = 0
  while (offset + 512 <= raw.length && raw[offset] !== 0) {
    const header = raw.subarray(offset, offset + 512)
    const name = header.subarray(0, 100).toString().split("\0")[0]
    const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, ""), 8)
    assert.equal(header[156], 48, "Release archive must contain regular files only")
    assert.equal(header.subarray(345, 500).every((byte) => byte === 0), true, "Archive prefixes are unsupported")
    assert.equal(name.startsWith("package/") && releasePathIsSafe(name.slice(8)), true, "Unsafe archive path")
    assert.equal(names.has(name), false, "Duplicate archive path")
    assert.equal(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= raw.length, true, "Invalid archive size")
    names.add(name)
    offset += 512 + Math.ceil(size / 512) * 512
  }
  assert.equal(names.has("package/release-manifest.json"), true, "Release manifest is missing")
  assert.equal(raw.subarray(offset).length >= 1024 && raw.subarray(offset).every((byte) => byte === 0), true, "Invalid archive trailer")
}

function isolatedEnvironment(scratch) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLOUDFLARE_|CF_|WRANGLER_|XDG_)/.test(name)))
  return { ...environment, CI: "true", WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: path.join(scratch, "logs"),
    XDG_CONFIG_HOME: path.join(scratch, "config"), XDG_STATE_HOME: path.join(scratch, "state"),
    XDG_CACHE_HOME: path.join(scratch, "cache"), CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, CLOUDFLARE_FLEET_BACKEND: "local" }
}

async function command(program, args, cwd, environment) {
  try {
    return await execute(program, args, { cwd, env: environment, encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 })
  } catch (error) {
    throw Object.assign(new Error(`${path.basename(program)} ${args[0] || ""} failed (${error.code || "unknown"}): ${(error.stderr || error.stdout || error.message).slice(-6000)}`), { code: error.code })
  }
}

async function checkMcp(root, scratch, environment, version) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "src/cli.mjs"), "mcp"],
    cwd: scratch, env: { ...environment, CLOUDFLARE_FLEET_RELEASE_DIR: root }, stderr: "pipe" })
  transport.stderr?.resume()
  const client = new Client({ name: "self-hosted-artifact-check", version: "1.0.0" })
  try {
    await client.connect(transport)
    const report = await client.callTool({ name: "check_hosted_release", arguments: { version } })
    assert.equal(report.structuredContent?.status, "ready", JSON.stringify(report.structuredContent))
  } finally { await client.close() }
}

async function install(archiveFile, destination, environment) {
  await fs.mkdir(destination)
  await command("tar", ["-xzf", archiveFile, "-C", destination], destination, environment)
  const root = path.join(destination, "package")
  const manifest = JSON.parse(await fs.readFile(path.join(root, "release-manifest.json"), "utf8"))
  const release = await inspectSelfHostedRelease(root, manifest.version)
  await command("npm", ["ci", "--include=dev", "--no-audit", "--no-fund"], root, environment)
  const cli = (args, cwd = destination) => command(process.execPath, [path.join(root, "src/cli.mjs"), ...args], cwd, environment)
  assert.equal((await cli(["--version"])).stdout.trim(), release.version)
  await cli(["hosted", "configure", "--output", path.join(root, "wrangler.jsonc"), "--account-id", ACCOUNT_ID,
    "--database-id", DATABASE_ID, "--hostname", "fleet.example.com", "--access-aud", "0".repeat(64),
    "--access-team-domain", "https://example.cloudflareaccess.com"])
  await command("npm", ["run", "build:hosted"], root, environment)
  const check = JSON.parse((await cli(["hosted", "check", "--release-dir", root, "--version", release.version, "--format", "json"])).stdout)
  assert.equal(check.status, "ready", JSON.stringify(check))
  await checkMcp(root, destination, environment, release.version)
  const wrangler = (args) => command(process.execPath, [path.join(root, "node_modules/wrangler/bin/wrangler.js"), ...args], root, environment)
  await wrangler(["deploy", "--dry-run", "--outdir", ".wrangler/release-bundle"])
  return { root, release, wrangler }
}

function runtimeFor(installation, persistencePath) {
  const require = createRequire(path.join(installation.root, "package.json"))
  const wranglerRequire = createRequire(require.resolve("wrangler/package.json"))
  const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare")
  return async () => {
    const config = JSON.parse(await fs.readFile(path.join(installation.root, "wrangler.jsonc"), "utf8"))
    return new Miniflare(convertV4MiniflareOptions({
      name: "fleet", modules: true, script: await fs.readFile(path.join(installation.root, ".wrangler/release-bundle/worker.js"), "utf8"),
      compatibilityDate: config.compatibility_date, bindings: { ...config.vars, CLOUDFLARE_API_TOKEN: "synthetic-not-a-credential" },
      resourcePersistencePath: path.join(persistencePath, "v3"), d1Databases: { FLEET_DB: DATABASE_ID },
      assets: { directory: path.join(installation.root, ".worker-assets"), binding: "ASSETS", run_worker_first: true, routerConfig: { has_user_worker: true } },
    }))
  }
}

async function databaseSnapshot(runtime) {
  const db = await runtime.getD1Database("FLEET_DB")
  const snapshot = {}
  for (const table of PRESERVED_TABLES) snapshot[table] = (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results
  return snapshot
}

async function verifyRuntime(installation, persistencePath, snapshot) {
  const runtime = await runtimeFor(installation, persistencePath)()
  try {
    const response = await runtime.dispatchFetch("http://localhost/api/commands", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, accountId: ACCOUNT_ID, command: "status", input: {} }),
    })
    assert.equal(response.status, 200, await response.clone().text())
    const status = (await response.json()).result
    assert.equal(status.schema, "ready")
    assert.equal(status.release.releaseId, installation.release.releaseId)
    assert.equal(status.release.version, installation.release.version)
    assert.equal((await runtime.dispatchFetch("http://localhost/")).status, 200)
    assert.equal((await runtime.dispatchFetch("https://fleet.example.com/api/commands")).status, 403)
    const db = await runtime.getD1Database("FLEET_DB")
    const applied = (await db.prepare("SELECT name FROM d1_migrations ORDER BY name").all()).results.map((row) => row.name)
    assert.deepEqual(applied, installation.release.migrations)
    if (snapshot) assert.deepEqual(await databaseSnapshot(runtime), snapshot, "Upgrade changed existing operator records")
  } finally { await runtime.dispose() }
}

export async function checkSelfHostedRelease(directory, onProgress = () => {}) {
  const requestId = randomUUID()
  const checks = []
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "cloudflare-fleet-hosting-"))
  const environment = isolatedEnvironment(scratch)
  const stage = async (name, action) => {
    const started = Date.now()
    try {
      const result = await action()
      const record = { requestId, check: name, status: "pass", elapsedMs: Date.now() - started }
      checks.push(record)
      onProgress(record)
      return result
    } catch (error) {
      onProgress({ requestId, check: name, status: "fail", elapsedMs: Date.now() - started })
      throw Object.assign(new Error(`${name} failed [${requestId}]: ${error.message}`), { code: error.code })
    }
  }
  try {
    const archiveFile = await stage("archive.checksum-and-paths", async () => {
      const candidates = (await fs.readdir(directory)).filter((name) => /^cloudflare-fleet-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-self-hosted\.tgz$/.test(name))
      assert.equal(candidates.length, 1, "Select a directory containing exactly one self-hosting archive")
      const file = path.resolve(directory, candidates[0])
      const { content: archive } = await readRegularReleaseFile(file, MAX_ARCHIVE_BYTES)
      assert.equal((await readRegularReleaseFile(`${file}.sha256`)).content.toString("utf8"), `${releaseHash(archive)}  ${candidates[0]}\n`, "Archive checksum differs")
      validateReleaseArchive(archive)
      const verified = path.join(scratch, "verified.tgz")
      await fs.writeFile(verified, archive, { mode: 0o600, flag: "wx" })
      return verified
    })
    const fresh = await stage("fresh.install-and-build", () => install(archiveFile, path.join(scratch, "fresh"), environment))
    const freshStore = path.join(scratch, "fresh-data")
    await stage("fresh.migrations-and-runtime", async () => {
      await fresh.wrangler(["d1", "migrations", "apply", "FLEET_DB", "--local", "--persist-to", freshStore])
      await fresh.wrangler(["d1", "migrations", "apply", "FLEET_DB", "--local", "--persist-to", freshStore])
      await verifyRuntime(fresh, freshStore)
    })
    const legacyStore = path.join(scratch, "upgrade-data")
    const snapshot = await stage("upgrade.legacy-schema-and-state", async () => {
      const migrations = path.join(scratch, "legacy-migrations")
      await fs.mkdir(migrations)
      await fs.copyFile(path.join(fresh.root, "migrations", LEGACY_MIGRATION), path.join(migrations, LEGACY_MIGRATION))
      const legacyConfig = path.join(scratch, "legacy.json")
      await fs.writeFile(legacyConfig, JSON.stringify({ name: "cloudflare-fleet", d1_databases: [{ binding: "FLEET_DB", database_name: "cloudflare-fleet", database_id: DATABASE_ID, migrations_dir: migrations }] }))
      await fresh.wrangler(["d1", "migrations", "apply", "FLEET_DB", "--config", legacyConfig, "--local", "--persist-to", legacyStore])
      const runtime = await runtimeFor(fresh, legacyStore)()
      try {
        const db = await runtime.getD1Database("FLEET_DB")
        const { createEmptyFleetIntentDocument } = await import(pathToFileURL(path.join(fresh.root, "src/fleet-intent.mjs")))
        const intent = createEmptyFleetIntentDocument(ACCOUNT_ID)
        const timestamp = "2026-01-01T00:00:00Z"
        await db.batch([
          db.prepare("INSERT INTO fleet_intent VALUES (?, ?, ?, ?)").bind(ACCOUNT_ID, JSON.stringify(intent), "retained-intent", timestamp),
          db.prepare("INSERT INTO activity_meta VALUES (?, ?, ?)").bind(ACCOUNT_ID, "retained-activity", timestamp),
          db.prepare("INSERT INTO operation_activity (account_id, id, payload_json, status, started_at) VALUES (?, ?, ?, ?, ?)").bind(ACCOUNT_ID, "retained-operation", JSON.stringify({ id: "retained-operation", status: "verified" }), "verified", timestamp),
          db.prepare("INSERT INTO inventory_cache VALUES (?, ?, ?, ?, ?, ?)").bind("retained-cache", ACCOUNT_ID, JSON.stringify({ synthetic: true }), timestamp, timestamp, timestamp),
        ])
        return await databaseSnapshot(runtime)
      } finally { await runtime.dispose() }
    })
    const upgraded = await stage("upgrade.independent-install", () => install(archiveFile, path.join(scratch, "upgraded"), environment))
    await stage("upgrade.migrations-preserve-state", async () => {
      await upgraded.wrangler(["d1", "migrations", "apply", "FLEET_DB", "--local", "--persist-to", legacyStore])
      await verifyRuntime(upgraded, legacyStore, snapshot)
      await upgraded.wrangler(["d1", "migrations", "apply", "FLEET_DB", "--local", "--persist-to", legacyStore])
      await verifyRuntime(upgraded, legacyStore, snapshot)
    })
    return { requestId, status: "ready", version: fresh.release.version, releaseId: fresh.release.releaseId, checks,
      limitations: ["Local D1 and Worker runtime with synthetic configuration; no Cloudflare deployment or Access policy provisioning", "Upgrade coverage starts from the shipped legacy schema, not every historical application release"] }
  } finally { await fs.rm(scratch, { recursive: true, force: true }) }
}

if (isMainModule(import.meta.url)) {
  try {
    const options = parseCliOptions(process.argv.slice(2), [{ name: "help", short: "h", value: false }, { name: "directory", short: "d", value: true }])
    if (options.help) console.log("Usage: check-self-hosted-release.mjs --directory DIRECTORY\nVerify an already-built archive and its SHA-256 checksum, install its locked toolchain in temporary directories, and exercise fresh and legacy-schema upgrades using local D1.\nDependencies: Node.js 22+, npm, tar, package-registry access; no Cloudflare credentials.\nDoes not deploy or touch operator state. Temporary files are removed on completion.\nJSON result on stdout; bounded stage diagnostics on stderr.\nExit: 0 success/help, 1 verification failure, 2 usage, 3 missing dependency.")
    else {
      if (!options.directory) throw new CliUsageError("--directory is required")
      console.log(JSON.stringify(await checkSelfHostedRelease(path.resolve(options.directory), (record) => console.error(JSON.stringify(record)))))
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = error instanceof CliUsageError ? 2 : error.code === "ENOENT" ? 3 : 1
  }
}
