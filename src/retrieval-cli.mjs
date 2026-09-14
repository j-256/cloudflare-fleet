import { CliUsageError, parseCliOptions } from "./cli-options.mjs"
import { FACET_CATEGORIES, parseRetrievalInput, RESOURCE_KINDS } from "./retrieval-schemas.mjs"

const COMMANDS = Object.freeze({
  "activity list": "activity-list", "activity get": "activity-get", "intent list": "policy-list", "intent get": "policy-get",
  "zone list": "zone-list", "resource list": "resource-list", "facet list": "facet-list", "facet inspect": "facet-inspect",
})
const FIELDS = Object.freeze({
  "activity-list": ["limit", "cursor", "view", "zone-id", "status", "after", "before"],
  "activity-get": ["id", "path"], "policy-list": ["limit", "cursor", "view", "zone-id", "group-id", "category", "search"],
  "policy-get": ["id", "path"], "zone-list": ["limit", "cursor", "name", "search"],
  "resource-list": ["limit", "cursor", "view", "kind", "zone-id", "id", "ruleset-id", "path", "name", "type", "phase", "search"],
  "facet-list": ["limit", "cursor", "zone-id", "category", "phase", "search"],
  "facet-inspect": ["limit", "cursor", "zone-id", "category", "key", "phase"],
})
const SHORT = Object.freeze({ limit: "l", cursor: "u", view: "v", "zone-id": "z", id: "i", "group-id": "g", category: "c", search: "q", name: "n", kind: "k", type: "t" })
const camelCase = (name) => name.replace(/-([a-z])/g, (_match, character) => character.toUpperCase())

export function parseRetrievalArguments(argv, commonOptions) {
  const [resource, action, ...rest] = argv
  if (["zone", "resource", "facet"].includes(resource) && (!action || ["--help", "-h"].includes(action))) return { command: "retrieval-help" }
  const kind = COMMANDS[`${resource} ${action}`]
  if (!kind) return null
  const fields = FIELDS[kind].map((name) => ({ name, key: camelCase(name), short: SHORT[name], value: true, ...(name === "path" ? { multiple: true } : {}) }))
  const parsed = parseCliOptions(rest, [...commonOptions, ...fields])
  if (parsed.help) return { command: "retrieval-help" }
  if (!["json", "text"].includes(parsed.format)) throw new CliUsageError("--format must be json or text")
  const input = Object.fromEntries(fields.map(({ key }) => [key, parsed[key]]).filter(([, value]) => value !== null))
  if (input.limit !== undefined) {
    if (!/^[1-9][0-9]*$/.test(input.limit)) throw new CliUsageError("--limit requires a positive integer")
    input.limit = Number(input.limit)
  }
  let query
  try { query = parseRetrievalInput(kind, input) } catch (error) { throw new CliUsageError(error.message) }
  return { command: `retrieval-${kind}`, retrievalKind: kind, query, format: parsed.format, stateFile: parsed.statefile }
}

