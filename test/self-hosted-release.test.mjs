import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { pathToFileURL } from "node:url"
import { gunzipSync, gzipSync } from "node:zlib"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { buildSelfHostedRelease } from "../scripts/build-self-hosted-release.mjs"
import { inspectSelfHostedRelease, releaseHash, releasePathIsSafe } from "../src/self-hosted-release.mjs"
import { inspectHostedRelease } from "../src/hosted-release-check.mjs"
import { runFleetCommand } from "../src/cli.mjs"
import { createFleetMcpServer } from "../src/mcp.mjs"
import { validateReleaseArchive } from "../scripts/check-self-hosted-release.mjs"

const execute = promisify(execFile)
let archiveRoot
let artifact
test.before(async () => {
  archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-release-unit-"))
  artifact = await buildSelfHostedRelease({ outputDirectory: archiveRoot })
})
test.after(async () => fs.rm(archiveRoot, { recursive: true, force: true }))

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-release-fixture-"))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  await execute("tar", ["-xzf", path.join(archiveRoot, artifact.filename), "-C", root])
  const releaseRoot = path.join(root, "package")
  const release = await inspectSelfHostedRelease(releaseRoot, artifact.version)
  const builder = await import(pathToFileURL(path.join(releaseRoot, "scripts/build-worker-assets.mjs")))
  await builder.buildWorkerAssets()
  const configFile = path.join(releaseRoot, "wrangler.jsonc")
  const configuration = JSON.parse(await fs.readFile(path.join(releaseRoot, "wrangler.example.jsonc"), "utf8"))
  await fs.writeFile(configFile, JSON.stringify(configuration))
  await fs.mkdir(path.join(releaseRoot, "node_modules/wrangler"), { recursive: true })
  await fs.writeFile(path.join(releaseRoot, "node_modules/wrangler/package.json"), JSON.stringify({ version: release.wranglerVersion }))
  const accountId = configuration.vars.FLEET_ACCOUNT_ID
  const calls = []
  const api = { async request(url, options = {}) {
    calls.push({ url, options })
    if (url.endsWith("/deployments")) return { result: { deployments: [{ id: "deployment", created_on: "2026-01-01T00:00:00Z", versions: [{ version_id: "version-one", percentage: 100 }] }] } }
    if (url.includes("/versions/")) return { result: { resources: { bindings: [{ type: "d1", name: "FLEET_DB", database_id: configuration.d1_databases[0].database_id }] } } }
    assert.equal(options.method, "POST")
    assert.match(options.body.sql, /^SELECT /)
    return { result: [{ success: true, results: options.body.sql.includes("sqlite_master") ? [{ name: "d1_migrations" }] : release.migrations.map((name) => ({ name })) }] }
  } }
  const remote = { async status() { return { accountId, storage: "d1", schema: "ready", readOnly: true, release } } }
  const fetchImpl = async () => new Response(null, { status: 302, headers: { Location: `${configuration.vars.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/login` } })
  return { root: releaseRoot, configFile, version: artifact.version, environment: {}, release, configuration, api, remote, fetchImpl, calls }
}

test("self-hosting archive includes a lockfile, an independent identity, and deterministic bytes", async (context) => {
  const f = await fixture(context)
  assert.equal(f.release.releaseId, artifact.releaseId)
  const other = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-release-repeat-"))
  context.after(() => fs.rm(other, { recursive: true, force: true }))
  const second = await buildSelfHostedRelease({ outputDirectory: other })
  assert.equal(second.sha256, artifact.sha256)
  assert.equal(releaseHash(await fs.readFile(path.join(other, second.filename))), artifact.sha256)
  await assert.rejects(buildSelfHostedRelease({ outputDirectory: other }), /EEXIST/)
  await assert.rejects(inspectSelfHostedRelease(f.root, "999.0.0"), /version does not match/)
})

test("release paths reject traversal and operator data", () => {
  for (const name of ["../secret", "/secret", "src/../../secret", "node_modules/a", ".env", "wrangler.jsonc", "fleet-policy.json", "state.json", "src//a", "src\\a"]) assert.equal(releasePathIsSafe(name), false, name)
})

