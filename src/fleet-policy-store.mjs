import { promises as fs } from "node:fs"
import path from "node:path"

import { atomicWriteFile } from "./atomic-file.mjs"
import { isMainModule } from "./entrypoint.mjs"
import {
  createEmptyFleetPolicyConfiguration,
  FLEET_POLICY_CONFIG_GLOBAL,
  normalizeFleetPolicyConfiguration,
} from "./fleet-policy.mjs"

function safeScriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}

export async function readFleetPolicyConfiguration(policyFile) {
  let source
  try {
    source = await fs.readFile(policyFile, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return createEmptyFleetPolicyConfiguration()
    throw error
  }
  let value
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error("Fleet policy configuration is not valid JSON")
  }
  try {
    return normalizeFleetPolicyConfiguration(value)
  } catch {
    throw new Error("Fleet policy configuration is invalid")
  }
}

export function fleetPolicyScript(configuration) {
  const normalized = normalizeFleetPolicyConfiguration(configuration)
  return `window[${safeScriptJson(FLEET_POLICY_CONFIG_GLOBAL)}] = ${safeScriptJson(normalized)}\n`
}

export async function prepareFleetPolicyScript(options) {
  const configuration = await readFleetPolicyConfiguration(options.policyFile)
  await atomicWriteFile(
    options.outputPath,
    fleetPolicyScript(configuration),
  )
  return configuration
}

if (isMainModule(import.meta.url)) {
  const [command, policyFile, outputPath] = process.argv.slice(2)
  if (command !== "prepare" || !policyFile || !outputPath) {
    process.stderr.write("Usage: fleet-policy-store.mjs prepare POLICY_FILE OUTPUT_PATH\n")
    process.exitCode = 2
  } else {
    prepareFleetPolicyScript({
      outputPath: path.resolve(outputPath),
      policyFile: path.resolve(policyFile),
    }).then((configuration) => {
      process.stdout.write(`${JSON.stringify({
        emailDnsRecordExceptions: configuration.emailDnsRecordExceptions.length,
      })}\n`)
    }).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
  }
}
