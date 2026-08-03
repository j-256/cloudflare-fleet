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

function stateFile(directory, filename = "state.json") {
  return path.join(directory, filename)
}

test("intent store starts with an account-scoped empty document", async (context) => {
  const directory = await temporaryDirectory(context)
  const file = stateFile(directory)

  const document = await readFleetIntentDocument(file, "account-one")

  assert.deepEqual(document, createEmptyFleetIntentDocument("account-one"))
  await assert.rejects(fs.stat(file), { code: "ENOENT" })
})

test("intent store atomically persists a restrictive revisioned document", async (context) => {
  const directory = await temporaryDirectory(context)
  const file = stateFile(directory)
  const document = createEmptyFleetIntentDocument("account-one")
  document.groups.push({
    id: "primary-zones",
    members: [{ zoneId: "zone-a", zoneName: "a.example" }],
    mode: "members",
    name: "Primary zones",
  })

  const saved = await persistFleetIntentDocument(
    file,
    "account-one",
    document.revision,
    document,
  )
  const reread = await readFleetIntentDocument(file, "account-one")
  const entries = await fs.readdir(directory)

  assert.deepEqual(reread, saved)
  assert.match(saved.revision, /^[a-f0-9]{64}$/)
  assert.equal(typeof saved.updatedAt, "string")
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
  assert.match(await fs.readFile(file, "utf8"), /^\{\n  "/)
  assert.equal(entries.some((entry) => entry.endsWith(".tmp")), false)
  assert.equal(entries.some((entry) => entry.endsWith(".lock")), false)
})

test("intent store persists source-free value constraints", async (context) => {
  const directory = await temporaryDirectory(context)
  const file = stateFile(directory)
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
    file,
    "account-one",
    document.revision,
    document,
  )
  const reread = await readFleetIntentDocument(file, "account-one")

  assert.deepEqual(reread, saved)
  assert.equal(reread.policies[0].expected, null)
  assert.equal(
    reread.policies[0].valueConstraint,
    FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER,
  )
})

test("intent store reads older documents through the schema migration", async (context) => {
  const directory = await temporaryDirectory(context)
  const file = stateFile(directory)
  const document = createEmptyFleetIntentDocument("account-one")
  const saved = await persistFleetIntentDocument(
    file,
    "account-one",
    document.revision,
    document,
  )
  await fs.writeFile(file, `${JSON.stringify({
    ...saved,
    schemaVersion: 1,
  })}\n`)

  const migrated = await readFleetIntentDocument(file, "account-one")

  assert.equal(migrated.schemaVersion, FLEET_INTENT_SCHEMA_VERSION)
  assert.equal(migrated.revision, saved.revision)
})

test("intent store rejects stale revisions with the latest document", async (context) => {
  const directory = await temporaryDirectory(context)
  const file = stateFile(directory)
  const original = createEmptyFleetIntentDocument("account-one")
  const saved = await persistFleetIntentDocument(
    file,
    "account-one",
    original.revision,
    original,
  )

  await assert.rejects(
    persistFleetIntentDocument(
      file,
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
  const file = stateFile(directory)
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
    persistFleetIntentDocument(file, "account-one", "", left),
    persistFleetIntentDocument(file, "account-one", "", right),
  ])

  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1)
  const rejection = outcomes.find((outcome) => outcome.status === "rejected")
  assert.ok(rejection.reason instanceof FleetIntentRevisionConflictError)
  const saved = await readFleetIntentDocument(file, "account-one")
  assert.equal(saved.groups.length, 2)
})

test("intent store recovers an abandoned stale lock", async (context) => {
  const directory = await temporaryDirectory(context)
  const file = stateFile(directory)
  const original = createEmptyFleetIntentDocument("account-one")
  const saved = await persistFleetIntentDocument(
    file,
    "account-one",
    original.revision,
    original,
  )
  const lockPath = `${file}.lock`
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
    file,
    "account-one",
    saved.revision,
    next,
  )

  assert.equal(recovered.groups.length, 2)
  assert.equal((await fs.readdir(directory)).some((entry) => entry.includes(".lock")), false)
})

test("state files reject another Cloudflare account explicitly", async (context) => {
  const directory = await temporaryDirectory(context)
  const file = stateFile(directory)
  const first = createEmptyFleetIntentDocument("account-one")
  first.groups.push({
    id: "first-zones",
    members: [{ zoneId: "zone-a", zoneName: "a.example" }],
    mode: "members",
    name: "First zones",
  })
  await persistFleetIntentDocument(file, "account-one", "", first)

  await assert.rejects(
    readFleetIntentDocument(file, "account-two"),
    /belongs to Cloudflare account account-one; this session uses account-two/,
  )

  assert.deepEqual(await fs.readdir(directory), ["state.json"])
})

test("intent store supports explicitly named profile files", async (context) => {
  const directory = await temporaryDirectory(context)
  const file = stateFile(directory, "state.personal.json")
  const document = createEmptyFleetIntentDocument("account-one")

  const saved = await persistFleetIntentDocument(
    file,
    "account-one",
    document.revision,
    document,
  )

  assert.deepEqual(await readFleetIntentDocument(file, "account-one"), saved)
  assert.deepEqual(await fs.readdir(directory), ["state.personal.json"])
})

test("intent preparation injects the latest valid document", async (context) => {
  const directory = await temporaryDirectory(context)
  const file = stateFile(directory)
  const outputPath = path.join(directory, "intent.js")
  const document = createEmptyFleetIntentDocument("account-one")
  const saved = await persistFleetIntentDocument(
    file,
    "account-one",
    "",
    document,
  )

  const prepared = await prepareFleetIntentScript({
    accountId: "account-one",
    outputPath,
    stateFile: file,
  })
  const script = await fs.readFile(outputPath, "utf8")

  assert.deepEqual(prepared, saved)
  assert.match(script, new RegExp(FLEET_INTENT_DOCUMENT_GLOBAL))
  assert.match(script, new RegExp(saved.revision))
  assert.equal((await fs.stat(outputPath)).mode & 0o777, 0o600)
})
