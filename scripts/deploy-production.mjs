import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify, isDeepStrictEqual } from "node:util"

import { CloudflareApi } from "../src/api.mjs"
import { CliUsageError, parseCliOptions } from "../src/cli-options.mjs"
import { isMainModule } from "../src/entrypoint.mjs"
import { readRegularReleaseFile } from "../src/release-files.mjs"
import { inspectHostedRelease, readHostedReleaseConfiguration } from "../src/hosted-release-check.mjs"
import { createRemoteFleetService } from "../src/remote-fleet-service.mjs"
import { inspectSelfHostedRelease, releaseHash } from "../src/self-hosted-release.mjs"
import { inspectWorker } from "../src/worker-inspection.mjs"
import { validateReleaseArchive } from "./check-self-hosted-release.mjs"

const execute = promisify(execFile)
const MAIN_REF = "refs/heads/main"
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const MAX_CONFIG_BYTES = 1024 * 1024
const COMMAND_TIMEOUT_MS = 180000
const READ_TIMEOUT_MS = 30000
const VERIFY_ATTEMPTS = 6
const VERIFY_DELAY_MS = 10000
const SOURCE_PATTERN = /^[a-f0-9]{40}$/
const DIGEST_PATTERN = /^[a-f0-9]{64}$/
const VARIABLE_NAMES = Object.freeze(["ACCESS_AUD", "ACCESS_TEAM_DOMAIN", "FLEET_ACCOUNT_ID", "FLEET_POLICY_JSON", "FLEET_READ_ONLY"])

class DeploymentError extends Error {
  constructor(message, code = "precondition", details = {}) {
    super(message)
    this.code = code
    this.details = details
  }
}

function requireValue(condition, message, code) {
  if (!condition) throw new DeploymentError(message, code)
}

export function requireProductionContext(environment) {
  requireValue(environment.GITHUB_ACTIONS === "true" && environment.GITHUB_JOB === "production", "Production deployment requires its GitHub Actions production job")
  requireValue(environment.GITHUB_REF === MAIN_REF && environment.GITHUB_REF_PROTECTED === "true", "Production deployment requires protected main")
  requireValue(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(environment.GITHUB_REPOSITORY || "")
    && environment.GITHUB_WORKFLOW_REF === `${environment.GITHUB_REPOSITORY}/.github/workflows/ci.yml@${MAIN_REF}`, "Production deployment requires the repository's main CI workflow")
  requireValue(environment.GITHUB_EVENT_NAME === "push"
    || (environment.GITHUB_EVENT_NAME === "workflow_dispatch" && environment.CLOUDFLARE_FLEET_CI_OPERATION === "deploy-production"), "This event does not authorize production deployment")
  requireValue(environment.CLOUDFLARE_FLEET_DEPLOY_PRODUCTION === "true" && environment.CLOUDFLARE_FLEET_VERIFICATION_RESULT === "success", "Production deployment must be enabled and the complete verification job must pass")
  requireValue(SOURCE_PATTERN.test(environment.GITHUB_SHA || ""), "A complete workflow source revision is required")
  requireValue(DIGEST_PATTERN.test(environment.CLOUDFLARE_FLEET_ARTIFACT_SHA256 || ""), "The verification job's archive digest is required")
}

async function command(program, args, root, environment) {
  try {
    return await execute(program, args, { cwd: root, env: environment, encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 })
  } catch (error) {
    if (error.code === "ENOENT") throw new DeploymentError("A required deployment executable is unavailable", "dependency")
    // Provider bodies and command output can contain private configuration
    throw new DeploymentError("Deployment command failed or timed out; inspect the serving Worker before retrying", "command-failed", {
      exitCode: Number.isInteger(error.code) ? error.code : null,
      signal: ["SIGTERM", "SIGKILL", "SIGINT"].includes(error.signal) ? error.signal : null,
    })
  }
}

