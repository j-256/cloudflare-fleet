import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"
import test from "node:test"

import { buildSelfHostedRelease } from "../scripts/build-self-hosted-release.mjs"
import { deployProductionRelease, prepareProductionArtifact, productionUploadConfiguration, requireCurrentMain, requireProductionContext } from "../scripts/deploy-production.mjs"
import { inspectSelfHostedRelease, releaseContentId, releaseHash } from "../src/self-hosted-release.mjs"

const execute = promisify(execFile)
const SOURCE = "a".repeat(40)
const BASE_ENVIRONMENT = Object.freeze({
  GITHUB_ACTIONS: "true", GITHUB_JOB: "production", GITHUB_REF: "refs/heads/main", GITHUB_REF_PROTECTED: "true",
  GITHUB_REPOSITORY: "example/fleet", GITHUB_WORKFLOW_REF: "example/fleet/.github/workflows/ci.yml@refs/heads/main",
  GITHUB_EVENT_NAME: "push", GITHUB_SHA: SOURCE, GH_TOKEN: "synthetic-github-credential",
  CLOUDFLARE_FLEET_DEPLOY_PRODUCTION: "true", CLOUDFLARE_FLEET_VERIFICATION_RESULT: "success",
  CLOUDFLARE_FLEET_ARTIFACT_SHA256: "b".repeat(64), CLOUDFLARE_API_TOKEN: "synthetic-deploy-credential",
  CLOUDFLARE_FLEET_ACCESS_CLIENT_ID: "synthetic-access-client", CLOUDFLARE_FLEET_ACCESS_CLIENT_SECRET: "synthetic-access-secret",
})
let archiveRoot
let artifact
test.before(async () => {
  archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-production-tests-"))
  artifact = await buildSelfHostedRelease({ outputDirectory: archiveRoot })
})
test.after(async () => fs.rm(archiveRoot, { recursive: true, force: true }))

