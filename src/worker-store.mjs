import { readFleetStateDocument, updateFleetStateDocument } from "./state-store.mjs"
import { emptyWorkerRecords, revisedWorkerRecords } from "./worker-records.mjs"

export function localWorkerStore(stateFile, accountId) {
  return {
    async read() { return (await readFleetStateDocument(stateFile, accountId)).workers || emptyWorkerRecords() },
    async write(expectedRevision, document) {
      const next = await revisedWorkerRecords(document)
      const result = await updateFleetStateDocument(stateFile, accountId, (state) => {
        if ((state.workers?.revision || "") !== expectedRevision) throw new Error("Worker records revision changed")
        return { ...state, workers: next }
      })
      return result.workers
    },
  }
}