test("artifact checker help is dependency-free and missing tools retain exit status", async () => {
  const script = new URL("../scripts/check-self-hosted-release.mjs", import.meta.url).pathname
  const environment = { ...process.env, PATH: "" }
  for (const help of ["-h", "--help"]) {
    const result = await execute(process.execPath, [script, help], { env: environment })
    assert.match(result.stdout, /Exit: 0 success\/help/)
    assert.equal(result.stderr, "")
  }
  await assert.rejects(execute(process.execPath, [script, "--directory", archiveRoot], { env: environment }), (error) => error.code === 3 && /tar.*ENOENT/.test(error.stderr))
})

test("archive extraction rejects traversal, links, and truncation before system tar runs", async () => {
  const archive = await fs.readFile(path.join(archiveRoot, artifact.filename))
  validateReleaseArchive(archive)
  for (const mutate of [
    (raw) => { raw.fill(0, 0, 100); raw.write("package/../outside", 0); return raw },
    (raw) => { raw[156] = 50; return raw },
    (raw) => raw.subarray(0, 1000),
  ]) assert.throws(() => validateReleaseArchive(gzipSync(mutate(gunzipSync(archive)))))
})

test("release inspection rejects changed, unlisted, missing, and symlinked runtime files", async (context) => {
  for (const mutation of [
    (root) => fs.appendFile(path.join(root, "src/app.mjs"), "\nchanged"),
    (root) => fs.writeFile(path.join(root, "src/unlisted.mjs"), "export default 1"),
    (root) => fs.rm(path.join(root, "package-lock.json")),
    async (root) => { await fs.rm(path.join(root, "src/app.mjs")); await fs.symlink("../package.json", path.join(root, "src/app.mjs")) },
  ]) {
    const f = await fixture(context)
    await mutation(f.root)
    const result = await inspectHostedRelease(f)
    assert.equal(result.status, "attention")
    assert.equal(result.checks[0].id, "release.integrity")
    assert.equal(f.calls.length, 0)
  }
})

test("offline preflight validates assets and configuration without network access", async (context) => {
  const f = await fixture(context)
  const result = await inspectHostedRelease(f)
  assert.equal(result.status, "ready", JSON.stringify(result))
  assert.equal(result.live, "not-requested")
  assert.equal(f.calls.length, 0)
  await fs.writeFile(path.join(f.root, ".worker-assets/unexpected.txt"), "not shipped")
  assert.equal((await inspectHostedRelease(f)).status, "attention")
})

test("preflight refuses missing dependencies, old release paths, and Access bypass", async (context) => {
  const f = await fixture(context)
  await fs.rm(path.join(f.root, "node_modules"), { recursive: true })
  assert.equal((await inspectHostedRelease(f)).checks.find((check) => check.id === "release.dependencies").code, "dependency")
  const g = await fixture(context)
  for (const update of [{ workers_dev: true }, { preview_urls: true }, { main: "src/app.mjs" }, { vars: { ...g.configuration.vars, FLEET_LOCAL_DEV: "true" } }]) {
    await fs.writeFile(g.configFile, JSON.stringify({ ...g.configuration, ...update }))
    const report = await inspectHostedRelease({ ...g, live: true })
    assert.equal(report.checks.find((check) => check.id === "configuration").status, "fail")
    assert.equal(g.calls.length, 0)
  }
})

test("live preflight checks migration names and reports the previous serving version", async (context) => {
  const f = await fixture(context)
  const result = await inspectHostedRelease({ ...f, live: true })
  assert.equal(result.status, "ready", JSON.stringify(result))
  assert.equal(result.deployment.versions[0].id, "version-one")
  assert.deepEqual(result.migrations, { pending: [], unexpected: [] })
  const read = f.api.request
  f.api.request = (url, options) => options?.body?.sql.includes("FROM d1_migrations")
    ? { result: [{ success: true, results: [{ name: "future.sql" }] }] } : read(url, options)
  const mismatch = await inspectHostedRelease({ ...f, live: true })
  assert.equal(mismatch.status, "attention")
  assert.equal(mismatch.migrations.pending.length, f.release.migrations.length)
  assert.deepEqual(mismatch.migrations.unexpected, ["future.sql"])
})

test("first-install preflight distinguishes absent Worker from denied reads", async (context) => {
  const f = await fixture(context)
  const read = f.api.request
  f.api.request = (url, options) => { if (url.endsWith("/deployments")) throw Object.assign(new Error("upstream secret"), { status: 404 }); return read(url, options) }
  assert.equal((await inspectHostedRelease({ ...f, live: true })).status, "attention")
  const install = await inspectHostedRelease({ ...f, live: true, install: true })
  assert.equal(install.status, "ready")
  assert.equal(install.deployment.status, "not-created")
  f.api.request = () => { throw Object.assign(new Error("upstream secret"), { status: 403 }) }
  const denied = await inspectHostedRelease({ ...f, live: true, install: true })
  assert.equal(denied.status, "attention")
  assert.doesNotMatch(JSON.stringify(denied), /upstream secret/)
  assert.equal(denied.checks.find((check) => check.id === "deployment").httpStatus, 403)
})

