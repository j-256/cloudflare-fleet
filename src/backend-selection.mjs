import { FleetConfigurationError } from "./cli-contract.mjs"

export const FLEET_BACKEND = Object.freeze({ LOCAL: "local", HOSTED: "hosted" })

export function selectFleetBackend(options = {}) {
  const environment = options.environment || process.env
  const endpoint = environment.CLOUDFLARE_FLEET_URL
  const kind = environment.CLOUDFLARE_FLEET_BACKEND || (endpoint ? FLEET_BACKEND.HOSTED : FLEET_BACKEND.LOCAL)
  if (!Object.values(FLEET_BACKEND).includes(kind)) throw new FleetConfigurationError("CLOUDFLARE_FLEET_BACKEND must be local or hosted")
  if (kind === FLEET_BACKEND.LOCAL) return { kind, endpoint: null }
  if (options.stateFile || options.policyFile) throw new FleetConfigurationError("Hosted Fleet owns state and policy; use an explicitly selected local backend for local file options")
  let url
  try { url = new URL(endpoint) } catch { throw new FleetConfigurationError("Hosted Fleet requires CLOUDFLARE_FLEET_URL") }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new FleetConfigurationError("CLOUDFLARE_FLEET_URL must be an HTTPS origin without credentials, a path, or query")
  }
  const accountId = environment.CLOUDFLARE_FLEET_ACCOUNT_ID || environment.CLOUDFLARE_ACCOUNT_ID
  if (!accountId) throw new FleetConfigurationError("Hosted Fleet requires CLOUDFLARE_FLEET_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID")
  return { kind, endpoint: url.origin, accountId }
}

export function hostedCredentialPresence(environment = process.env) {
  return {
    clientId: Boolean(environment.CLOUDFLARE_FLEET_ACCESS_CLIENT_ID),
    clientSecret: Boolean(environment.CLOUDFLARE_FLEET_ACCESS_CLIENT_SECRET),
    accessToken: Boolean(environment.CLOUDFLARE_FLEET_ACCESS_TOKEN),
  }
}
