import { z } from "zod"
import { alignmentCoverageSchema, identifierSchema } from "./interface-schemas.mjs"

export const RETRIEVAL_LIMIT = Object.freeze({ DEFAULT: 20, MAX: 100, PAGE_BYTES: 131072, VALUE_BYTES: 32768, PREVIEW_CHARACTERS: 1000 })
export const RESOURCE_KINDS = Object.freeze(["dns-record", "zone-setting", "ruleset", "ruleset-rule", "email-rule"])
export const FACET_CATEGORIES = Object.freeze([
  "Zone", "Zone settings", "DNS records", "DNSSEC", "Email", "Email routes", "Email DNS specification",
  "Rulesets", "Ruleset rules", "Redirects", "Rate limiting", "Zone aliases", "Workers routes",
  "Legacy firewall view", "IP access rules", "Health checks", "Load balancers", "Logpush jobs",
  "Waiting rooms", "Web3 hostnames", "Performance", "Security", "TLS", "Snippets", "TLS inventory",
])
const page = {
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(RETRIEVAL_LIMIT.MAX).default(RETRIEVAL_LIMIT.DEFAULT),
}
const view = { view: z.enum(["summary", "full"]).default("summary") }
const search = z.string().trim().min(1).max(256).optional()
const zoneId = identifierSchema.optional()
const path = z.array(z.string().max(256)).max(20).default([]).describe("Exact object keys or array indexes inside the selected record; empty selects the record")
export const retrievalInputSchemas = Object.freeze({
  "activity-list": z.strictObject({ ...page, ...view, zoneId, status: z.enum(["pending", "verified", "write-failed", "verification-failed"]).optional(), after: z.iso.datetime({ offset: true }).optional(), before: z.iso.datetime({ offset: true }).optional() }).refine((input) => !input.after || !input.before || Date.parse(input.after) < Date.parse(input.before), "after must precede before"),
  "activity-get": z.strictObject({ id: identifierSchema, path }),
  "policy-list": z.strictObject({ ...page, ...view, zoneId, groupId: identifierSchema.optional(), category: search, search }),
  "policy-get": z.strictObject({ id: identifierSchema, path }),
  "zone-list": z.strictObject({ ...page, name: search, search }),
  "resource-list": z.strictObject({ ...page, ...view, kind: z.enum(RESOURCE_KINDS), zoneId: identifierSchema, id: identifierSchema.optional(), rulesetId: identifierSchema.optional(), path, name: search, type: search, phase: identifierSchema.optional(), search })
    .refine((query) => !query.rulesetId || query.kind === "ruleset-rule", "rulesetId requires kind ruleset-rule")
    .refine((query) => !query.phase || ["ruleset", "ruleset-rule"].includes(query.kind), "phase requires a ruleset resource")
    .refine((query) => !query.type || ["dns-record", "ruleset", "ruleset-rule"].includes(query.kind), "type requires a DNS record or ruleset resource")
    .refine((query) => query.path.length === 0 || query.id && query.view === "full", "path requires an exact id and full view"),
  "facet-list": z.strictObject({ ...page, zoneId, category: z.enum(FACET_CATEGORIES), phase: identifierSchema.optional(), search }),
  "facet-inspect": z.strictObject({ ...page, category: z.enum(FACET_CATEGORIES), key: identifierSchema, phase: identifierSchema.optional(), zoneId: identifierSchema }),
})
export const boundedValueSchema = z.strictObject({
  value: z.json().nullable(), truncated: z.boolean(), bytes: z.number().int().nonnegative(),
  digest: z.string(), preview: z.string().nullable(), childCount: z.number().int().nonnegative(), childKeys: z.array(z.string()).max(RETRIEVAL_LIMIT.MAX),
})
const base = {
  accountId: identifierSchema, schemaVersion: z.literal(1), status: z.enum(["ok", "incomplete", "not-found"]),
  freshness: z.strictObject({ source: z.enum(["live", "stored", "live-and-stored"]), readAt: z.string(), revision: z.string(), storedAt: z.string().nullable().optional() }),
  coverage: alignmentCoverageSchema,
  diagnostics: z.strictObject({ requestId: z.string().uuid(), command: z.string(), elapsedMs: z.number().nonnegative(), kind: z.literal("incomplete-inventory") }).optional(),
  scope: z.strictObject({ zoneIds: z.array(z.string()).max(RETRIEVAL_LIMIT.MAX), zoneCount: z.number().int().nonnegative(), zoneIdsTruncated: z.boolean(), surfaceIds: z.array(z.string()), accountSurfaceIds: z.array(z.string()), phases: z.array(z.string()), membership: z.literal("account"), resource: z.strictObject({ kind: z.enum(RESOURCE_KINDS), id: z.string().nullable(), rulesetId: z.string().nullable() }).optional() }).optional(),
}
const pageOutput = {
  total: z.number().int().nonnegative(), returned: z.number().int().nonnegative(), nextCursor: z.string().nullable(),
  limit: z.number().int().positive(), pageLimited: z.boolean(), valueTruncated: z.boolean(),
}
export const activitySummarySchema = z.strictObject({
  id: identifierSchema, title: z.string(), status: z.string(), startedAt: z.string(), completedAt: z.string().nullable(), validatedAt: z.string(),
  zoneIds: z.array(z.string()), zoneNames: z.array(z.string()), workers: z.array(z.string()), targetsTruncated: z.boolean(), summaryTruncated: z.boolean(), planCount: z.number().int().nonnegative(),
  execution: z.json().nullable(), verificationCount: z.number().int().nonnegative(), undoOf: z.string().nullable(),
  undo: z.strictObject({ recordedAvailable: z.boolean(), reason: z.string(), requiresLivePlan: z.literal(true) }), error: z.string().nullable(), detail: boundedValueSchema.optional(),
})
export const policySummarySchema = z.strictObject({
  id: identifierSchema, name: z.string(), groupId: identifierSchema, facet: z.strictObject({ category: z.string(), key: z.string(), label: z.string().optional(), phase: z.string().optional() }),
  presence: z.string(), valueConstraint: z.string(), expected: boundedValueSchema, acknowledgementCount: z.number().int().nonnegative(), detail: boundedValueSchema.optional(),
})
const facetSchema = z.strictObject({ category: z.string(), key: z.string(), label: z.string(), phase: z.string().nullable() })
export const retrievalOutputSchemas = Object.freeze({
  "activity-list": z.strictObject({ ...base, ...pageOutput, items: z.array(activitySummarySchema) }),
  "activity-get": z.strictObject({ ...base, id: identifierSchema, path, summary: activitySummarySchema.nullable(), detail: boundedValueSchema.nullable() }),
  "policy-list": z.strictObject({ ...base, ...pageOutput, items: z.array(policySummarySchema) }),
  "policy-get": z.strictObject({ ...base, id: identifierSchema, path, summary: policySummarySchema.nullable(), detail: boundedValueSchema.nullable(), group: boundedValueSchema.nullable() }),
  "zone-list": z.strictObject({ ...base, ...pageOutput, items: z.array(z.strictObject({ id: identifierSchema, name: z.string(), status: z.string().nullable(), paused: z.boolean(), plan: z.string().nullable() })) }),
  "resource-list": z.strictObject({ ...base, ...pageOutput, kind: z.enum(RESOURCE_KINDS), items: z.array(z.strictObject({ id: z.string(), zoneId: identifierSchema, kind: z.enum(RESOURCE_KINDS), name: z.string(), type: z.string().nullable(), phase: z.string().nullable(), rulesetId: z.string().nullable(), capabilities: z.array(z.string()), detail: boundedValueSchema.optional() })) }),
  "facet-list": z.strictObject({ ...base, ...pageOutput, items: z.array(facetSchema.extend({ capabilities: z.array(z.string()), observedZones: z.number().int().nonnegative() })) }),
  "facet-inspect": z.strictObject({ ...base, ...pageOutput, facet: facetSchema, zoneId: identifierSchema, zoneName: z.string(), observed: z.strictObject({ status: z.enum(["present", "absent", "unknown"]), comparison: boundedValueSchema.nullable(), inspection: boundedValueSchema.nullable() }), capabilities: z.array(z.string()), actions: boundedValueSchema.nullable(), intent: z.strictObject({ revision: z.string(), status: z.string(), reason: z.string().nullable(), conflictKinds: z.array(z.string()), acknowledgementCount: z.number().int().nonnegative() }), items: z.array(z.strictObject({ policy: policySummarySchema, effective: z.boolean(), targeted: z.boolean(), overriddenBy: z.array(z.string()), status: z.string().nullable(), reason: z.string().nullable(), acknowledgements: boundedValueSchema })) }),
})

export function parseRetrievalInput(kind, input) {
  if (!Object.hasOwn(retrievalInputSchemas, kind)) throw new TypeError("Unsupported Fleet retrieval operation")
  const parsed = retrievalInputSchemas[kind].safeParse(input)
  if (!parsed.success) throw new TypeError(`Invalid ${kind} query: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}`)
  return parsed.data
}
