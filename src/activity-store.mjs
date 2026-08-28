import { createHash } from "node:crypto"

import {
  isOperationActivityEntry,
  OPERATION_ACTIVITY_STATUS,
} from "./operation-history.mjs"
import {
  stableString,
} from "./normalize.mjs"
import {
  readFleetStateDocument,
  updateFleetStateDocument,
} from "./state-store.mjs"

export class FleetIntentRevisionConflictError extends Error {
  constructor(expectedRevision, actualRevision) {
    super("Fleet intent changed before operation activity could be started")
    this.name = "FleetIntentRevisionConflictError"
    this.actualRevision = actualRevision
    this.expectedRevision = expectedRevision
  }
}

function nextActivityDocument(entries) {
  const updatedAt = new Date().toISOString()
  const content = {
    entries: structuredClone(entries),
    revision: "",
    updatedAt,
  }
  return {
    ...content,
    revision: createHash("sha256")
      .update(JSON.stringify(content))
      .digest("hex"),
  }
}

function immutableActivityShape(entry) {
  return {
    id: entry.id,
    plans: entry.plans,
    schemaVersion: entry.schemaVersion,
    startedAt: entry.startedAt,
    title: entry.title,
    undoOf: entry.undoOf,
    validatedAt: entry.validatedAt,
  }
}

export async function readOperationActivityDocument(stateFile, accountId) {
  const state = await readFleetStateDocument(stateFile, accountId)
  return state.activity
}

export async function appendOperationActivity(
  stateFile,
  accountId,
  entry,
  options = {},
) {
  if (!isOperationActivityEntry(entry)
    || entry.status !== OPERATION_ACTIVITY_STATUS.PENDING) {
    throw new TypeError("Operation activity must start as a valid pending entry")
  }
  const state = await updateFleetStateDocument(
    stateFile,
    accountId,
    (current) => {
      if (options.expectedIntentRevision !== undefined
        && current.intent.revision !== options.expectedIntentRevision) {
        throw new FleetIntentRevisionConflictError(
          options.expectedIntentRevision,
          current.intent.revision,
        )
      }
      if (current.activity.entries.some((candidate) => candidate.id === entry.id)) {
        throw new TypeError(`Operation activity ${entry.id} already exists`)
      }
      if (entry.undoOf) {
        const parent = current.activity.entries.find(
          (candidate) => candidate.id === entry.undoOf,
        )
        if (parent?.status !== OPERATION_ACTIVITY_STATUS.VERIFIED
          || parent.inverse?.available !== true) {
          throw new TypeError("Guarded undo requires a reversible verified operation")
        }
        const activeUndo = current.activity.entries.find((candidate) => (
          candidate.undoOf === entry.undoOf
            && [
              OPERATION_ACTIVITY_STATUS.PENDING,
              OPERATION_ACTIVITY_STATUS.VERIFIED,
            ].includes(candidate.status)
        ))
        if (activeUndo) {
          throw new TypeError("Guarded undo is already pending or verified")
        }
      }
      return {
        ...current,
        activity: nextActivityDocument([
          ...current.activity.entries,
          structuredClone(entry),
        ]),
      }
    },
  )
  return state.activity
}

export async function finalizeOperationActivity(
  stateFile,
  accountId,
  entry,
) {
  if (!isOperationActivityEntry(entry)
    || entry.status === OPERATION_ACTIVITY_STATUS.PENDING) {
    throw new TypeError("Operation activity must be completed before finalization")
  }
  const state = await updateFleetStateDocument(
    stateFile,
    accountId,
    (current) => {
      const index = current.activity.entries.findIndex(
        (candidate) => candidate.id === entry.id,
      )
      if (index === -1) {
        throw new TypeError(`Pending operation activity ${entry.id} is unavailable`)
      }
      const pending = current.activity.entries[index]
      if (pending.status !== OPERATION_ACTIVITY_STATUS.PENDING) {
        throw new TypeError(`Operation activity ${entry.id} is already complete`)
      }
      if (stableString(immutableActivityShape(pending))
        !== stableString(immutableActivityShape(entry))) {
        throw new TypeError("Completed operation activity changed its reviewed plan")
      }
      const entries = [...current.activity.entries]
      entries[index] = structuredClone(entry)
      return {
        ...current,
        activity: nextActivityDocument(entries),
      }
    },
  )
  return state.activity
}
