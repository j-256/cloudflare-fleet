import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  createEmptyFleetIntentDocument,
  FLEET_INTENT_DOCUMENT_GLOBAL,
  FLEET_INTENT_SCHEMA_VERSION,
  FLEET_INTENT_VALUE_CONSTRAINT,
} from "../src/fleet-intent.mjs"
import {
  FleetIntentRevisionConflictError,
  importLegacyFleetIntentDocument,
  persistFleetIntentDocument,
  prepareFleetIntentScript,
  readFleetIntentDocument,
} from "../src/intent-store.mjs"

async function temporaryDirectory(context) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudflare-fleet-intent-test."),
  )
  context.after(() => fs.rm(directory, {
    force: true,
    recursive: true,
  }))
  return directory
}

test("intent store starts with an account-scoped empty document", async (context) => {
  const directory = await temporaryDirectory(context)

  const document = await readFleetIntentDocument(directory, "account-one")

  assert.deepEqual(document, createEmptyFleetIntentDocument("account-one"))
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700)
})

test("intent store atomically persists a restrictive revisioned document", async (context) => {
  const directory = await temporaryDirectory(context)
  const document = createEmptyFleetIntentDocument("account-one")
  document.groups.push({
    id: "primary-zones",
    members: [{ zoneId: "zone-a", zoneName: "a.example" }],
    mode: "members",
    name: "Primary zones",
  })

  const saved = await persistFleetIntentDocument(
    directory,
    "account-one",
    document.revision,
    document,
  )
  const reread = await readFleetIntentDocument(directory, "account-one")
  const entries = await fs.readdir(directory)
  const persistedPath = path.join(
    directory,
    entries.find((entry) => entry.startsWith("intent-") && entry.endsWith(".json")),
  )

  assert.deepEqual(reread, saved)
  assert.match(saved.revision, /^[a-f0-9]{64}$/)
  assert.equal(typeof saved.updatedAt, "string")
  assert.equal((await fs.stat(persistedPath)).mode & 0o777, 0o600)
  assert.match(await fs.readFile(persistedPath, "utf8"), /^\{\n  "/)
  assert.equal(entries.some((entry) => entry.endsWith(".tmp")), false)
  assert.equal(entries.some((entry) => entry.endsWith(".lock")), false)
})

test("intent store persists source-free value constraints", async (context) => {
  const directory = await temporaryDirectory(context)
  const document = createEmptyFleetIntentDocument("account-one")
  document.policies.push({
    expected: null,
    facet: {
      category: "DNS records",
      description: "",
      key: "TXT selector",
      label: "TXT selector",
    },
    groupId: "all-zones",
    id: "unique-selector",
    valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER,
  })

  const saved = await persistFleetIntentDocument(
    directory,
    "account-one",
    document.revision,
    document,
  )
  const reread = await readFleetIntentDocument(directory, "account-one")

  assert.deepEqual(reread, saved)
  assert.equal(reread.policies[0].expected, null)
  assert.equal(
    reread.policies[0].valueConstraint,
    FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER,
  )
})

test("intent store reads legacy documents through the schema migration", async (context) => {
  const directory = await temporaryDirectory(context)
  const document = createEmptyFleetIntentDocument("account-one")
  const saved = await persistFleetIntentDocument(
    directory,
    "account-one",
    document.revision,
    document,
  )
  const entries = await fs.readdir(directory)
  const persistedPath = path.join(
    directory,
    entries.find((entry) => entry.startsWith("intent-") && entry.endsWith(".json")),
  )
  await fs.writeFile(persistedPath, `${JSON.stringify({
    ...saved,
    schemaVersion: 1,
  })}\n`)

  const migrated = await readFleetIntentDocument(directory, "account-one")

  assert.equal(migrated.schemaVersion, FLEET_INTENT_SCHEMA_VERSION)
  assert.equal(migrated.revision, saved.revision)
})

test("intent store rejects stale revisions with the latest document", async (context) => {
  const directory = await temporaryDirectory(context)
  const original = createEmptyFleetIntentDocument("account-one")
  const saved = await persistFleetIntentDocument(
    directory,
    "account-one",
    original.revision,
    original,
  )

  await assert.rejects(
    persistFleetIntentDocument(
      directory,
      "account-one",
      original.revision,
      original,
    ),
    (error) => {
      assert.ok(error instanceof FleetIntentRevisionConflictError)
      assert.deepEqual(error.currentDocument, saved)
      return true
    },
  )
})

test("serialized intent writers allow only one update from a shared revision", async (context) => {
  const directory = await temporaryDirectory(context)
  const original = createEmptyFleetIntentDocument("account-one")
  const left = structuredClone(original)
  left.groups.push({
    id: "left-zones",
    members: [{ zoneId: "zone-a", zoneName: "a.example" }],
    mode: "members",
    name: "Left zones",
  })
  const right = structuredClone(original)
  right.groups.push({
    id: "right-zones",
    members: [{ zoneId: "zone-b", zoneName: "b.example" }],
    mode: "members",
    name: "Right zones",
  })

  const outcomes = await Promise.allSettled([
    persistFleetIntentDocument(directory, "account-one", "", left),
    persistFleetIntentDocument(directory, "account-one", "", right),
  ])

  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1)
  const rejection = outcomes.find((outcome) => outcome.status === "rejected")
  assert.ok(rejection.reason instanceof FleetIntentRevisionConflictError)
  const saved = await readFleetIntentDocument(directory, "account-one")
  assert.equal(saved.groups.length, 2)
})

test("intent store recovers an abandoned stale lock", async (context) => {
  const directory = await temporaryDirectory(context)
  const original = createEmptyFleetIntentDocument("account-one")
  const saved = await persistFleetIntentDocument(
    directory,
    "account-one",
    original.revision,
    original,
  )
  const entries = await fs.readdir(directory)
  const persistedPath = path.join(
    directory,
    entries.find((entry) => entry.startsWith("intent-") && entry.endsWith(".json")),
  )
  const lockPath = `${persistedPath}.lock`
  await fs.mkdir(lockPath)
  const staleTime = new Date(Date.now() - 60000)
  await fs.utimes(lockPath, staleTime, staleTime)

  const next = structuredClone(saved)
  next.groups.push({
    id: "recovered-zones",
    members: [{ zoneId: "zone-a", zoneName: "a.example" }],
    mode: "members",
    name: "Recovered zones",
  })
  const recovered = await persistFleetIntentDocument(
    directory,
    "account-one",
    saved.revision,
    next,
  )

  assert.equal(recovered.groups.length, 2)
  assert.equal((await fs.readdir(directory)).some((entry) => entry.includes(".lock")), false)
})

test("account digests isolate intent files without exposing account identifiers", async (context) => {
  const directory = await temporaryDirectory(context)
  const first = createEmptyFleetIntentDocument("account-one")
  first.groups.push({
    id: "first-zones",
    members: [{ zoneId: "zone-a", zoneName: "a.example" }],
    mode: "members",
    name: "First zones",
  })
  await persistFleetIntentDocument(directory, "account-one", "", first)

  const second = await readFleetIntentDocument(directory, "account-two")
  const entries = await fs.readdir(directory)

  assert.equal(second.groups.length, 1)
  assert.equal(entries.some((entry) => entry.includes("account-one")), false)
})

test("intent preparation injects the latest valid document", async (context) => {
  const directory = await temporaryDirectory(context)
  const outputPath = path.join(directory, "intent.js")
  const document = createEmptyFleetIntentDocument("account-one")
  const saved = await persistFleetIntentDocument(
    directory,
    "account-one",
    "",
    document,
  )

  const prepared = await prepareFleetIntentScript({
    accountId: "account-one",
    outputPath,
    stateDir: directory,
  })
  const script = await fs.readFile(outputPath, "utf8")

  assert.deepEqual(prepared.document, saved)
  assert.equal(prepared.imported, false)
  assert.match(script, new RegExp(FLEET_INTENT_DOCUMENT_GLOBAL))
  assert.match(script, new RegExp(saved.revision))
  assert.equal((await fs.stat(outputPath)).mode & 0o777, 0o600)
})

test("intent preparation imports a legacy cache document without removing it", async (context) => {
  const root = await temporaryDirectory(context)
  const legacyDir = path.join(root, "cache")
  const stateDir = path.join(root, "state")
  const outputPath = path.join(root, "intent.js")
  const original = createEmptyFleetIntentDocument("account-one")
  original.groups.push({
    id: "legacy-zones",
    members: [{ zoneId: "zone-a", zoneName: "a.example" }],
    mode: "members",
    name: "Legacy zones",
  })
  const saved = await persistFleetIntentDocument(
    legacyDir,
    "account-one",
    original.revision,
    original,
  )

  const prepared = await prepareFleetIntentScript({
    accountId: "account-one",
    legacyDir,
    outputPath,
    stateDir,
  })

  assert.equal(prepared.imported, true)
  assert.deepEqual(prepared.document, saved)
  assert.deepEqual(
    await readFleetIntentDocument(stateDir, "account-one"),
    saved,
  )
  assert.deepEqual(
    await readFleetIntentDocument(legacyDir, "account-one"),
    saved,
  )
  assert.equal(
    (await fs.readdir(stateDir)).some((entry) => entry.endsWith(".lock")),
    false,
  )
})

test("existing project intent remains authoritative over a legacy cache document", async (context) => {
  const root = await temporaryDirectory(context)
  const legacyDir = path.join(root, "cache")
  const stateDir = path.join(root, "state")
  const legacy = createEmptyFleetIntentDocument("account-one")
  legacy.groups.push({
    id: "legacy-zones",
    members: [{ zoneId: "zone-a", zoneName: "a.example" }],
    mode: "members",
    name: "Legacy zones",
  })
  await persistFleetIntentDocument(
    legacyDir,
    "account-one",
    legacy.revision,
    legacy,
  )
  const project = createEmptyFleetIntentDocument("account-one")
  project.groups.push({
    id: "project-zones",
    members: [{ zoneId: "zone-b", zoneName: "b.example" }],
    mode: "members",
    name: "Project zones",
  })
  const saved = await persistFleetIntentDocument(
    stateDir,
    "account-one",
    project.revision,
    project,
  )

  const imported = await importLegacyFleetIntentDocument(
    stateDir,
    legacyDir,
    "account-one",
  )

  assert.equal(imported.imported, false)
  assert.deepEqual(imported.document, saved)
})

test("concurrent legacy imports converge on one project document", async (context) => {
  const root = await temporaryDirectory(context)
  const legacyDir = path.join(root, "cache")
  const stateDir = path.join(root, "state")
  const original = createEmptyFleetIntentDocument("account-one")
  original.groups.push({
    id: "shared-zones",
    members: [{ zoneId: "zone-a", zoneName: "a.example" }],
    mode: "members",
    name: "Shared zones",
  })
  const saved = await persistFleetIntentDocument(
    legacyDir,
    "account-one",
    original.revision,
    original,
  )

  const results = await Promise.all([
    importLegacyFleetIntentDocument(stateDir, legacyDir, "account-one"),
    importLegacyFleetIntentDocument(stateDir, legacyDir, "account-one"),
  ])

  assert.equal(results.filter((result) => result.imported).length, 1)
  assert.deepEqual(results[0].document, saved)
  assert.deepEqual(results[1].document, saved)
  assert.deepEqual(
    await readFleetIntentDocument(stateDir, "account-one"),
    saved,
  )
})

test("invalid legacy intent is rejected instead of replaced", async (context) => {
  const root = await temporaryDirectory(context)
  const legacyDir = path.join(root, "cache")
  const stateDir = path.join(root, "state")
  const original = createEmptyFleetIntentDocument("account-one")
  await persistFleetIntentDocument(
    legacyDir,
    "account-one",
    original.revision,
    original,
  )
  const intentName = (await fs.readdir(legacyDir)).find(
    (entry) => entry.startsWith("intent-") && entry.endsWith(".json"),
  )
  await fs.writeFile(
    path.join(legacyDir, intentName),
    "not-json\n",
  )

  await assert.rejects(
    importLegacyFleetIntentDocument(stateDir, legacyDir, "account-one"),
    /not valid JSON/,
  )
  assert.equal(
    (await fs.readdir(stateDir)).some((entry) => entry.endsWith(".json")),
    false,
  )
})
