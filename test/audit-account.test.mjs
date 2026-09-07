import assert from "node:assert/strict"
import test from "node:test"

import { collectAccountAuditFindings } from "../src/audit-account.mjs"
import {
  makeInventory,
  makeZone,
  ok,
} from "./fixtures.mjs"

const NOW = Date.parse("2026-08-09T18:00:00.000Z")

function accountApi(options = {}) {
  const scripts = options.scripts || []
  let registrarPageIndex = 0
  return {
    accountId: "account-id",
    async list(path, listOptions = {}) {
      options.listCalls?.push({ options: listOptions, path })
      if (path.includes("/pages/projects/")
        && path.includes("/deployments")) {
        const projectName = decodeURIComponent(
          path.split("/pages/projects/")[1].split("/deployments")[0],
        )
        if (options.pageDeploymentErrors?.[projectName]) {
          throw new Error(options.pageDeploymentErrors[projectName])
        }
        if (options.pageDeployments?.[projectName]) {
          return options.pageDeployments[projectName]
        }
        const project = (options.pages || []).find(
          (entry) => entry.name === projectName,
        )
        return [
          project?.latest_deployment,
          project?.canonical_deployment,
        ].filter(Boolean)
      }
      if (path.endsWith("/d1/database")) return options.d1 || []
      if (path.endsWith("/workers/domains")) return options.domains || []
      if (path.endsWith("/storage/kv/namespaces")) return options.kv || []
      if (path.endsWith("/queues")) {
        if (options.queuesError) throw new Error(options.queuesError)
        return options.queues || []
      }
      if (path.includes("/queues/") && path.endsWith("/consumers")) {
        return options.queueConsumers || []
      }
      if (path.endsWith("/workers/scripts")) return scripts
      if (path.endsWith("/workflows")) return options.workflows || []
      throw new Error(`Unexpected list path: ${path}`)
    },
    async graphql(query, variables) {
      options.graphqlCalls?.push({ query, variables })
      if (query.includes("d1AnalyticsAdaptiveGroups")) {
        if (options.d1MetricsError) throw new Error(options.d1MetricsError)
        return {
          viewer: {
            accounts: [{ rows: options.d1Metrics || [] }],
          },
        }
      }
      if (options.workerMetricsError) {
        throw new Error(options.workerMetricsError)
      }
      return {
        viewer: {
          accounts: [{ rows: options.workerMetrics || [] }],
        },
      }
    },
    async request(path) {
      if (path.endsWith("/pages/projects")) {
        if (options.pagesError) throw new Error(options.pagesError)
        return { result: options.pages || [] }
      }
      if (path.includes("/registrar/registrations")) {
        const page = options.registrarPages?.[registrarPageIndex]
        registrarPageIndex += 1
        return {
          result: page?.result || options.registrations || [],
          resultInfo: { cursor: page?.cursor || "" },
        }
      }
      if (path.endsWith("/r2/buckets")) {
        return { result: { buckets: options.r2 || [] } }
      }
      const script = scripts.find((entry) => path.includes(`/${entry.id}/`))
      if (!script) throw new Error(`Unexpected request path: ${path}`)
      if (path.endsWith("/settings")) {
        return {
          result: options.settings?.[script.id] || { bindings: [] },
        }
      }
      if (path.endsWith("/subdomain")) {
        return {
          result: {
            enabled: options.workersDev?.includes(script.id) || false,
          },
        }
      }
      if (path.endsWith("/schedules")) {
        if (options.schedulesError) throw new Error(options.schedulesError)
        return { result: { schedules: options.schedules || [] } }
      }
      throw new Error(`Unexpected request path: ${path}`)
    },
  }
}

function accountZone(name) {
  const zone = makeZone(name)
  zone.surfaces["workers-routes"] = ok([])
  return zone
}