async function fixture(context) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-production-fixture-"))
  context.after(() => fs.rm(scratch, { recursive: true, force: true }))
  await execute("tar", ["-xzf", path.join(archiveRoot, artifact.filename), "-C", scratch])
  const root = path.join(scratch, "package")
  const manifestFile = path.join(root, "release-manifest.json")
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"))
  manifest.sourceRevision = SOURCE
  manifest.releaseId = releaseContentId(manifest)
  const identity = `${JSON.stringify({ schemaVersion: 1, version: manifest.version, sourceRevision: SOURCE, releaseId: manifest.releaseId })}\n`
  await fs.writeFile(path.join(root, "release-identity.json"), identity)
  manifest.files["release-identity.json"] = releaseHash(identity)
  await fs.writeFile(manifestFile, JSON.stringify(manifest))
  const release = await inspectSelfHostedRelease(root, manifest.version)
  const builder = await import(pathToFileURL(path.join(root, "scripts/build-worker-assets.mjs")))
  await builder.buildWorkerAssets()
  await fs.mkdir(path.join(root, "node_modules/wrangler"), { recursive: true })
  await fs.writeFile(path.join(root, "node_modules/wrangler/package.json"), JSON.stringify({ version: release.wranglerVersion }))
  const config = JSON.parse(await fs.readFile(path.join(root, "wrangler.example.jsonc"), "utf8"))
  const environment = { ...BASE_ENVIRONMENT, CLOUDFLARE_ACCOUNT_ID: config.vars.FLEET_ACCOUNT_ID,
    CLOUDFLARE_FLEET_URL: `https://${config.routes[0].pattern}`, CLOUDFLARE_FLEET_DEPLOYMENT_CONFIG: JSON.stringify(config),
    CLOUDFLARE_FLEET_RELEASE_ID: release.releaseId }
  const f = { root, scratch, manifest, release, config, environment, commands: [], requests: [], progress: [], deployed: false,
    changedVersion: false, pendingMigrations: false, verificationMisses: 0, statusCalls: 0, observationChanges: {} }
  const bindings = () => [...Object.entries(config.vars).map(([name, text]) => ({ name, type: "plain_text", text })),
    { name: "ASSETS", type: "assets" }, { name: "CLOUDFLARE_API_TOKEN", type: "secret_text" },
    { name: "FLEET_DB", type: "d1", database_id: config.d1_databases[0].database_id }]
  const api = { accountId: config.vars.FLEET_ACCOUNT_ID, async request(url, options = {}) {
    f.requests.push({ url, method: options.method || "GET", sql: options.body?.sql })
    if (url.endsWith("/deployments")) return { result: { deployments: [{ id: f.deployed || f.changedVersion ? "deployment-new" : "deployment-old", created_on: "2026-01-01T00:00:00Z", versions: [{ version_id: f.deployed || f.changedVersion ? "version-new" : "version-old", percentage: 100 }] }] } }
    if (url.includes("/versions/")) return { result: { resources: { bindings: bindings(), script: { handlers: ["fetch"] } } } }
    if (url.endsWith("/settings")) return { result: { bindings: bindings(), limits: config.limits, observability: config.observability } }
    if (url.endsWith("/subdomain")) return { result: { enabled: false, previews_enabled: false, ...f.observationChanges.subdomain } }
    if (url.endsWith("/schedules")) return { result: { schedules: f.observationChanges.schedules || [] } }
    if (url.endsWith("/workers/domains")) return { result: f.observationChanges.domains || [{ service: config.name, hostname: config.routes[0].pattern, zone_id: "b".repeat(32) }] }
    assert.equal(options.method, "POST")
    assert.match(options.body.sql, /^SELECT /)
    return { result: [{ success: true, results: options.body.sql.includes("sqlite_master") ? [{ name: "d1_migrations" }]
      : (f.pendingMigrations ? release.migrations.slice(1) : release.migrations).map((name) => ({ name })) }] }
  } }
  f.dependencies = { api,
    githubFetch: async (url, options) => {
      assert.equal(url, "https://api.github.com/repos/example/fleet/branches/main")
      assert.equal(options.redirect, "manual")
      return Response.json({ protected: true, commit: { sha: SOURCE } })
    },
    remote: { async status() {
      f.statusCalls += 1
      const visible = f.deployed && f.verificationMisses-- <= 0
      return { accountId: config.vars.FLEET_ACCOUNT_ID, storage: "d1", schema: "ready", readOnly: config.vars.FLEET_READ_ONLY === "true", release: visible ? release : null }
    } },
    fetchImpl: async () => new Response(null, { status: 302, headers: { Location: `${config.vars.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/login` } }),
    command: async (program, args, cwd, environment) => {
      assert.equal(program, process.execPath)
      assert.equal(cwd, root)
      assert.equal(args[0], path.join(root, "node_modules/wrangler/bin/wrangler.js"))
      assert.equal(args[1], "deploy")
      assert.ok(args.includes("--keep-vars"))
      assert.equal(environment.GH_TOKEN, undefined)
      assert.equal(environment.CLOUDFLARE_FLEET_ACCESS_CLIENT_SECRET, undefined)
      assert.equal(environment.CLOUDFLARE_FLEET_DEPLOYMENT_CONFIG, undefined)
      assert.equal(Boolean(environment.CLOUDFLARE_API_TOKEN), !args.includes("--dry-run"))
      const upload = JSON.parse(await fs.readFile(args[3], "utf8"))
      assert.equal(upload.routes, undefined)
      assert.equal(upload.triggers, undefined)
      assert.equal(upload.build, undefined)
      assert.deepEqual(upload.vars, {})
      assert.deepEqual(upload.secrets.required, ["CLOUDFLARE_API_TOKEN"])
      f.commands.push(args)
      if (!args.includes("--dry-run")) f.deployed = true
      return { stdout: "", stderr: "" }
    },
    delay: async () => {}, onProgress: (record) => f.progress.push(record),
  }
  return f
}

