export const FLEET_CLI_EXIT_CODE = Object.freeze({
  ATTENTION: 4,
  BLOCKED: 4,
  ERROR: 1,
  MISSING_DEPENDENCY: 3,
  PLAN_CHANGED: 5,
  SUCCESS: 0,
  USAGE: 2,
  VERIFICATION_FAILED: 7,
  WRITE_FAILED: 6,
})

export class FleetConfigurationError extends Error {
  constructor(message) {
    super(message)
    this.name = "FleetConfigurationError"
  }
}