test("live checks reject account conflicts, missing migration tables, split deployments, and cancelled reads", async (context) => {
  const f = await fixture(context)
  assert.equal((await inspectHostedRelease({ ...f, live: true, environment: { CLOUDFLARE_ACCOUNT_ID: "b".repeat(32) } })).status, "attention")
  assert.equal(f.calls.length, 0)
  const cancelled = AbortSignal.abort()
  assert.equal((await inspectHostedRelease({ ...f, live: true, signal: cancelled })).checks[0].code, "timeout-or-cancelled")
  assert.equal(f.calls.length, 0)
  const read = f.api.request
  f.api.request = (url, options) => options?.body?.sql.includes("sqlite_master") ? { result: [{ success: true, results: [] }] } : read(url, options)
  const missing = await inspectHostedRelease({ ...f, live: true, install: true })
  assert.deepEqual(missing.migrations.pending, f.release.migrations)
  assert.equal(missing.status, "attention")
  f.api.request = (url, options) => url.endsWith("/deployments")
    ? { result: { deployments: [{ id: "split", created_on: "2026-01-01T00:00:00Z", versions: [{ version_id: "one", percentage: 50 }, { version_id: "two", percentage: 50 }] }] } }
    : read(url, options)
  assert.equal((await inspectHostedRelease({ ...f, verify: true })).checks.find((check) => check.id === "deployment").status, "fail")
})

test("verification checks live identity, data readiness and anonymous rejection", async (context) => {
  const f = await fixture(context)
  assert.equal((await inspectHostedRelease({ ...f, verify: true })).status, "ready")
  for (const status of [{}, { accountId: f.configuration.vars.FLEET_ACCOUNT_ID, storage: "d1", schema: "ready", readOnly: true, release: { ...f.release, releaseId: "old" } }]) {
    const report = await inspectHostedRelease({ ...f, verify: true, remote: { status: async () => status } })
    assert.equal(report.status, "attention")
  }
  assert.equal((await inspectHostedRelease({ ...f, verify: true, fetchImpl: async () => new Response("public", { status: 200 }) })).status, "attention")
  assert.equal((await inspectHostedRelease({ ...f, verify: true, fetchImpl: async () => new Response(null, { status: 302, headers: { Location: "https://wrong.example/" } }) })).status, "attention")
  const read = f.api.request
  f.api.request = (url, options) => url.includes("/versions/") ? { result: { resources: { bindings: [] } } } : read(url, options)
  assert.equal((await inspectHostedRelease({ ...f, verify: true })).checks.find((check) => check.id === "deployment").status, "fail")
})

test("CLI and MCP expose the same read-only release report without arbitrary MCP paths", async (context) => {
  const f = await fixture(context)
  const result = await inspectHostedRelease(f)
  let output = ""
  let exitCode
  await runFleetCommand({ argv: ["hosted", "check", `--version=${f.version}`, "-fjson"], environment: {}, stdout: { write(value) { output += value } }, stderr: { write() {} }, inspectHostedRelease: async () => result, onExitCode(code) { exitCode = code } })
  assert.equal(exitCode, 0)
  assert.deepEqual(JSON.parse(output), result)
  for (const help of ["-h", "--help"]) {
    output = ""
    await runFleetCommand({ argv: ["hosted", "verify", help], environment: {}, stdout: { write(value) { output += value } }, onExitCode() {} })
    assert.match(output, /Exit:/)
  }
  const server = createFleetMcpServer({ environment: {}, inspectHostedRelease: async () => result })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "release-test", version: "1.0.0" })
  await client.connect(clientTransport)
  context.after(async () => { await client.close(); await server.close() })
  assert.deepEqual((await client.callTool({ name: "check_hosted_release", arguments: { version: f.version } })).structuredContent, result)
  assert.equal((await client.callTool({ name: "check_hosted_release", arguments: { version: f.version, root: "/arbitrary" } })).isError, true)
  assert.equal((await client.callTool({ name: "verify_hosted_release", arguments: {} })).isError, true)
})
