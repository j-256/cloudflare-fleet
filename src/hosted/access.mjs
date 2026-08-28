import {
  createRemoteJWKSet,
  jwtVerify,
} from "jose"

const ACCESS_ASSERTION_HEADER = "Cf-Access-Jwt-Assertion"
const ACCESS_CERTS_PATH = "/cdn-cgi/access/certs"
const LOCAL_HOSTNAMES = new Set([
  "127.0.0.1",
  "localhost",
])
const remoteJwks = new Map()

export class AccessAuthorizationError extends Error {
  constructor(message) {
    super(message)
    this.name = "AccessAuthorizationError"
  }
}

function normalizedTeamDomain(value) {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.pathname !== "/") {
    throw new AccessAuthorizationError("Cloudflare Access team domain is invalid")
  }
  return url.origin
}

function jwksFor(teamDomain) {
  const certsUrl = new URL(ACCESS_CERTS_PATH, teamDomain)
  const key = certsUrl.href
  if (!remoteJwks.has(key)) remoteJwks.set(key, createRemoteJWKSet(certsUrl))
  return remoteJwks.get(key)
}

export function requestRequiresAccess(request) {
  return !LOCAL_HOSTNAMES.has(new URL(request.url).hostname)
}

export async function verifyAccessRequest(request, env, options = {}) {
  if (env.FLEET_LOCAL_DEV === "true" || !requestRequiresAccess(request)) return null
  if (typeof env.ACCESS_AUD !== "string" || env.ACCESS_AUD.length === 0) {
    throw new AccessAuthorizationError("Cloudflare Access audience is unavailable")
  }
  if (typeof env.ACCESS_TEAM_DOMAIN !== "string" || env.ACCESS_TEAM_DOMAIN.length === 0) {
    throw new AccessAuthorizationError("Cloudflare Access team domain is unavailable")
  }
  const token = request.headers.get(ACCESS_ASSERTION_HEADER)
  if (!token) throw new AccessAuthorizationError("Cloudflare Access assertion is missing")
  const teamDomain = normalizedTeamDomain(env.ACCESS_TEAM_DOMAIN)
  const verify = options.jwtVerify || jwtVerify
  try {
    const result = await verify(token, jwksFor(teamDomain), {
      audience: env.ACCESS_AUD,
      issuer: teamDomain,
    })
    return result.payload
  } catch (error) {
    if (error instanceof AccessAuthorizationError) throw error
    throw new AccessAuthorizationError("Cloudflare Access assertion is invalid")
  }
}
