import { spawnSync } from "node:child_process"

import { parseCliOptions } from "../src/cli-options.mjs"
import { isMainModule } from "../src/entrypoint.mjs"

const DOCUMENTATION_JOB = "documentation"
const DOCUMENTATION_WORKFLOW_SUFFIX = "/.github/workflows/ci.yml@refs/heads/main"
const MAIN_REF = "refs/heads/main"
const PUBLISH_EVENTS = new Set(["push", "workflow_dispatch"])
const WRANGLER_COMMAND = "wrangler"
const WRANGLER_DEPLOY_ARGUMENTS = Object.freeze([
  "deploy",
  "--config",
  "wrangler.docs.jsonc",
])

export function documentationDeployUsage() {
  return [
    "Usage: deploy-documentation.mjs [options]",
    "",
    "Deploy the exact documentation artifact from its protected GitHub Actions job.",
    "Local validation remains available through npm run deploy:docs:dry-run.",
    "",
    "Options:",
    "  -m, --message MESSAGE   Attach MESSAGE to the Worker deployment",
    "  -h, --help              Show this help",
    "",
    "Environment:",
    "  GITHUB_ACTIONS, GITHUB_EVENT_NAME, GITHUB_JOB, GITHUB_REF,",
    "  GITHUB_REF_PROTECTED, and GITHUB_WORKFLOW_REF identify the protected job.",
    "  CLOUDFLARE_FLEET_PUBLISH_DOCUMENTATION must be true.",
    "  CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN authorize Wrangler.",
    "",
    "Dependency: Wrangler is required only when deployment is authorized.",
    "",
    "Exit status: 0 for success, 1 for deployment failure, 2 for invalid usage or context, and 3 when Wrangler is unavailable.",
  ].join("\n")
}

export function parseDocumentationDeployArguments(argv) {
  const options = parseCliOptions(argv, [
    { default: false, name: "help", short: "h", value: false },
    { default: "", name: "message", short: "m", value: true },
  ])
  return {
    help: options.help,
    message: options.message,
  }
}

export function documentationDeploymentContextError(environment) {
  if (environment.GITHUB_ACTIONS !== "true") {
    return "Documentation deployment is limited to its protected GitHub Actions job"
  }
  if (environment.GITHUB_JOB !== DOCUMENTATION_JOB) {
    return `Documentation deployment requires the ${DOCUMENTATION_JOB} job`
  }
  if (environment.GITHUB_REF !== MAIN_REF) {
    return `Documentation deployment requires ${MAIN_REF}`
  }
  if (environment.GITHUB_REF_PROTECTED !== "true") {
    return "Documentation deployment requires a protected GitHub ref"
  }
  if (!environment.GITHUB_WORKFLOW_REF?.endsWith(DOCUMENTATION_WORKFLOW_SUFFIX)) {
    return "Documentation deployment requires the main CI workflow"
  }
  if (!PUBLISH_EVENTS.has(environment.GITHUB_EVENT_NAME)) {
    return "Documentation deployment requires a push or workflow_dispatch event"
  }
  if (environment.CLOUDFLARE_FLEET_PUBLISH_DOCUMENTATION !== "true") {
    return "Documentation publication is not enabled for this repository"
  }
  if (!environment.GITHUB_SHA) {
    return "Documentation deployment requires a GitHub source revision"
  }
  if (!environment.CLOUDFLARE_ACCOUNT_ID) {
    return "CLOUDFLARE_ACCOUNT_ID is required for documentation deployment"
  }
  if (!environment.CLOUDFLARE_API_TOKEN) {
    return "CLOUDFLARE_API_TOKEN is required for documentation deployment"
  }
  return null
}

export function documentationDeployCommand(options) {
  const args = [...WRANGLER_DEPLOY_ARGUMENTS]
  if (options.message) args.push("--message", options.message)
  return {
    args,
    command: WRANGLER_COMMAND,
  }
}

export function runDocumentationDeploy(options, dependencies = {}) {
  const environment = dependencies.environment || process.env
  const contextError = documentationDeploymentContextError(environment)
  if (contextError) return { error: contextError, exitCode: 2 }

  const command = documentationDeployCommand(options)
  const spawnImplementation = dependencies.spawnImplementation || spawnSync
  const result = spawnImplementation(command.command, command.args, {
    encoding: "utf8",
    env: environment,
    stdio: "inherit",
  })
  if (result.error?.code === "ENOENT") {
    return { error: "Wrangler is required for documentation deployment", exitCode: 3 }
  }
  if (result.error) {
    return { error: result.error.message, exitCode: 1 }
  }
  if (result.status === null) {
    return {
      error: `Wrangler was terminated${result.signal ? ` by ${result.signal}` : ""}`,
      exitCode: 1,
    }
  }
  return { error: null, exitCode: result.status }
}

if (isMainModule(import.meta.url)) {
  let options
  try {
    options = parseDocumentationDeployArguments(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.stderr.write("Try --help for usage.\n")
    process.exitCode = 2
  }
  if (options?.help) {
    process.stdout.write(`${documentationDeployUsage()}\n`)
  } else if (options) {
    const result = runDocumentationDeploy(options)
    if (result.error) process.stderr.write(`${result.error}\n`)
    process.exitCode = result.exitCode
  }
}
