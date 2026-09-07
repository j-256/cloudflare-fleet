export const WORKER_READ_COMMANDS = Object.freeze(["inspect", "history", "intent-plan", "schedules-plan", "undo-plan"])
export const WORKER_COMMANDS = Object.freeze([...WORKER_READ_COMMANDS, "record", "verify", "intent-apply", "schedules-apply", "undo-apply"])
export const WORKER_COMMAND_TIMEOUT_MS = 60000

export async function runWorkerCommand(service, command, payload, options = {}) {
  if (!WORKER_COMMANDS.includes(command)) throw new TypeError("Unsupported Worker command")
  if (options.readOnly && !WORKER_READ_COMMANDS.includes(command)) throw new Error("Worker writes are disabled")
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(WORKER_COMMAND_TIMEOUT_MS)]) : AbortSignal.timeout(WORKER_COMMAND_TIMEOUT_MS)
  const commandOptions = { ...options, signal }
  if (["inspect", "history", "record", "verify"].includes(command)) return service[command](payload, commandOptions)
  if (["intent-plan", "schedules-plan"].includes(command)) return service[command === "intent-plan" ? "planIntent" : "planSchedules"](payload, commandOptions)
  if (command === "undo-plan") return service.planUndo(payload.activityId, commandOptions)
  if (command === "undo-apply") return service.applyUndo(payload.activityId, payload.planDigest, commandOptions)
  return service[command === "intent-apply" ? "applyIntent" : "applySchedules"](payload.input, payload.planDigest, commandOptions)
}
