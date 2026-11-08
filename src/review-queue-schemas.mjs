import { z } from "zod"
import { REVIEW_QUEUE, REVIEW_PAGE_LIMIT } from "./review-queues.mjs"

export const reviewQueueInputSchema = z.strictObject({
  queue: z.enum(Object.values(REVIEW_QUEUE)).default(REVIEW_QUEUE.MISALIGNMENTS),
  limit: z.number().int().min(1).max(REVIEW_PAGE_LIMIT.MAX).default(REVIEW_PAGE_LIMIT.DEFAULT),
  offset: z.number().int().min(0).max(REVIEW_PAGE_LIMIT.MAX_OFFSET).default(0),
  revision: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
}).refine((query) => query.offset === 0 || Boolean(query.revision), "Continuation requires the reviewed queue revision")

const summarySchema = z.strictObject({
  misalignments: z.number().int().nonnegative(), mismatchCells: z.number().int().nonnegative(),
  decisions: z.number().int().nonnegative(), reads: z.number().int().nonnegative(),
  ungovernedFacets: z.number().int().nonnegative(), decisionsAwaitingReads: z.number().int().nonnegative(),
  unresolvedPolicies: z.number().int().nonnegative(), acknowledgedCells: z.number().int().nonnegative(),
  expectedReadGaps: z.number().int().nonnegative(), configured: z.boolean(), complete: z.boolean(),
})

export const reviewQueueOutputSchema = z.strictObject({
  accountId: z.string(), schemaVersion: z.literal(1),
  status: z.enum(["attention", "not-configured", "incomplete", "aligned"]),
  loadedAt: z.string(), revision: z.string(), intentRevision: z.string().nullable(),
  queue: z.enum(Object.values(REVIEW_QUEUE)), summary: summarySchema,
  items: z.array(z.strictObject({
    id: z.string(), kind: z.enum(["misalignment", "decision", "read", "unresolved"]), label: z.string(),
    facet: z.strictObject({ category: z.string(), key: z.string(), label: z.string(), phase: z.string() }).nullable(),
    policyId: z.string().nullable(), expected: z.string().max(240), reason: z.string(), zoneCount: z.number().int().nonnegative(),
    observed: z.array(z.strictObject({ zoneId: z.string(), zoneName: z.string(), value: z.string().max(240), expected: z.string().max(240).optional() })).max(3),
  })).max(REVIEW_PAGE_LIMIT.MAX),
  total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(), hasMore: z.boolean(),
})