test("production context rejects untrusted events, refs, workflow identity, opt-out, and incomplete verification", () => {
  requireProductionContext(BASE_ENVIRONMENT)
  for (const changes of [
    { GITHUB_ACTIONS: "false" }, { GITHUB_JOB: "verify" }, { GITHUB_REF: "refs/heads/topic" }, { GITHUB_REF_PROTECTED: "false" },
    { GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_EVENT_NAME: "pull_request_target" }, { GITHUB_EVENT_NAME: "workflow_run" },
    { GITHUB_WORKFLOW_REF: "other/repo/.github/workflows/ci.yml@refs/heads/main" },
    { CLOUDFLARE_FLEET_DEPLOY_PRODUCTION: "false" }, { CLOUDFLARE_FLEET_VERIFICATION_RESULT: "failure" },
    { CLOUDFLARE_FLEET_VERIFICATION_RESULT: "skipped" }, { CLOUDFLARE_FLEET_VERIFICATION_RESULT: "cancelled" },
    { GITHUB_EVENT_NAME: "workflow_dispatch", CLOUDFLARE_FLEET_CI_OPERATION: "verify" },
    { GITHUB_SHA: "main" }, { CLOUDFLARE_FLEET_ARTIFACT_SHA256: "" },
  ]) assert.throws(() => requireProductionContext({ ...BASE_ENVIRONMENT, ...changes }))
  requireProductionContext({ ...BASE_ENVIRONMENT, GITHUB_EVENT_NAME: "workflow_dispatch", CLOUDFLARE_FLEET_CI_OPERATION: "deploy-production" })
})

test("main head must remain protected and equal the selected revision", async () => {
  for (const [status, value] of [[403, {}], [302, {}], [200, { protected: false, commit: { sha: SOURCE } }], [200, { protected: true, commit: { sha: "c".repeat(40) } }]]) {
    await assert.rejects(requireCurrentMain(BASE_ENVIRONMENT, async () => new Response(JSON.stringify(value), { status })))
  }
})

test("preparation checks the upstream digest and source before exposing a release directory", async (context) => {
  const f = await fixture(context)
  const download = path.join(f.scratch, "download")
  await fs.mkdir(download)
  const archive = path.join(download, artifact.filename)
  await execute("tar", ["--format=ustar", "-czf", archive, "-C", f.scratch, ...["release-manifest.json", ...Object.keys(f.manifest.files)].map((name) => `package/${name}`)])
  const environment = { ...f.environment, PATH: process.env.PATH, CLOUDFLARE_FLEET_ARTIFACT_SHA256: releaseHash(await fs.readFile(archive)) }
  const prepared = await prepareProductionArtifact(download, environment)
  context.after(() => fs.rm(path.dirname(prepared.releaseDir), { recursive: true, force: true }))
  assert.equal(prepared.releaseId, f.release.releaseId)
  assert.equal((await fs.stat(path.dirname(prepared.releaseDir))).mode & 0o777, 0o700)
  await assert.rejects(prepareProductionArtifact(download, { ...environment, PATH: "" }), { code: "dependency" })
  await assert.rejects(prepareProductionArtifact(download, { ...environment, GITHUB_SHA: "c".repeat(40) }), /source revision differs/)
  await fs.appendFile(archive, "changed")
  await assert.rejects(prepareProductionArtifact(download, environment), /bytes differ/)
})

test("production deployment performs one upload and verifies preserved configuration and protected release identity", async (context) => {
  const f = await fixture(context)
  const result = await deployProductionRelease(f.root, f.environment, f.dependencies)
  assert.equal(result.status, "verified")
  assert.equal(result.sourceRevision, SOURCE)
  assert.equal(f.commands.filter((args) => !args.includes("--dry-run")).length, 1)
  assert.equal(f.commands.length, 2)
  assert.ok(f.requests.every(({ method, sql }) => method === "GET" || (method === "POST" && sql.startsWith("SELECT "))))
  assert.doesNotMatch(JSON.stringify({ result, progress: f.progress }), /synthetic-access-secret|synthetic-deploy-credential|FLEET_POLICY_JSON/)
  await assert.rejects(fs.access(path.join(f.root, "wrangler.jsonc")), { code: "ENOENT" })
  await assert.rejects(fs.access(path.join(f.root, ".wrangler/production.json")), { code: "ENOENT" })
})