test("account audit follows service bindings and reports only unbound storage", async () => {
  const api = accountApi({
    d1: [{ name: "bound", uuid: "bound-database" }, {
      created_at: "2025-02-16T01:19:40.448Z",
      name: "example",
      uuid: "unbound-database",
    }],
    d1Metrics: [{
      dimensions: { databaseId: "unbound-database" },
      sum: {
        readQueries: 0,
        rowsRead: 0,
        rowsWritten: 0,
        writeQueries: 0,
      },
    }],
    scripts: [{ handlers: ["fetch"], id: "caller" }, {
      handlers: ["fetch"],
      id: "target",
    }],
    settings: {
      caller: {
        bindings: [{
          database_id: "bound-database",
          name: "DB",
          type: "d1",
        }, {
          name: "TARGET",
          service: "target",
          type: "service",
        }],
      },
      target: { bindings: [] },
    },
    workersDev: ["caller"],
  })

  const findings = await collectAccountAuditFindings(
    api,
    makeInventory([accountZone("alpha.example")]),
    { now: NOW },
  )
  const ids = new Set(findings.map((entry) => entry.id))

  assert.ok(ids.has(
    "deep.storage-no-discovered-binding:d1:unbound-database",
  ))
  const unbound = findings.find(
    (entry) => entry.id
      === "deep.storage-no-discovered-binding:d1:unbound-database",
  )
  assert.equal(unbound.evidence.activity.readQueries, 0)
  assert.equal(unbound.evidence.activity.writeQueries, 0)
  assert.match(unbound.title, /no discovered binding or recent queries/)
  assert.equal(ids.has(
    "deep.storage-no-discovered-binding:d1:bound-database",
  ), false)
  assert.equal(ids.has("deep.worker-no-discovered-ingress:target"), false)
})

test("Cron mismatch is independent of logs and unrelated account coverage", async () => {
  for (const scenario of [
    { handlers: ["fetch"], schedules: [{ cron: "*/2 * * * *" }], expected: "mismatch" },
    { handlers: undefined, schedules: [{ cron: "*/2 * * * *" }], expected: "unknown" },
    { handlers: ["fetch"], schedulesError: "denied", expected: "unknown" },
    { handlers: ["fetch"], schedules: [], expected: null },
    { handlers: ["fetch", "scheduled"], schedules: [{ cron: "*/2 * * * *" }], expected: null },
  ]) {
    const findings = await collectAccountAuditFindings(accountApi({
      ...scenario,
      pagesError: "denied",
      workerMetricsError: "denied",
      scripts: [{ id: "example-worker", handlers: scenario.handlers }],
    }), makeInventory([accountZone("alpha.example")]), { now: NOW })
    const finding = findings.find((entry) => /worker-(scheduled-handler-missing|trigger-coverage-unknown)/.test(entry.id))
    assert.equal(finding?.evidence.status || null, scenario.expected)
    if (finding) {
      assert.equal(finding.evidence.observations.worker, "example-worker")
      assert.ok(Number.isFinite(Date.parse(finding.evidence.observations.readAt)))
    }
  }
})

test("account audit suppresses storage and Worker orphan findings after dependency read failure", async () => {
  const api = accountApi({
    d1: [{ name: "possibly-bound", uuid: "unknown-database" }],
    pagesError: "Pages permission denied",
    scripts: [{ handlers: ["fetch"], id: "unknown-worker" }],
  })

  const findings = await collectAccountAuditFindings(
    api,
    makeInventory([accountZone("alpha.example")]),
    { now: NOW },
  )
  const ids = new Set(findings.map((entry) => entry.id))

  assert.ok(ids.has("deep.account-read-failed:pages"))
  assert.equal([...ids].some(
    (id) => id.startsWith("deep.storage-no-discovered-binding:"),
  ), false)
  assert.equal(ids.has(
    "deep.worker-no-discovered-ingress:unknown-worker",
  ), false)
})

test("account audit reports Pages failures and Registrar renewal risk", async () => {
  const listCalls = []
  const api = accountApi({
    listCalls,
    pages: [{
      canonical_deployment: {
        created_on: "2025-06-03T17:48:37.764683Z",
        environment: "production",
        id: "canonical",
        latest_stage: { status: "success" },
      },
      domains: ["sorter.alpha.example"],
      latest_deployment: {
        created_on: "2025-06-28T22:30:16.654584Z",
        deployment_trigger: {
          metadata: {
            branch: "main",
            commit_hash: "failed-commit",
            commit_message: "Move routes",
          },
          type: "github:push",
        },
        environment: "production",
        id: "failed",
        latest_stage: {
          ended_on: "2025-06-28T22:30:42.928659Z",
          name: "build",
          status: "failure",
        },
      },
      name: "sorter",
    }],
    registrations: [{
      auto_renew: false,
      domain_name: "alpha.example",
      expires_at: "2027-01-30T15:07:00.000Z",
      locked: true,
      status: "active",
    }],
  })

  const findings = await collectAccountAuditFindings(
    api,
    makeInventory([accountZone("alpha.example")]),
    { now: NOW },
  )
  const byId = new Map(findings.map((entry) => [entry.id, entry]))

  assert.ok(byId.has("deep.pages-latest-production-failed:sorter"))
  assert.deepEqual(
    byId.get("deep.pages-latest-production-failed:sorter").zones,
    ["alpha.example"],
  )
  assert.equal(
    byId.get("deep.pages-latest-production-failed:sorter")
      .evidence.latest.trigger.commitMessage,
    "Move routes",
  )
  assert.equal(
    byId.get("deep.registrar-auto-renew-disabled:alpha.example").severity,
    "review",
  )
  assert.equal(
    listCalls.find((entry) => entry.path.includes("/deployments"))
      .options.perPage,
    25,
  )
})

