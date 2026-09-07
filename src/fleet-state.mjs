import {
  createEmptyFleetIntentDocument,
  isFleetIntentDocument,
  migrateFleetIntentDocument,
} from "./fleet-intent.mjs"
import {
  createEmptyOperationActivityDocument,
  isOperationActivityDocument,
} from "./operation-history.mjs"
import { isWorkerRecords } from "./worker-records.mjs"

export const FLEET_STATE_SCHEMA_VERSION = 1

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function accountMatches(value, accountId) {
  return typeof value === "string"
    && value.length > 0
    && (accountId === null || value === accountId)
}

export function createEmptyFleetStateDocument(accountId) {
  if (!accountMatches(accountId, null)) {
    throw new TypeError("Fleet state requires an account identifier")
  }
  return {
    accountId,
    activity: createEmptyOperationActivityDocument(),
    intent: createEmptyFleetIntentDocument(accountId),
    schemaVersion: FLEET_STATE_SCHEMA_VERSION,
  }
}

export function isFleetStateDocument(value, accountId = null) {
  return isObject(value)
    && value.schemaVersion === FLEET_STATE_SCHEMA_VERSION
    && accountMatches(value.accountId, accountId)
    && isOperationActivityDocument(value.activity)
    && isFleetIntentDocument(value.intent, value.accountId)
    && (value.workers === undefined || isWorkerRecords(value.workers))
}

export function migrateFleetStateDocument(value, accountId = null) {
  if (isFleetStateDocument(value, accountId)) return structuredClone(value)
  if (isObject(value)
    && value.schemaVersion === FLEET_STATE_SCHEMA_VERSION
    && accountMatches(value.accountId, accountId)
    && isOperationActivityDocument(value.activity)) {
    try {
      const migrated = {
        ...structuredClone(value),
        intent: migrateFleetIntentDocument(value.intent, value.accountId),
      }
      if (!isFleetStateDocument(migrated, accountId)) {
        throw new TypeError("Migrated fleet state is invalid")
      }
      return migrated
    } catch {
      throw new TypeError("Fleet state document cannot be migrated")
    }
  }
  let intent
  try {
    intent = migrateFleetIntentDocument(value, accountId)
  } catch {
    throw new TypeError("Fleet state document cannot be migrated")
  }
  return {
    accountId: intent.accountId,
    activity: createEmptyOperationActivityDocument(),
    intent,
    schemaVersion: FLEET_STATE_SCHEMA_VERSION,
  }
}
