import { CliUsageError, parseCliOptions } from "../src/cli-options.mjs"
import { FLEET_CLI_EXIT_CODE } from "../src/cli-contract.mjs"
import { inspectHostedRelease } from "../src/hosted-release-check.mjs"
import { RELEASE_VERSION_PATTERN } from "../src/self-hosted-release.mjs"

export function hostedReleaseUsage(action) {
  return [
    `Usage: cloudflare-fleet hosted ${action} --version VERSION [OPTIONS]`,
    "Inspect a self-hosting release without deploying, migrating, or saving operator state.",
    "Options:",
    "  -V, --version VERSION       Explicit package version, such as 1.2.3",
    "  -r, --release-dir DIRECTORY Extracted self-hosting archive (default: this package)",
    "  -c, --config FILE           JSON from hosted configure (default: release/wrangler.jsonc)",
    "  -l, --live                  Read serving deployment and D1 migration metadata",
    "  --install                  Permit an absent Worker during first-install preflight",
    "  -f, --format text|json      Result format (default: text)",
    "  -h, --help                  Show help without checking credentials or Wrangler",
    "Verify always performs live reads and also verifies server release identity, D1 readiness, and Access.",
    "Run npm ci and npm run build:hosted inside the archive first; custom or commented JSONC requires manual review.",
    "Environment: CLOUDFLARE_FLEET_RELEASE_DIR and CLOUDFLARE_FLEET_WRANGLER_CONFIG select fixed operator paths.",
    "Live reads require CLOUDFLARE_API_TOKEN with Workers Scripts Read and D1 Read; selected account/URL must match configuration.",
    "Verify additionally requires CLOUDFLARE_FLEET_ACCESS_CLIENT_ID and CLOUDFLARE_FLEET_ACCESS_CLIENT_SECRET, or CLOUDFLARE_FLEET_ACCESS_TOKEN.",
    "All reads share a bounded deadline. JSON includes a correlation ID, per-check timings, coverage failures, and source identity.",
    "Exit: 0 verified/help, 1 runtime failure, 2 invalid usage, 3 missing/mismatched toolchain, 4 preflight blocked, 7 verification failed.",
  ].join("\n")
}

export async function runHostedReleaseCheck(options) {
  const parsed = parseCliOptions(options.argv || [], [
    { name: "help", short: "h", value: false },
    { name: "version", short: "V", value: true },
    { name: "release-dir", key: "root", short: "r", value: true },
    { name: "config", key: "configFile", short: "c", value: true },
    { name: "live", short: "l", value: false },
    { name: "install", value: false },
    { name: "format", short: "f", default: "text", value: true },
  ])
  const stdout = options.stdout || process.stdout
  if (parsed.help) {
    stdout.write(`${hostedReleaseUsage(options.action)}\n`)
    options.onExitCode?.(FLEET_CLI_EXIT_CODE.SUCCESS)
    return null
  }
  if (!RELEASE_VERSION_PATTERN.test(parsed.version || "")) throw new CliUsageError("--version requires an explicit package version, such as 1.2.3")
  if (!["json", "text"].includes(parsed.format)) throw new CliUsageError("--format must be text or json")
  if (options.action === "verify" && parsed.install) throw new CliUsageError("--install is only valid for preflight check")
  const result = await (options.inspectHostedRelease || inspectHostedRelease)({ ...options, ...parsed, verify: options.action === "verify" })
  const code = result.status === "ready" ? FLEET_CLI_EXIT_CODE.SUCCESS
    : result.checks.some((entry) => entry.code === "dependency") ? FLEET_CLI_EXIT_CODE.MISSING_DEPENDENCY
      : options.action === "verify" ? FLEET_CLI_EXIT_CODE.VERIFICATION_FAILED : FLEET_CLI_EXIT_CODE.BLOCKED
  if (parsed.format === "json") stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  else stdout.write([
    `Hosted release ${result.operation}: ${result.status} (${result.requestId})`,
    ...result.checks.map((entry) => `${entry.status.toUpperCase()} ${entry.id}${entry.detail ? `: ${entry.detail}` : ""}`),
    ...(result.release ? [`Version: ${result.release.version}; release: ${result.release.releaseId}`, `Source: ${result.release.sourceRevision || "development artifact, not a published release"}`] : []),
    ...(result.migrations?.pending.length ? [`Pending migrations: ${result.migrations.pending.join(", ")}`] : []),
    ...(result.migrations?.unexpected.length ? [`Unexpected migrations: ${result.migrations.unexpected.join(", ")}`] : []),
    `Live reads: ${result.live}; no writes were performed`,
    "Deploy and migrate only after reviewing configuration, release notes, and private recovery backups",
    "",
  ].join("\n"))
  options.onExitCode?.(code)
  return result
}
