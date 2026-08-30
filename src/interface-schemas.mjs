import { z } from "zod"

import { INVENTORY_COVERAGE_KIND } from "./constants.mjs"
import {
  FLEET_INTENT_EXPECTED_ORIGIN,
  FLEET_INTENT_GROUP_MODE,
  FLEET_INTENT_GROUP_NAME_SOURCE,
  FLEET_INTENT_PRESENCE_CONSTRAINT,
  FLEET_INTENT_SCHEMA_VERSION,
  FLEET_INTENT_VALUE_CONSTRAINT,
  isFleetIntentDocument,
} from "./fleet-intent.mjs"

export const identifierSchema = z.string().trim().min(1).max(256)
export const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const zoneIdsSchema = z.array(identifierSchema).min(1).max(100)
const desiredSchema = z.json().describe("Desired bounded resource definition")
const rulesetTargetSchema = {
  phase: identifierSchema,
  rulesetId: identifierSchema,
  zoneId: identifierSchema,
}
const ruleTargetSchema = {
  ...rulesetTargetSchema,
  ruleId: identifierSchema,
}

export const fleetChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    desired: desiredSchema,
    kind: z.literal("zone-setting-update"),
    settingId: identifierSchema,
    zoneId: identifierSchema,
  }),
  z.strictObject({
    desired: desiredSchema,
    kind: z.literal("dns-record-update"),
    recordId: identifierSchema,
    zoneId: identifierSchema,
  }),
  z.strictObject({
    kind: z.literal("dns-record-delete"),
    recordId: identifierSchema,
    zoneId: identifierSchema,
  }),
  z.strictObject({
    catchAll: z.boolean().default(false),
    desired: desiredSchema,
    kind: z.literal("email-routing-rule-update"),
    ruleIdentifier: identifierSchema,
    zoneId: identifierSchema,
  }),
  z.strictObject({
    desired: desiredSchema,
    kind: z.literal("ruleset-rule-create"),
    ...rulesetTargetSchema,
  }),
  z.strictObject({
    desired: desiredSchema,
    kind: z.literal("ruleset-rule-update"),
    ...ruleTargetSchema,
  }),
  z.strictObject({
    kind: z.literal("ruleset-rule-delete"),
    ...ruleTargetSchema,
  }),
  z.strictObject({
    kind: z.literal("ruleset-rule-reorder"),
    position: z.number().int().min(1),
    ...ruleTargetSchema,
  }),
  z.strictObject({
    description: z.string().max(5000),
    kind: z.literal("ruleset-description-update"),
    ...rulesetTargetSchema,
  }),
  z.strictObject({
    kind: z.literal("ruleset-delete"),
    ...rulesetTargetSchema,
  }),
  z.strictObject({
    kind: z.literal("dns-record-copy"),
    sourceRecordIds: z.array(identifierSchema).min(1).max(100),
    sourceZoneId: identifierSchema,
    targetZoneIds: zoneIdsSchema,
  }),
  z.strictObject({
    kind: z.literal("ruleset-rule-copy"),
    phase: identifierSchema,
    ruleId: identifierSchema,
    rulesetId: identifierSchema,
    sourceZoneId: identifierSchema,
    targetZoneIds: zoneIdsSchema,
  }),
  z.strictObject({
    desiredName: z.string().trim().min(1).max(5000),
    kind: z.literal("ruleset-rule-rename"),
    rules: z.array(z.strictObject(ruleTargetSchema)).min(1).max(100),
  }),
  z.strictObject({
    kind: z.literal("email-routing-align"),
    zoneIds: zoneIdsSchema,
  }),
  z.strictObject({
    kind: z.literal("shared-waf-align"),
    zoneIds: zoneIdsSchema,
  }),
])

