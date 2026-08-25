export const HOSTED_MONITOR_LANE = Object.freeze({
  ANALYTICS: "analytics",
  MAINTENANCE: "maintenance",
  PROBE: "probe",
})

export const HOSTED_MONITOR_CRON = "* * * * *"
export const HOSTED_MONITOR_CRONS = Object.freeze([HOSTED_MONITOR_CRON])

const CYCLE_LANES = Object.freeze([
  HOSTED_MONITOR_LANE.ANALYTICS,
  HOSTED_MONITOR_LANE.PROBE,
  HOSTED_MONITOR_LANE.MAINTENANCE,
  HOSTED_MONITOR_LANE.PROBE,
  HOSTED_MONITOR_LANE.PROBE,
])
const PROBE_SEQUENCE_OFFSETS = Object.freeze({
  1: 0,
  3: 1,
  4: 2,
})

export const HOSTED_MONITOR_PROBE_SLOTS_PER_CYCLE = Object.keys(
  PROBE_SEQUENCE_OFFSETS,
).length

export function hostedMonitorSchedule(cron, scheduledAt) {
  if (cron !== HOSTED_MONITOR_CRON) {
    throw new Error(`Hosted Fleet monitor Cron is unsupported: ${cron}`)
  }
  const scheduledMs = Date.parse(scheduledAt)
  if (!Number.isFinite(scheduledMs)) {
    throw new TypeError("Hosted Fleet monitor schedule time is invalid")
  }
  const minute = Math.floor(scheduledMs / 60000)
  const cycleIndex = ((minute % CYCLE_LANES.length) + CYCLE_LANES.length)
    % CYCLE_LANES.length
  const lane = CYCLE_LANES[cycleIndex]
  const probeSequence = lane === HOSTED_MONITOR_LANE.PROBE
    ? Math.floor(minute / CYCLE_LANES.length)
      * HOSTED_MONITOR_PROBE_SLOTS_PER_CYCLE
      + PROBE_SEQUENCE_OFFSETS[cycleIndex]
    : null
  return Object.freeze({ cycleIndex, lane, probeSequence })
}