test("pending migrations, insecure ingress, unexpected schedules, and wrong domain ownership block uploads", async (context) => {
  for (const mutate of [
    (f) => { f.pendingMigrations = true },
    (f) => { f.observationChanges.subdomain = { enabled: true } },
    (f) => { f.observationChanges.schedules = [{ cron: "* * * * *" }] },
    (f) => { f.observationChanges.domains = [{ service: "another-worker", hostname: f.config.routes[0].pattern }] },
    (f) => { f.config.vars.FLEET_READ_ONLY = "false" },
    (f) => { f.environment.CLOUDFLARE_FLEET_RELEASE_ID = "c".repeat(64) },
  ]) {
    const f = await fixture(context)
    mutate(f)
    await assert.rejects(deployProductionRelease(f.root, f.environment, f.dependencies))
    assert.equal(f.commands.length, 0)
  }
})

test("failed authenticated preflight and an anonymous auth bypass block upload", async (context) => {
  for (const change of [
    (f) => { f.dependencies.remote.status = async () => { throw new Error("private provider credential") } },
    (f) => { f.dependencies.fetchImpl = async () => new Response("unexpected", { status: 200 }) },
  ]) {
    const f = await fixture(context)
    change(f)
    await assert.rejects(deployProductionRelease(f.root, f.environment, f.dependencies), (error) => !error.message.includes("private provider credential"))
    assert.equal(f.commands.length, 0)
  }
})

test("a changed main head or serving version after dry-run prevents mutation", async (context) => {
  for (const target of ["main", "serving"]) {
    const f = await fixture(context)
    const run = f.dependencies.command
    f.dependencies.command = async (...args) => {
      await run(...args)
      if (target === "main") f.dependencies.githubFetch = async () => Response.json({ protected: true, commit: { sha: "c".repeat(40) } })
      else f.changedVersion = true
    }
    await assert.rejects(deployProductionRelease(f.root, f.environment, f.dependencies), /stale|changed during preflight/)
    assert.equal(f.commands.length, 1)
    assert.equal(f.deployed, false)
  }
})

test("post-deploy propagation retries are read-only and bounded", async (context) => {
  const f = await fixture(context)
  f.verificationMisses = 2
  assert.equal((await deployProductionRelease(f.root, f.environment, f.dependencies)).status, "verified")
  assert.equal(f.progress.filter((record) => record.stage === "verification.retry").length, 2)
  assert.equal(f.commands.length, 2)
  const g = await fixture(context)
  g.verificationMisses = 100
  await assert.rejects(deployProductionRelease(g.root, g.environment, g.dependencies), { code: "verification-failed" })
  assert.equal(g.progress.filter((record) => record.stage === "verification.retry").length, 6)
  assert.equal(g.commands.length, 2)
})

test("an indeterminate upload is never retried or automatically rolled back", async (context) => {
  const f = await fixture(context)
  const run = f.dependencies.command
  f.dependencies.command = async (...args) => {
    await run(...args)
    if (f.deployed) throw new Error("private provider response containing credentials")
  }
  await assert.rejects(deployProductionRelease(f.root, f.environment, f.dependencies), (error) => error.code === "upload-indeterminate" && !error.message.includes("private provider response"))
  assert.equal(f.commands.length, 2)
  assert.equal(f.progress.at(-1).stage, "deployment.upload-once")
})

test("upload configuration cannot manage routes, schedules, server variables, or custom builds", () => {
  const configuration = { name: "fleet", routes: [{ custom_domain: true }], triggers: { crons: [] }, vars: { PRIVATE: "value" }, build: { command: "unneeded" }, secrets: { required: ["CLOUDFLARE_API_TOKEN"] } }
  assert.deepEqual(productionUploadConfiguration(configuration), { name: "fleet", vars: {}, secrets: configuration.secrets })
  assert.equal(configuration.vars.PRIVATE, "value")
})