export async function prepareProductionArtifact(directory, environment = process.env) {
  requireProductionContext(environment)
  const names = (await fs.readdir(directory)).filter((name) => /^cloudflare-fleet-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-self-hosted\.tgz$/.test(name))
  requireValue(names.length === 1, "Download exactly one self-hosting archive from this workflow's verification job")
  const archiveFile = path.resolve(directory, names[0])
  const { content: archive } = await readRegularReleaseFile(archiveFile, MAX_ARCHIVE_BYTES)
  requireValue(releaseHash(archive) === environment.CLOUDFLARE_FLEET_ARTIFACT_SHA256, "Archive bytes differ from the passing verification job")
  validateReleaseArchive(archive)
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-production-"))
  await fs.chmod(scratch, 0o700)
  try {
    const verified = path.join(scratch, "verified.tgz")
    await fs.writeFile(verified, archive, { mode: 0o600, flag: "wx" })
    await command("tar", ["-xzf", verified, "-C", scratch], scratch, environment)
    const root = path.join(scratch, "package")
    const manifest = JSON.parse(await fs.readFile(path.join(root, "release-manifest.json"), "utf8"))
    const release = await inspectSelfHostedRelease(root, manifest.version)
    requireValue(release.sourceRevision === environment.GITHUB_SHA, "Archive source revision differs from the passing workflow")
    return { releaseDir: root, releaseId: release.releaseId, version: release.version, sourceRevision: release.sourceRevision }
  } catch (error) {
    await fs.rm(scratch, { recursive: true, force: true })
    throw error
  }
}

