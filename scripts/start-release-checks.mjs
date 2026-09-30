import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

import { CliUsageError, parseCliOptions } from "../src/cli-options.mjs"
import { isMainModule } from "../src/entrypoint.mjs"
import { RELEASE_VERSION_PATTERN } from "../src/self-hosted-release.mjs"
import { startAutomationChecks } from "./start-cover-checks.mjs"

export async function startReleaseChecks({ repository, sourceSha, number, version, workflows, api, now, sleep, log }) {
  if (!RELEASE_VERSION_PATTERN.test(version || "")) throw new CliUsageError("Select an exact release version, such as 1.2.3")
  return startAutomationChecks({
    repository,
    sourceSha,
    number,
    workflows,
    branch: `automation/release-v${version}`,
    files: [["package-lock.json", "modified"], ["package.json", "modified"]],
    purpose: "release",
    api,
    async validate({ prefix, pr }) {
      const readJson = async (name, revision) => {
        const response = await api(`${prefix}/contents/${name}?ref=${revision}`)
        if (response.encoding !== "base64" || typeof response.content !== "string") throw new Error(`Cannot read ${name} from the release PR`)
        return JSON.parse(Buffer.from(response.content.replaceAll("\n", ""), "base64").toString("utf8"))
      }
      const [metadata, lock, baseMetadata, baseLock] = await Promise.all([
        readJson("package.json", pr.head.sha),
        readJson("package-lock.json", pr.head.sha),
        readJson("package.json", sourceSha),
        readJson("package-lock.json", sourceSha),
      ])
      baseMetadata.version = version
      baseLock.version = version
      baseLock.packages[""].version = version
      assert.deepEqual(metadata, baseMetadata, "Release PR changes more than package.json version")
      assert.deepEqual(lock, baseLock, "Release PR changes more than package-lock.json versions")
    },
    ...(now ? { now } : {}),
    ...(sleep ? { sleep } : {}),
    ...(log ? { log } : {}),
  })
}

export function startReleaseChecksUsage() {
  return [
    "Usage: start-release-checks.mjs PR_NUMBER",
    "Start normal PR checks after validating a version-only release PR.",
    "Requires Node.js, gh, GH_TOKEN with Actions write and repository/PR read permissions,",
    "GITHUB_REPOSITORY, GITHUB_SHA for the release base, RELEASE_VERSION, and",
    "RELEASE_WORKFLOWS as comma-separated workflow filenames.",
    "Does not approve PR reviews, enable auto-merge, or bypass required status checks.",
    "Exit: 0 checks started, 1 verification/API failure, 2 usage, 3 missing dependency.",
  ].join("\n")
}

if (isMainModule(import.meta.url)) {
  try {
    const options = parseCliOptions(process.argv.slice(2), [
      { name: "help", short: "h", value: false },
    ], { minPositionals: 0, maxPositionals: 1 })
    if (options.help) console.log(startReleaseChecksUsage())
    else {
      if (options.positionals.length !== 1 || !/^[1-9][0-9]*$/u.test(options.positionals[0])) throw new CliUsageError("Expected one pull request number")
      for (const name of ["GH_TOKEN", "GITHUB_REPOSITORY", "GITHUB_SHA", "RELEASE_VERSION", "RELEASE_WORKFLOWS"]) {
        if (!process.env[name]) throw new CliUsageError(`${name} is required`)
      }
      await startReleaseChecks({
        repository: process.env.GITHUB_REPOSITORY,
        sourceSha: process.env.GITHUB_SHA,
        number: Number(options.positionals[0]),
        version: process.env.RELEASE_VERSION,
        workflows: process.env.RELEASE_WORKFLOWS.split(","),
        api(path, method = "GET") {
          const output = execFileSync("gh", ["api", "--method", method, path], {
            encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
          })
          return output.trim() ? JSON.parse(output) : null
        },
      })
    }
  } catch (error) {
    console.error(`start-release-checks: ${error.message}`)
    process.exitCode = error instanceof CliUsageError ? 2 : error.code === "ENOENT" ? 3 : 1
  }
}