test("the pinned Wrangler's real upload metadata preserves server variables and secrets without their values", async (context) => {
  const f = await fixture(context)
  const entry = path.join(f.scratch, "synthetic-worker.mjs")
  await fs.writeFile(entry, "export default { fetch() { return new Response('synthetic') } }\n")
  const configuration = productionUploadConfiguration({ ...f.config, main: entry,
    assets: { ...f.config.assets, directory: path.join(f.root, ".worker-assets") } })
  const configFile = path.join(f.scratch, "upload.json")
  const output = path.join(f.scratch, "upload.body")
  await fs.writeFile(configFile, JSON.stringify(configuration))
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLOUDFLARE_|CF_|WRANGLER_|XDG_)/.test(name)))
  Object.assign(environment, { CI: "true", WRANGLER_SEND_METRICS: "false", CLOUDFLARE_ACCOUNT_ID: f.config.vars.FLEET_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: "synthetic-deploy-credential", XDG_CONFIG_HOME: path.join(f.scratch, "config"),
    XDG_STATE_HOME: path.join(f.scratch, "state"), XDG_CACHE_HOME: path.join(f.scratch, "cache") })
  await execute(process.execPath, [new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url).pathname, "deploy", "--config", configFile,
    "--keep-vars", "--dry-run", "--outfile", output], { cwd: f.scratch, env: environment, timeout: 30000 })
  const body = await fs.readFile(output)
  const boundary = body.subarray(2, body.indexOf("\r\n")).toString()
  const form = await new Response(body, { headers: { "content-type": `multipart/form-data; boundary=${boundary}` } }).formData()
  const part = form.get("metadata")
  const metadata = JSON.parse(typeof part === "string" ? part : await part.text())
  assert.deepEqual(metadata.keep_bindings.sort(), ["plain_text", "json", "secret_text", "secret_key"].sort())
  assert.doesNotMatch(JSON.stringify(metadata), /synthetic-deploy-credential|FLEET_POLICY_JSON|ACCESS_AUD/)
  assert.ok(metadata.bindings.some((binding) => binding.name === "CLOUDFLARE_API_TOKEN" && binding.type === "inherit"))
})

test("internal CI helper supports help and refuses local deployment without touching production", async () => {
  const script = new URL("../scripts/deploy-production.mjs", import.meta.url).pathname
  for (const help of ["-h", "--help"]) {
    const result = await execute(process.execPath, [script, help], { env: { PATH: "" } })
    assert.match(result.stdout, /Internal protected GitHub Actions/)
    assert.equal(result.stderr, "")
  }
  for (const args of [[], ["--unknown"], ["--release-dir"], ["-r", "."], ["--release-dir=.", "--prepare"]]) {
    await assert.rejects(execute(process.execPath, [script, ...args], { env: { PATH: "" } }), (error) => error.code === 2 && !error.stdout)
  }
})

test("the workflow gates secrets and same-run artifacts behind complete verification and protected main", async () => {
  const source = await fs.readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")
  const job = source.match(/\n  production:[\s\S]*?(?=\n  [\w-]+:|$)/)?.[0]
  assert.ok(job, "The production job must be present")
  for (const contract of ["needs: verify", "needs.verify.result == 'success'", "github.ref_protected", "github.ref == 'refs/heads/main'", "vars.CLOUDFLARE_FLEET_DEPLOY_PRODUCTION == 'true'", "name: production", "group: fleet-production", "cancel-in-progress: false", "name: self-hosted-release", "needs.verify.outputs.hosting_sha256", "persist-credentials: false", "CLOUDFLARE_FLEET_RELEASE_ID: ${{ steps.prepare.outputs.release_id }}"]) assert.ok(job.includes(contract), contract)
  assert.doesNotMatch(job, /workflow_run|pull_request_target|secrets: inherit|db:migrate|secrets bulk|rollback|continue-on-error|always\(\)/)
  assert.ok(job.indexOf("npm ci --include=dev") < job.indexOf("secrets.CLOUDFLARE_WORKERS_DEPLOY_TOKEN"))
  assert.match(source, /npm audit --audit-level=high/)
})