export async function requireCurrentMain(environment, fetchImpl = globalThis.fetch) {
  requireValue(Boolean(environment.GH_TOKEN), "The job's read-only GitHub token is required")
  const response = await fetchImpl(`https://api.github.com/repos/${environment.GITHUB_REPOSITORY}/branches/main`, {
    headers: { Authorization: `Bearer ${environment.GH_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    redirect: "manual", signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  })
  requireValue(response.status === 200, "Cannot establish the protected main head through GitHub")
  const branch = await response.json()
  requireValue(branch.protected === true && branch.commit?.sha === environment.GITHUB_SHA, "This run is stale or main is no longer protected; deploy the passing main-head run")
}

export function releaseLocalConfiguration(source, root) {
  requireValue(typeof source === "string" && Buffer.byteLength(source) <= MAX_CONFIG_BYTES, "The private deployment configuration is missing or too large")
  let configuration
  try { configuration = JSON.parse(source) } catch { throw new DeploymentError("Deployment configuration must be generated Wrangler JSON, not commented JSONC") }
  requireValue(configuration && Array.isArray(configuration.d1_databases) && configuration.d1_databases.length === 1 && configuration.assets, "Deployment configuration is incomplete")
  requireValue(isDeepStrictEqual(Object.keys(configuration.vars || {}).sort(), [...VARIABLE_NAMES].sort()), "Review unexpected runtime variables before enabling production deployment")
  requireValue(isDeepStrictEqual(configuration.secrets?.required, ["CLOUDFLARE_API_TOKEN"]), "Preserve the existing runtime Cloudflare secret declaration")
  return { ...configuration, main: path.join(root, "src/hosted/worker.mjs"),
    assets: { ...configuration.assets, directory: path.join(root, ".worker-assets") },
    d1_databases: [{ ...configuration.d1_databases[0], migrations_dir: path.join(root, "migrations") }] }
}

export function productionUploadConfiguration(configuration) {
  const { routes: _routes, triggers: _triggers, vars: _vars, build: _build, ...upload } = configuration
  // Ingress and schedules are provider-owned; --keep-vars preserves server values and secrets
  return { ...upload, vars: {} }
}

function wranglerEnvironment(environment, dryRun = false) {
  const selected = Object.fromEntries(Object.entries(environment).filter(([name]) => !/^(GITHUB_|GH_|CLOUDFLARE_FLEET_)/.test(name)))
  if (dryRun) delete selected.CLOUDFLARE_API_TOKEN
  return { ...selected, CI: "true", WRANGLER_SEND_METRICS: "false" }
}

function checkFailure(report) {
  return report.checks.filter((check) => check.status !== "pass").map(({ id, code, httpStatus, upstreamRequestId }) => ({ id, code, httpStatus, upstreamRequestId }))
}

async function requireServingConfiguration(api, configured, dependencies) {
  const signal = AbortSignal.timeout(READ_TIMEOUT_MS)
  const { configuration, target } = configured
  const inspected = await (dependencies.inspectWorker || inspectWorker)(api, { worker: target.worker, logs: false }, { signal })
  requireValue(inspected.deployment?.status === "observed" && inspected.deployment.value.versions.length === 1
    && inspected.deployment.value.versions[0].percentage === 100, "Require one fully serving version before deployment")
  requireValue(inspected.ingress?.status === "observed" && inspected.ingress.value.workersDev === false && inspected.ingress.value.previews === false, "Alternate Worker URLs must remain disabled")
  requireValue(inspected.schedules?.status === "observed" && inspected.schedules.value.length === 0, "Cron schedules require separate operator review")
  requireValue(inspected.domains?.status === "observed" && !inspected.domains.value.limited && !inspected.domains.value.paginationIncomplete
    && inspected.domains.value.items.length === 1 && inspected.domains.value.items[0].hostname === new URL(target.endpoint).hostname, "The existing custom domain must belong exclusively to the selected Worker")
  const base = `accounts/${target.accountId}/workers/scripts/${target.worker}`
  const version = inspected.deployment.value.versions[0].id
  const metadata = (await api.request(`${base}/versions/${version}`, { signal })).result
  const bindings = metadata?.resources?.bindings
  const expected = [...VARIABLE_NAMES, "ASSETS", "FLEET_DB", "CLOUDFLARE_API_TOKEN"].sort()
  requireValue(Array.isArray(bindings) && isDeepStrictEqual(bindings.map((binding) => binding.name).sort(), expected), "Serving bindings differ from the reviewed application contract")
  for (const name of VARIABLE_NAMES) {
    const binding = bindings.find((entry) => entry.name === name)
    requireValue(binding.type === "plain_text" && binding.text === configuration.vars[name], `Serving variable ${name} differs from the private deployment configuration`)
  }
  requireValue(bindings.find((entry) => entry.name === "CLOUDFLARE_API_TOKEN").type === "secret_text"
    && bindings.find((entry) => entry.name === "ASSETS").type === "assets"
    && bindings.find((entry) => entry.name === "FLEET_DB").type === "d1"
    && bindings.find((entry) => entry.name === "FLEET_DB").database_id === target.databaseId, "Runtime secret, asset, or database binding differs")
  const settings = (await api.request(`${base}/settings`, { signal })).result
  requireValue(isDeepStrictEqual(settings?.limits, configuration.limits)
    && (!settings.tail_consumers || settings.tail_consumers.length === 0) && settings.logpush !== true, "Serving execution limits or log destinations require review")
  requireValue(settings.observability?.logs?.enabled === configuration.observability?.logs?.enabled
    && settings.observability?.logs?.invocation_logs === configuration.observability?.logs?.invocation_logs, "Serving logging policy differs from deployment configuration")
  return { deploymentId: inspected.deployment.value.id, versionId: version }
}

async function requireExistingApplication(configured, environment, dependencies) {
  const signal = AbortSignal.timeout(READ_TIMEOUT_MS)
  const { target } = configured
  const remote = dependencies.remote || createRemoteFleetService({ environment: { ...environment,
    CLOUDFLARE_FLEET_BACKEND: "hosted", CLOUDFLARE_FLEET_URL: target.endpoint, CLOUDFLARE_FLEET_ACCOUNT_ID: target.accountId } })
  const status = await remote.status({ signal })
  requireValue(status.accountId === target.accountId && status.storage === "d1" && status.schema === "ready" && status.readOnly === target.readOnly, "Authenticated application or storage is not ready; deployment was not attempted")
  const response = await (dependencies.fetchImpl || globalThis.fetch)(`${target.endpoint}/api/commands`, { redirect: "manual", signal })
  const location = response.headers.get("location")
  const redirected = [301, 302, 303, 307, 308].includes(response.status) && location && new URL(location, target.endpoint).origin === target.accessOrigin
  await response.body?.cancel()
  requireValue(response.status === 403 || redirected, "Anonymous application access is not denied by the intended boundary")
}

export async function deployProductionRelease(root, environment = process.env, dependencies = {}) {
  requireProductionContext(environment)
  requireValue(Boolean(environment.CLOUDFLARE_API_TOKEN) && Boolean(environment.CLOUDFLARE_ACCOUNT_ID), "Dedicated deployment credentials and account are required")
  requireValue(Boolean(environment.CLOUDFLARE_FLEET_ACCESS_CLIENT_ID && environment.CLOUDFLARE_FLEET_ACCESS_CLIENT_SECRET), "A dedicated Fleet Access service credential pair is required")
  requireValue(DIGEST_PATTERN.test(environment.CLOUDFLARE_FLEET_RELEASE_ID || ""), "The prepared artifact's content identity is required")
  const requestId = randomUUID()
  const checks = []
  const stage = async (name, action) => {
    const started = Date.now()
    dependencies.onProgress?.({ requestId, stage: name, status: "started" })
    try {
      const result = await action()
      const record = { requestId, stage: name, status: "pass", elapsedMs: Date.now() - started }
      checks.push(record)
      dependencies.onProgress?.(record)
      return result
    } catch (error) {
      const record = { requestId, stage: name, status: "fail", code: name === "deployment.upload-once" ? "upload-indeterminate" : error instanceof DeploymentError ? error.code : "read-or-validation-failed", elapsedMs: Date.now() - started }
      dependencies.onProgress?.(record)
      const message = name === "deployment.upload-once" ? "Deployment may have changed the serving Worker; inspect it before recovery or another upload"
        : error instanceof DeploymentError ? error.message : "Read or validation failed; inspect credentials, configuration, and the serving Worker"
      throw new DeploymentError(message, record.code, { requestId, stage: name, ...(error instanceof DeploymentError ? error.details : {}) })
    }
  }
  const currentMain = () => (dependencies.requireCurrentMain || requireCurrentMain)(environment, dependencies.githubFetch)
  const run = dependencies.command || command
  const inspect = dependencies.inspectHostedRelease || inspectHostedRelease
  await stage("source.current-main", currentMain)
  const manifest = JSON.parse(await fs.readFile(path.join(root, "release-manifest.json"), "utf8"))
  const release = await stage("release.integrity", async () => {
    const value = await inspectSelfHostedRelease(root, manifest.version)
    requireValue(value.sourceRevision === environment.GITHUB_SHA && value.releaseId === environment.CLOUDFLARE_FLEET_RELEASE_ID, "Selected release differs from the prepared artifact or this workflow's source")
    return value
  })
  const configFile = path.join(root, "wrangler.jsonc")
  const uploadFile = path.join(root, ".wrangler", "production.json")
  let createdConfig = false
  let createdUpload = false
  try {
    const configured = await stage("configuration.private-profile", async () => {
      const config = releaseLocalConfiguration(environment.CLOUDFLARE_FLEET_DEPLOYMENT_CONFIG, root)
      await fs.writeFile(configFile, JSON.stringify(config), { flag: "wx", mode: 0o600 })
      createdConfig = true
      return readHostedReleaseConfiguration(configFile, root, environment)
    })
    const api = dependencies.api || new CloudflareApi({ accountId: configured.target.accountId, apiToken: environment.CLOUDFLARE_API_TOKEN })
    const checkOptions = { root, configFile, version: release.version, environment, api, remote: dependencies.remote, fetchImpl: dependencies.fetchImpl }
    await stage("preflight.release-and-migrations", async () => {
      const report = await inspect({ ...checkOptions, live: true })
      if (report.status !== "ready") throw new DeploymentError("Preflight failed; review migration state and configuration before another deployment", "preflight-failed", { failures: checkFailure(report) })
    })
    const serving = () => requireServingConfiguration(api, configured, dependencies)
    const previous = await stage("preflight.serving-configuration", serving)
    await stage("preflight.authenticated-application", () => requireExistingApplication(configured, environment, dependencies))
    await stage("upload.prepare-and-dry-run", async () => {
      await fs.mkdir(path.dirname(uploadFile), { recursive: true })
      requireValue(!(await fs.lstat(path.dirname(uploadFile))).isSymbolicLink(), "The deployment output directory must not be a symbolic link")
      await fs.writeFile(uploadFile, JSON.stringify(productionUploadConfiguration(configured.configuration)), { flag: "wx", mode: 0o600 })
      createdUpload = true
      await run(process.execPath, [path.join(root, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--config", uploadFile, "--keep-vars", "--dry-run"], root, wranglerEnvironment(environment, true))
    })
    await stage("preflight.final-source-and-serving-version", async () => {
      await currentMain()
      requireValue(isDeepStrictEqual(await serving(), previous), "The serving deployment changed during preflight; inspect before retrying")
    })
    await stage("deployment.upload-once", () => run(process.execPath, [path.join(root, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--config", uploadFile, "--keep-vars", "--message", `GitHub Actions ${environment.GITHUB_SHA}`], root, wranglerEnvironment(environment)))
    await stage("verification.release-and-access", async () => {
      let report
      for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
        report = await inspect({ ...checkOptions, verify: true })
        if (report.status === "ready") return
        dependencies.onProgress?.({ requestId, stage: "verification.retry", attempt, failures: checkFailure(report) })
        if (attempt < VERIFY_ATTEMPTS) await (dependencies.delay || delay)(VERIFY_DELAY_MS)
      }
      throw new DeploymentError("Deployment is not verified; inspect the serving Worker before recovery or another upload", "verification-failed", { failures: checkFailure(report) })
    })
    await stage("verification.preserved-configuration", serving)
    return { requestId, status: "verified", sourceRevision: release.sourceRevision, version: release.version, releaseId: release.releaseId, checks }
  } finally {
    if (createdUpload) await fs.rm(uploadFile, { force: true })
    if (createdConfig) await fs.rm(configFile, { force: true })
  }
}

export function productionDeploymentUsage() {
  return [
    "Usage: deploy-production.mjs --prepare --directory DIRECTORY",
    "       deploy-production.mjs --release-dir DIRECTORY",
    "Internal protected GitHub Actions job helper; not a local deployment command or Fleet API capability.",
    "-p, --prepare validates and extracts the same-run artifact; -d, --directory selects its download directory.",
    "-r, --release-dir selects the prepared release with npm ci and build:hosted already completed.",
    "-h, --help shows this help without credentials or deployment.",
    "Both modes require GITHUB_ACTIONS, GITHUB_JOB, GITHUB_REF, GITHUB_REF_PROTECTED, GITHUB_REPOSITORY, GITHUB_WORKFLOW_REF, GITHUB_EVENT_NAME, and GITHUB_SHA from the production job on protected main.",
    "CLOUDFLARE_FLEET_DEPLOY_PRODUCTION=true and CLOUDFLARE_FLEET_VERIFICATION_RESULT=success are required; a dispatch also requires CLOUDFLARE_FLEET_CI_OPERATION=deploy-production.",
    "CLOUDFLARE_FLEET_ARTIFACT_SHA256 must contain the verification job's 64-character lowercase SHA-256 digest.",
    "Deployment requires GH_TOKEN, CLOUDFLARE_ACCOUNT_ID, a dedicated CLOUDFLARE_API_TOKEN, CLOUDFLARE_FLEET_ACCESS_CLIENT_ID and CLOUDFLARE_FLEET_ACCESS_CLIENT_SECRET, and CLOUDFLARE_FLEET_DEPLOYMENT_CONFIG containing generated Wrangler JSON.",
    "CLOUDFLARE_FLEET_RELEASE_ID must match the prepared artifact's content identity; CLOUDFLARE_FLEET_URL, if supplied, must match the configuration's HTTPS origin.",
    "Preparation needs Node.js 22+, tar; deployment uses the release's locked Wrangler. No migrations, provisioning, secret uploads, or automatic rollback.",
    "JSON results go to stdout and safe stage diagnostics to stderr; private provider output is not published. Preparation also writes release_dir and release_id to GITHUB_OUTPUT when supplied.",
    "Exit: 0 success/help, 1 deployment or verification failure, 2 usage/precondition, 3 missing dependency.",
  ].join("\n")
}

if (isMainModule(import.meta.url)) {
  try {
    const options = parseCliOptions(process.argv.slice(2), [
      { name: "help", short: "h", value: false }, { name: "prepare", short: "p", value: false },
      { name: "directory", short: "d", value: true }, { name: "release-dir", key: "releaseDir", short: "r", value: true },
    ])
    if (options.help) console.log(productionDeploymentUsage())
    else if (options.prepare && options.directory && !options.releaseDir) {
      const result = await prepareProductionArtifact(options.directory)
      if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `release_dir=${result.releaseDir}\nrelease_id=${result.releaseId}\n`)
      console.log(JSON.stringify(result))
    } else if (options.releaseDir && !options.prepare && !options.directory) {
      console.log(JSON.stringify(await deployProductionRelease(path.resolve(options.releaseDir), process.env, { onProgress: (record) => console.error(JSON.stringify(record)) })))
    } else throw new CliUsageError("Select preparation with --directory, or deployment with --release-dir")
  } catch (error) {
    console.error(JSON.stringify({ status: "failed", code: error.code || "validation-failed", detail: error instanceof DeploymentError || error instanceof CliUsageError ? error.message : "Artifact or deployment validation failed", ...(error instanceof DeploymentError ? error.details : {}) }))
    process.exitCode = error instanceof CliUsageError || error.code === "precondition" ? 2 : error.code === "dependency" ? 3 : 1
  }
}
