import { isMainModule } from "../src/entrypoint.mjs"
import { PACKAGE_VERSION } from "../src/package-metadata.mjs"

export function checkReleaseTag(tag, version = PACKAGE_VERSION) {
  const expected = `v${version}`
  if (tag !== expected) {
    throw new Error(`Release tag must be ${expected}; received ${tag || "<empty>"}`)
  }
  return { tag, version }
}

if (isMainModule(import.meta.url)) {
  try {
    const result = checkReleaseTag(process.argv[2])
    process.stdout.write(`Release tag ${result.tag} matches package version\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
