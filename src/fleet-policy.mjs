import { EMAIL_POLICY_COMPONENT } from "./constants.mjs"

const EMPTY_EXCEPTIONS = Object.freeze({})
const EMAIL_POLICY_EXCEPTIONS_BY_ZONE = Object.freeze({
  "zone-c.example": Object.freeze({
    [EMAIL_POLICY_COMPONENT.SPF]: "The sandbox uses a storefront-specific sender policy",
  }),
})

export function emailPolicyExceptionsForZone(zoneName) {
  return EMAIL_POLICY_EXCEPTIONS_BY_ZONE[zoneName] || EMPTY_EXCEPTIONS
}