test("account audit suppresses Worker orphan findings after a zone dependency read failure", async () => {
  const zone = accountZone("alpha.example")
  zone.surfaces["workers-routes"] = {
    error: { message: "Workers routes unavailable" },
    ok: false,
    status: 403,
  }
  const findings = await collectAccountAuditFindings(
    accountApi({ scripts: [{ handlers: ["fetch"], id: "unknown-worker" }] }),
    makeInventory([zone]),
    { now: NOW },
  )

  assert.equal(findings.some(
    (entry) => entry.id === "deep.worker-no-discovered-ingress:unknown-worker",
  ), false)
})

test("account audit follows Registrar cursor pagination", async () => {
  const findings = await collectAccountAuditFindings(
    accountApi({
      registrarPages: [{
        cursor: "next-page",
        result: [{
          auto_renew: false,
          domain_name: "alpha.example",
          locked: true,
          status: "active",
        }],
      }, {
        result: [{
          auto_renew: true,
          domain_name: "beta.example",
          locked: false,
          status: "active",
        }],
      }],
    }),
    makeInventory([
      accountZone("alpha.example"),
      accountZone("beta.example"),
    ]),
    { now: NOW },
  )
  const ids = new Set(findings.map((entry) => entry.id))

  assert.ok(ids.has("deep.registrar-auto-renew-disabled:alpha.example"))
  assert.ok(ids.has("deep.registrar-unlocked:beta.example"))
})

test("account audit reviews old Pages projects without a custom domain", async () => {
  const deployment = {
    created_on: "2024-03-10T21:01:02.172049Z",
    environment: "production",
    id: "legacy-deployment",
    latest_stage: { name: "deploy", status: "success" },
  }
  const findings = await collectAccountAuditFindings(
    accountApi({
      pageDeployments: { legacy: [deployment] },
      pages: [{
        canonical_deployment: deployment,
        domains: ["legacy.pages.dev"],
        latest_deployment: deployment,
        name: "legacy",
      }],
    }),
    makeInventory([accountZone("alpha.example")]),
    { now: NOW },
  )

  assert.ok(findings.some(
    (entry) => entry.id === "deep.pages-old-without-custom-domain:legacy",
  ))
})

test("account audit correlates Worker errors with event-only workers.dev exposure", async () => {
  const graphqlCalls = []
  const findings = await collectAccountAuditFindings(
    accountApi({
      graphqlCalls,
      scripts: [{ handlers: ["email"], id: "email" }],
      workerMetrics: [{
        dimensions: { scriptName: "email", status: "scriptThrewException" },
        sum: { errors: 50, requests: 50 },
      }],
      workersDev: ["email"],
    }),
    makeInventory([accountZone("alpha.example")]),
    { now: NOW },
  )
  const finding = findings.find(
    (entry) => entry.id === "deep.worker-event-only-workers-dev-errors:email",
  )

  assert.equal(graphqlCalls.length, 1)
  assert.equal(finding.evidence.errorRate, 1)
  assert.deepEqual(finding.evidence.handlers, ["email"])
  assert.deepEqual(finding.evidence.statuses, { scriptThrewException: 50 })
  assert.equal(finding.evidence.workersDev, true)
  assert.match(finding.recommendation, /Disable workers.dev/)
})

test("account audit discloses missing D1 activity evidence", async () => {
  const findings = await collectAccountAuditFindings(
    accountApi({
      d1: [{ name: "candidate", uuid: "candidate-database" }],
      d1MetricsError: "Analytics permission denied",
    }),
    makeInventory([accountZone("alpha.example")]),
    { now: NOW },
  )
  const ids = new Set(findings.map((entry) => entry.id))

  assert.ok(ids.has("deep.d1-metrics-read-failed"))
  assert.ok(ids.has(
    "deep.storage-no-discovered-binding:d1:candidate-database",
  ))
})
