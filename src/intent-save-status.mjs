export const FLEET_INTENT_SAVE_STATUS = Object.freeze({
  FAILED: "failed",
  OFFLINE: "offline",
  READ_ONLY: "read-only",
  SAVED: "saved",
  SAVING: "saving",
  UNAVAILABLE: "unavailable",
  UNSAVED: "unsaved",
})

const STATIC_PRESENTATION = Object.freeze({
  [FLEET_INTENT_SAVE_STATUS.FAILED]: Object.freeze({
    label: "Save failed",
    modifier: "failed",
    title: "Fleet intent could not be saved to durable Fleet state",
  }),
  [FLEET_INTENT_SAVE_STATUS.OFFLINE]: Object.freeze({
    label: "Save unavailable",
    modifier: "offline",
    title: "The persistence backend is offline; fleet intent cannot be saved",
  }),
  [FLEET_INTENT_SAVE_STATUS.READ_ONLY]: Object.freeze({
    label: "Read-only",
    modifier: "read-only",
    title: "This session can inspect fleet intent but cannot save it",
  }),
  [FLEET_INTENT_SAVE_STATUS.SAVING]: Object.freeze({
    label: "Saving...",
    modifier: "saving",
    title: "Fleet intent is being saved to durable Fleet state",
  }),
  [FLEET_INTENT_SAVE_STATUS.UNAVAILABLE]: Object.freeze({
    label: "Not persistent",
    modifier: "unavailable",
    title: "This session can inspect fleet intent but has no persistence backend",
  }),
  [FLEET_INTENT_SAVE_STATUS.UNSAVED]: Object.freeze({
    label: "Not saved yet",
    modifier: "unsaved",
    title: "No fleet intent has been saved to durable Fleet state",
  }),
})

export function resolveIntentSaveStatus(options) {
  if (options.saving) return FLEET_INTENT_SAVE_STATUS.SAVING
  if (options.failureMessage) return FLEET_INTENT_SAVE_STATUS.FAILED
  if (options.readOnly) return FLEET_INTENT_SAVE_STATUS.READ_ONLY
  if (!options.usesBackend) return FLEET_INTENT_SAVE_STATUS.UNAVAILABLE
  if (!options.transportAvailable) return FLEET_INTENT_SAVE_STATUS.OFFLINE
  if (options.updatedAt) return FLEET_INTENT_SAVE_STATUS.SAVED
  return FLEET_INTENT_SAVE_STATUS.UNSAVED
}

export function intentSaveStatusPresentation(status, options = {}) {
  if (status === FLEET_INTENT_SAVE_STATUS.SAVED) {
    const savedAtLabel = options.savedAtLabel?.trim()
    return {
      label: savedAtLabel ? `Saved ${savedAtLabel}` : "Saved",
      modifier: "saved",
      title: savedAtLabel
        ? `Fleet intent was saved to durable Fleet state ${savedAtLabel}`
        : "Fleet intent is saved to durable Fleet state",
    }
  }
  if (status === FLEET_INTENT_SAVE_STATUS.FAILED && options.failureMessage) {
    return {
      ...STATIC_PRESENTATION[status],
      title: options.failureMessage,
    }
  }
  return { ...STATIC_PRESENTATION[status] }
}