export function retrievalUsage() {
  return [
    "NAME", "  cloudflare-fleet retrieval - bounded discovery and detail reads", "", "SYNOPSIS",
    "  cloudflare-fleet activity list [--zone-id ID] [--status STATUS] [--after ISO] [--before ISO]",
    "  cloudflare-fleet activity get --id ID [--path KEY ...]",
    "  cloudflare-fleet intent list [--zone-id ID] [--group-id ID] [--category CATEGORY] [--search TEXT]",
    "  cloudflare-fleet intent get --id ID [--path KEY ...]",
    "  cloudflare-fleet zone list [--name EXACT_NAME] [--search TEXT]",
    "  cloudflare-fleet resource list --kind KIND --zone-id ID [--id ID] [--name EXACT_NAME] [--type TYPE] [--phase PHASE] [--search TEXT]",
    "  cloudflare-fleet facet list --category CATEGORY [--zone-id ID] [--phase PHASE] [--search TEXT]",
    "  cloudflare-fleet facet inspect --category CATEGORY --key KEY --zone-id ID [--phase PHASE]", "", "OPTIONS",
    "  -l, --limit N           Page size (default 20, maximum 100); also pages policies in facet inspect",
    "  -u, --cursor CURSOR     Continue the same query and revision; restart without cursor if it changes",
    "  -v, --view summary|full Activity, policy and resource lists default to compact summaries",
    "  -z, --zone-id ID        Exact zone identifier; resolve names with zone list",
    "  -i, --id ID             Exact activity, policy or resource identifier",
    "  -g, --group-id ID       Exact stored intent group identifier",
    "  -c, --category NAME     Exact facet category",
    "  -q, --search TEXT       Case-insensitive substring of names and identifiers",
    "  -n, --name NAME         Exact resource or zone name",
    "  -k, --kind KIND         Resource kind",
    "  -t, --type TYPE         Exact DNS type or ruleset kind",
    "      --key KEY           Exact facet key from facet list",
    "      --phase PHASE       Exact ruleset phase",
    "      --ruleset-id ID     Restrict rule discovery to one exact parent ruleset",
    "      --status STATUS     pending, verified, write-failed or verification-failed",
    "      --after/--before ISO Exclusive activity start-time bounds, with timezone",
    "      --path KEY          Repeat to traverse one record; resource reads require --id and --view full",
    "  -f, --format json|text  JSON is intended for scripts",
    "  -s, --state-file PATH   Local backend state path",
    "  -h, --help              Show this help and exit", "", "DETAILS",
    `  Resource kinds: ${RESOURCE_KINDS.join(", ")}`,
    `  Facet categories: ${FACET_CATEGORIES.join(", ")}`,
    "  Live reads report scope, freshness and incomplete coverage. Facet inspection reads the",
    "  selected category across account zones so policy precedence and uniqueness remain valid.",
    "  Activity and policy reads use stored state. Recorded undo availability still needs a fresh plan.",
    "  Large values have explicit truncation, digest and child keys. Use repeated --path for",
    "  activity/policy detail, or state export / intent show for complete stored documents.", "", "EXAMPLES",
    "  cloudflare-fleet activity list --status verification-failed -l 5 -f json",
    "  cloudflare-fleet activity get -i ACTIVITY --path plans --path 0 -f json",
    "  cloudflare-fleet resource list -k dns-record -z ZONE --type TXT -v full -f json",
    '  cloudflare-fleet facet inspect -c "Zone settings" --key always_use_https -z ZONE -f json',
    "", "EXIT STATUS", "  0 Success; 1 Runtime failure; 2 Invalid query or cursor; 4 Incomplete live coverage", "",
  ].join("\n")
}

export function renderRetrieval(result) {
  const lines = [`${result.status}: ${result.returned ?? (result.detail ? 1 : 0)}${result.total === undefined ? "" : ` of ${result.total}`} result(s)`, `Read: ${result.freshness.source} at ${result.freshness.readAt}`, `Coverage: ${result.coverage.complete ? "complete for requested scope" : `incomplete (${result.coverage.failureCount} failed reads)`}`]
  if (result.scope) lines.push(`Scope: ${result.scope.zoneCount} zone(s); ${result.scope.surfaceIds.join(", ") || "zone membership only"}`)
  for (const item of result.items || []) {
    if (item.policy) lines.push(`${item.policy.id} | ${item.status || (item.targeted ? "overridden" : "out-of-scope")} | ${item.policy.name}`)
    else lines.push([item.id || item.key, item.status || item.type || item.category, item.title || item.name || item.label].filter(Boolean).join(" | "))
    if (item.detail) lines.push(JSON.stringify(item.detail, null, 2))
  }
  if (result.observed) lines.push(`Observed: ${result.observed.status}`, `Intent: ${result.intent.status}${result.intent.reason ? ` (${result.intent.reason})` : ""}`, JSON.stringify(result.observed, null, 2))
  if (result.detail) lines.push(JSON.stringify(result.detail, null, 2))
  if (result.valueTruncated) lines.push("Some values were truncated; inspect their digest and child keys or use a focused detail read")
  for (const failure of result.coverage.failures) lines.push(`Unread: ${failure.zoneName || "account"} / ${failure.surfaceId} / ${failure.reasonCode || failure.errorKind}`)
  if (result.diagnostics?.requestId) lines.push(`Request ID: ${result.diagnostics.requestId}`)
  if (result.nextCursor) lines.push(`Next cursor: ${result.nextCursor}`)
  return lines.join("\n")
}