const FLEET_INTENT_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const FLEET_INTENT_REVISION_PATTERN = /^[a-f0-9]{64}$/
const FLEET_INTENT_COLLECTION_LIMIT = 10000
const FLEET_INTENT_LABEL_LIMIT = 240
const FLEET_INTENT_LONG_LABEL_LIMIT = 100000
const FLEET_INTENT_REASON_LIMIT = 2000
const fleetIntentIdentifierSchema = z.string().regex(
  FLEET_INTENT_IDENTIFIER_PATTERN,
)
const fleetIntentLabelSchema = (maximum = FLEET_INTENT_LABEL_LIMIT) => (
  z.string().max(maximum).refine((value) => value.trim().length > 0, {
    message: "Value must contain non-whitespace text",
  })
)
const fleetIntentTimestampSchema = z.iso.datetime({ offset: true })
const fleetIntentRevisionSchema = z.union([
  z.literal(""),
  z.string().regex(FLEET_INTENT_REVISION_PATTERN),
])
const fleetIntentMemberSchema = z.looseObject({
  zoneId: fleetIntentLabelSchema(),
  zoneName: fleetIntentLabelSchema(),
})
const fleetIntentGroupCommonShape = {
  id: fleetIntentIdentifierSchema,
  name: fleetIntentLabelSchema(),
}
const fleetIntentGroupSchema = z.discriminatedUnion("mode", [
  z.looseObject({
    ...fleetIntentGroupCommonShape,
    members: z.array(fleetIntentMemberSchema).max(0),
    mode: z.literal(FLEET_INTENT_GROUP_MODE.ALL),
    nameSource: z.literal(FLEET_INTENT_GROUP_NAME_SOURCE.SYSTEM),
  }),
  z.looseObject({
    ...fleetIntentGroupCommonShape,
    members: z.array(fleetIntentMemberSchema).max(FLEET_INTENT_COLLECTION_LIMIT),
    mode: z.literal(FLEET_INTENT_GROUP_MODE.MEMBERS),
    nameSource: z.enum([
      FLEET_INTENT_GROUP_NAME_SOURCE.AUTOMATIC,
      FLEET_INTENT_GROUP_NAME_SOURCE.CUSTOM,
    ]),
  }),
])
const fleetIntentExpectedCommonShape = {
  canonical: fleetIntentLabelSchema(FLEET_INTENT_LONG_LABEL_LIMIT),
  display: z.string(),
  resolutionCanonical: fleetIntentLabelSchema(
    FLEET_INTENT_LONG_LABEL_LIMIT,
  ).nullable(),
  value: z.json(),
}
const fleetIntentExpectedSchema = z.union([
  z.looseObject({
    ...fleetIntentExpectedCommonShape,
    origin: z.literal(FLEET_INTENT_EXPECTED_ORIGIN.OBSERVED).optional(),
    sourceZoneId: fleetIntentLabelSchema(),
    sourceZoneName: fleetIntentLabelSchema(),
  }),
  z.looseObject({
    ...fleetIntentExpectedCommonShape,
    origin: z.literal(FLEET_INTENT_EXPECTED_ORIGIN.AUTHORED),
    sourceZoneId: z.null(),
    sourceZoneName: z.null(),
  }),
])
const fleetIntentFacetSchema = z.looseObject({
  category: fleetIntentLabelSchema(),
  description: z.string().optional(),
  key: fleetIntentLabelSchema(1000),
  label: fleetIntentLabelSchema(),
  phase: fleetIntentLabelSchema().optional(),
})
const fleetIntentPolicyCommonShape = {
  facet: fleetIntentFacetSchema,
  groupId: fleetIntentIdentifierSchema,
  id: fleetIntentIdentifierSchema,
}
const fleetIntentPolicySchema = z.union([
  z.looseObject({
    ...fleetIntentPolicyCommonShape,
    expected: fleetIntentExpectedSchema,
    presenceConstraint: z.enum([
      FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL,
      FLEET_INTENT_PRESENCE_CONSTRAINT.REQUIRED,
    ]),
    valueConstraint: z.literal(
      FLEET_INTENT_VALUE_CONSTRAINT.EXACT,
    ).optional(),
  }),
  z.looseObject({
    ...fleetIntentPolicyCommonShape,
    expected: z.null(),
    presenceConstraint: z.enum([
      FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL,
      FLEET_INTENT_PRESENCE_CONSTRAINT.REQUIRED,
    ]),
    valueConstraint: z.enum([
      FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER,
      FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER,
    ]),
  }),
  z.looseObject({
    ...fleetIntentPolicyCommonShape,
    expected: z.null(),
    presenceConstraint: z.literal(
      FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN,
    ),
    valueConstraint: z.literal(FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER),
  }),
])
const fleetIntentAcknowledgementSchema = z.looseObject({
  createdAt: fleetIntentTimestampSchema,
  id: fleetIntentIdentifierSchema,
  observedCanonical: fleetIntentLabelSchema(FLEET_INTENT_LONG_LABEL_LIMIT),
  policyId: fleetIntentIdentifierSchema,
  reason: fleetIntentLabelSchema(FLEET_INTENT_REASON_LIMIT),
  updatedAt: fleetIntentTimestampSchema,
  zoneId: fleetIntentLabelSchema(),
  zoneName: fleetIntentLabelSchema(),
})
const fleetIntentCoverageCommonShape = {
  createdAt: fleetIntentTimestampSchema,
  id: fleetIntentIdentifierSchema,
  observedCanonical: fleetIntentLabelSchema(FLEET_INTENT_LONG_LABEL_LIMIT),
  reason: fleetIntentLabelSchema(FLEET_INTENT_REASON_LIMIT),
  subjectId: fleetIntentIdentifierSchema,
  subjectLabel: fleetIntentLabelSchema(),
  updatedAt: fleetIntentTimestampSchema,
}
const fleetIntentCoverageExpectationSchema = z.discriminatedUnion("kind", [
  z.looseObject({
    ...fleetIntentCoverageCommonShape,
    kind: z.literal(INVENTORY_COVERAGE_KIND.LIMITATION),
    zoneId: z.null(),
    zoneName: z.null(),
  }),
  z.looseObject({
    ...fleetIntentCoverageCommonShape,
    kind: z.literal(INVENTORY_COVERAGE_KIND.SURFACE),
    zoneId: fleetIntentLabelSchema(),
    zoneName: fleetIntentLabelSchema(),
  }),
])

