import { createLocalFleetService } from "./fleet-service.mjs"
import { createRemoteFleetService } from "./remote-fleet-service.mjs"
import { selectFleetBackend } from "./backend-selection.mjs"
import { readFleetStateDocument } from "./state-store.mjs"
import { FleetConfigurationError } from "./cli-contract.mjs"

export function createConfiguredFleetService(options = {}) {
  if (selectFleetBackend(options).kind === "hosted") return createRemoteFleetService(options)
  const service = createLocalFleetService(options)
  const hostedRequired = () => { throw new FleetConfigurationError("State reconciliation requires the hosted backend; local export remains available") }
  return {
    ...service,
    async getState(archiveId) {
      if (archiveId) return hostedRequired()
      return { schemaVersion: 1, status: "ok", accountId: service.accountId, state: await readFleetStateDocument(service.stateFile, service.accountId), archives: [] }
    },
    planState: hostedRequired, applyState: hostedRequired,
    planRecovery: hostedRequired, applyRecovery: hostedRequired,
  }
}
