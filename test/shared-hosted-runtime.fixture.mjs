import { fetchHostedFleet } from "../src/hosted/worker.mjs"

const fetchOriginal = globalThis.fetch
const zone = { id: "zone-one", name: "example.com", status: "active", account: { id: "account-one" } }
let settingValue = "off"
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input)
  if (url.hostname === "api.cloudflare.com") {
    if (url.pathname === "/client/v4/zones") return Promise.resolve(Response.json({
      success: true, result: [zone], result_info: { page: 1, per_page: 50, total_pages: 1, count: 1, total_count: 1 },
    }))
    if (url.pathname === "/client/v4/zones/zone-one") return Promise.resolve(Response.json({ success: true, result: zone }))
    if (url.pathname === "/client/v4/zones/zone-one/settings/always_use_https") {
      if (options?.method === "PATCH") settingValue = JSON.parse(options.body).value
      return Promise.resolve(Response.json({ success: true, result: { id: "always_use_https", editable: true, value: settingValue } }))
    }
    if (["/client/v4/accounts/account-one/email/routing/addresses", "/client/v4/accounts/account-one/workers/domains", "/client/v4/accounts/account-one/pages/projects"].includes(url.pathname)) return Promise.resolve(Response.json({
      success: true, result: [], result_info: { page: 1, per_page: 50, total_pages: 1, count: 0, total_count: 0 },
    }))
    return Promise.resolve(Response.json({ success: false, errors: [{ message: "Synthetic runtime does not implement this API" }] }, { status: 404 }))
  }
  return fetchOriginal(input, options)
}

export default {
  fetch(request, env) {
    return fetchHostedFleet(request, {
      ...env, FLEET_ACCOUNT_ID: "account-one", CLOUDFLARE_API_TOKEN: "synthetic-only",
      FLEET_READ_ONLY: "false", FLEET_LOCAL_DEV: "true", FLEET_POLICY_JSON: "",
    })
  },
}