export const fleetIntentDocumentSchema = z.strictObject({
  accountId: fleetIntentLabelSchema(),
  acknowledgements: z.array(fleetIntentAcknowledgementSchema)
    .max(FLEET_INTENT_COLLECTION_LIMIT),
  coverageExpectations: z.array(fleetIntentCoverageExpectationSchema)
    .max(FLEET_INTENT_COLLECTION_LIMIT),
  groups: z.array(fleetIntentGroupSchema)
    .min(1)
    .max(FLEET_INTENT_COLLECTION_LIMIT),
  policies: z.array(fleetIntentPolicySchema)
    .max(FLEET_INTENT_COLLECTION_LIMIT),
  revision: fleetIntentRevisionSchema,
  schemaVersion: z.literal(FLEET_INTENT_SCHEMA_VERSION),
  updatedAt: fleetIntentTimestampSchema.nullable(),
}).superRefine((value, context) => {
  if (!isFleetIntentDocument(value, value.accountId)) {
    context.addIssue({
      code: "custom",
      message: "Document relationships or normalized values are invalid",
    })
  }
})

export const activityUndoInputSchema = z.strictObject({
  activityId: identifierSchema,
})

export const runtimeStatusInputSchema = z.strictObject({
  live: z.boolean().default(false)
    .describe("Make one bounded account-scoped Cloudflare zone-list request"),
})

const runtimeCredentialSchema = z.strictObject({
  environmentName: z.string(),
  present: z.boolean(),
})
const runtimeOperatorPathSchema = z.looseObject({
  accessible: z.boolean(),
  exists: z.boolean(),
  kind: z.string(),
  mode: z.string().nullable(),
  path: z.string(),
  source: z.string(),
  sourceName: z.string(),
  symbolicLink: z.boolean(),
})
const runtimeCheckSchema = z.strictObject({
  detail: z.string(),
  id: z.string(),
  label: z.string(),
  remedy: z.string().optional(),
  status: z.enum(["fail", "pass", "skip", "warning"]),
})

export const runtimeStatusOutputSchema = z.looseObject({
  checkedAt: z.string(),
  checks: z.array(runtimeCheckSchema),
  credentials: z.strictObject({
    accountId: runtimeCredentialSchema,
    apiToken: runtimeCredentialSchema,
  }),
  dashboard: z.looseObject({
    available: z.boolean(),
    reason: z.string(),
    status: z.string(),
  }),
  live: z.looseObject({
    requested: z.boolean(),
    status: z.enum(["failed", "ready", "skipped"]),
  }),
  paths: z.strictObject({
    policy: runtimeOperatorPathSchema,
    state: runtimeOperatorPathSchema,
  }),
  runtime: z.looseObject({
    architecture: z.string(),
    node: z.looseObject({
      minimumMajor: z.number().int(),
      supported: z.boolean(),
      version: z.string(),
    }),
    packageVersion: z.string(),
    platform: z.string(),
  }),
  schemaVersion: z.literal(1),
  status: z.enum(["attention", "ready"]),
  summary: z.strictObject({
    fail: z.number().int().nonnegative(),
    pass: z.number().int().nonnegative(),
    skip: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
  }),
})
