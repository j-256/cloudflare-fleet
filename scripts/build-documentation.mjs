import { isMainModule } from "../src/entrypoint.mjs"
import { parseCliOptions } from "../src/cli-options.mjs"
import { buildDocumentationArtifact } from "./documentation-publication.mjs"

export function documentationBuildUsage() {
  return [
    "Usage: build-documentation.mjs [options]",
    "",
    "Build the exact static documentation artifact for Cloudflare Workers.",
    "",
    "Options:",
    "  -h, --help   Show this help",
    "",
    "Exit status: 0 for success, 1 for a build failure, 2 for invalid usage.",
  ].join("\n")
}

export function parseDocumentationBuildArguments(argv) {
  const options = parseCliOptions(argv, [
    { default: false, name: "help", short: "h", value: false },
  ])
  return { help: options.help }
}

if (isMainModule(import.meta.url)) {
  let options
  try {
    options = parseDocumentationBuildArguments(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
  if (options?.help) {
    process.stdout.write(`${documentationBuildUsage()}\n`)
  } else if (options) {
    buildDocumentationArtifact().then((result) => {
      process.stdout.write(`Documentation artifact is ready (${result.outputCount} files)\n`)
    }).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
  }
}
