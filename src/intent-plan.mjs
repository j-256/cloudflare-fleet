import { isFleetIntentDocument } from "./fleet-intent.mjs"
import { stableString } from "./normalize.mjs"
import { createReviewedPlanSet } from "./reviewed-plan.mjs"

export const FLEET_INTENT_CHANGE_STATUS = Object.freeze({
  PLANNED: "planned",
  UNCHANGED: "unchanged",
})

const COLLECTION_NAMES = Object.freeze([
  "groups",
  "policies",
  "acknowledgements",
  "coverageExpectations",
])

function normalizedDesiredDocument(accountId, current, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Fleet intent input must be a complete document")
  }
  if (value.accountId !== accountId) {
    throw new TypeError("Fleet intent input belongs to another Cloudflare account")
  }
  if (value.revision !== current.revision) {
    throw new TypeError("Fleet intent input revision does not match the persisted document")
  }
  const desired = {
    ...structuredClone(value),
    accountId,
    revision: current.revision,
    updatedAt: current.updatedAt,
  }
  if (!isFleetIntentDocument(desired, accountId)) {
    throw new TypeError("Fleet intent input is not a valid current-schema document")
  }
  return desired
}

function collectionDiff(current, desired, collection) {
  const currentById = new Map(current[collection].map((entry) => [entry.id, entry]))
  const desiredById = new Map(desired[collection].map((entry) => [entry.id, entry]))
  return {
    added: [...desiredById.keys()].filter((id) => !currentById.has(id)).sort(),
    changed: [...desiredById.entries()]
      .filter(([id, entry]) => (
        currentById.has(id)
          && stableString(currentById.get(id)) !== stableString(entry)
      ))
      .map(([id]) => id)
      .sort(),
    removed: [...currentById.keys()].filter((id) => !desiredById.has(id)).sort(),
  }
}

function intentDiff(current, desired) {
  return Object.fromEntries(COLLECTION_NAMES.map((collection) => [
    collection,
    collectionDiff(current, desired, collection),
  ]))
}

function changeCount(diff) {
  return Object.values(diff).reduce((total, collection) => (
    total + collection.added.length
      + collection.changed.length
      + collection.removed.length
  ), 0)
}

export function prepareFleetIntentChange(accountId, current, value, options = {}) {
  const desired = normalizedDesiredDocument(accountId, current, value)
  const diff = intentDiff(current, desired)
  const changes = changeCount(diff)
  const planSet = createReviewedPlanSet({
    accountId,
    plans: [],
    request: {
      document: desired,
      expectedRevision: current.revision,
      kind: "fleet-intent-replace",
    },
    validatedAt: options.validatedAt,
  })
  return {
    desired,
    diff,
    planSet,
    reason: changes === 0
      ? "The persisted fleet intent already matches the requested document"
      : `${changes} fleet intent collection change${changes === 1 ? "" : "s"} prepared`,
    status: changes === 0
      ? FLEET_INTENT_CHANGE_STATUS.UNCHANGED
      : FLEET_INTENT_CHANGE_STATUS.PLANNED,
  }
}
