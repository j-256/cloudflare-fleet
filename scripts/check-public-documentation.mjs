import path from "node:path"

import { CliUsageError, parseCliOptions } from "../src/cli-options.mjs"
import { isMainModule } from "../src/entrypoint.mjs"
import {
  DOCUMENTATION_MANIFEST_PATH,
  DOCUMENTATION_OUTPUT_ROOT,
  DOCUMENTATION_URL,
  readDocumentationManifest,
  verifyPublicDocumentation,
} from "./documentation-publication.mjs"

const DEFAULT_MANIFEST_PATH = path.join(
  DOCUMENTATION_OUTPUT_ROOT,
  DOCUMENTATION_MANIFEST_PATH,
)

export function publicDocumentationCheckUsage() {
  return [
    "Usage: check-public-documentation.mjs [options]",
    "",
    `Verify that ${DOCUMENTATION_URL} exactly matches a local artifact manifest.`,
    "The command requires Node.js network access to the fixed documentation URL.",
    "",
    "Options:",
    "  -m, --manifest FILE   Read the expected manifest from FILE",
    "  -a, --attempts N      Try from 1 through 12 times (default: 1)",
    "  -d, --delay-ms N      Wait up to 10000 milliseconds between attempts",
    "  -j, --json            Write the verification report as JSON",
    "  -h, --help            Show this help",
    "",
    "Exit status: 0 for an exact deployment, 1 for verification failure, 2 for invalid usage.",
  ].join("\n")
}

function parseInteger(value, label, minimum, maximum) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new CliUsageError(`${label} requires an integer`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new CliUsageError(`${label} must be between ${minimum} and ${maximum}`)
  }
  return parsed
}

export function parsePublicDocumentationCheckArguments(argv) {
  const options = parseCliOptions(argv, [
    { default: "1", name: "attempts", short: "a", value: true },
    { default: "0", key: "delayMs", name: "delay-ms", short: "d", value: true },
    { default: false, name: "help", short: "h", value: false },
    { default: false, name: "json", short: "j", value: false },
    { default: DEFAULT_MANIFEST_PATH, name: "manifest", short: "m", value: true },
  ])
  return {
    attempts: parseInteger(options.attempts, "--attempts", 1, 12),
    delayMs: parseInteger(options.delayMs, "--delay-ms", 0, 10_000),
    help: options.help,
    json: options.json,
    manifestPath: path.resolve(options.manifest),
  }
}

async function checkPublicDocumentation(options) {
  const expectedManifest = await readDocumentationManifest(options.manifestPath)
  return verifyPublicDocumentation({
    attempts: options.attempts,
    delayMs: options.delayMs,
    expectedManifest,
    onRetry(error, attempt, attempts) {
      process.stderr.write(
        `Public documentation is not exact after attempt ${attempt} of ${attempts}: ${error.message}\n`,
      )
    },
  })
}

if (isMainModule(import.meta.url)) {
  let options
  try {
    options = parsePublicDocumentationCheckArguments(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.stderr.write("Try --help for usage.\n")
    process.exitCode = 2
  }
  if (options?.help) {
    process.stdout.write(`${publicDocumentationCheckUsage()}\n`)
  } else if (options) {
    checkPublicDocumentation(options).then((report) => {
      process.stdout.write(options.json
        ? `${JSON.stringify(report)}\n`
        : `Public documentation is exact (${report.outputCount} files)\n`)
    }).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
  }
}
