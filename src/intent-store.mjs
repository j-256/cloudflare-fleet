import { createHash } from "node:crypto"

import { isMainModule } from "./entrypoint.mjs"
import {
  FLEET_INTENT_DOCUMENT_GLOBAL,
  isFleetIntentDocument,
} from "./fleet-intent.mjs"
import {
  atomicWriteFile,
  readFleetStateDocument,
  updateFleetStateDocument,
} from "./state-store.mjs"

export class FleetIntentRevisionConflictError extends Error {
  constructor(currentDocument) {
    super("Fleet intent changed in another dashboard window")
    this.name = "FleetIntentRevisionConflictError"
    this.currentDocument = currentDocument
  }
}

export async function readFleetIntentDocument(stateFile, accountId) {
  const state = await readFleetStateDocument(stateFile, accountId)
  return state.intent
}

function nextPersistedDocument(document) {
  const updatedAt = new Date().toISOString()
  const content = {
    ...structuredClone(document),
    revision: "",
    updatedAt,
  }
  const revision = createHash("sha256")
    .update(JSON.stringify(content))
    .digest("hex")
  return {
    ...content,
    revision,
  }
}

export async function persistFleetIntentDocument(
  stateFile,
  accountId,
  expectedRevision,
  document,
) {
  if (!isFleetIntentDocument(document, accountId)) {
    throw new TypeError("Fleet intent document is invalid for this account")
  }
  if (document.revision !== expectedRevision) {
    throw new TypeError("Fleet intent revision does not match the expected revision")
  }
  const state = await updateFleetStateDocument(
    stateFile,
    accountId,
    (current) => {
      if (current.intent.revision !== expectedRevision) {
        throw new FleetIntentRevisionConflictError(current.intent)
      }
      const intent = nextPersistedDocument(document)
      if (!isFleetIntentDocument(intent, accountId)) {
        throw new TypeError("Fleet intent could not be serialized")
      }
      return {
        ...current,
        intent,
      }
    },
  )
  return state.intent
}

export async function prepareFleetIntentScript(options) {
  const document = await readFleetIntentDocument(
    options.stateFile,
    options.accountId,
  )
  const payload = JSON.stringify(document)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
  await atomicWriteFile(
    options.outputPath,
    `window[${JSON.stringify(FLEET_INTENT_DOCUMENT_GLOBAL)}] = ${payload}\n`,
  )
  return document
}

async function main(args) {
  const [command, stateFile, accountId, outputPath] = args
  if (args.length !== 4
    || command !== "prepare" || !stateFile || !accountId || !outputPath) {
    throw new Error("Usage: intent-store.mjs prepare STATE_FILE ACCOUNT_ID OUTPUT_PATH")
  }
  const document = await prepareFleetIntentScript({
    accountId,
    outputPath,
    stateFile,
  })
  process.stdout.write(`${JSON.stringify({
    policies: document.policies.length,
    revision: document.revision,
  })}\n`)
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
