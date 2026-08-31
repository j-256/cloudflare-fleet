import assert from "node:assert/strict"
import test from "node:test"

import {
  captureScreenshotsUsage,
  parseCaptureScreenshotsArguments,
} from "../scripts/capture-screenshots.mjs"
import {
  hostedConfigurationUsage,
  parseHostedConfigurationArguments,
} from "../scripts/configure-hosted.mjs"
import {
  importHostedStateUsage,
  parseImportHostedStateArguments,
} from "../scripts/import-hosted-state.mjs"
import {
  createDocumentationServer,
  documentationServerUsage,
  parseDocumentationServerArguments,
} from "../scripts/serve-docs.mjs"

test("hosted configuration keeps supported short options equivalent", () => {
  const cases = [
    [["-a", "account"], ["--account-id", "account"]],
    [["-d", "database"], ["--database-id", "database"]],
    [["-o", "wrangler.jsonc"], ["--output", "wrangler.jsonc"]],
    [["-p", "policy.json"], ["--policy-file", "policy.json"]],
    [["-r"], ["--read-only"]],
    [["-w"], ["--write"]],
    [["-h"], ["--help"]],
  ]
  for (const [shortArguments, longArguments] of cases) {
    assert.deepEqual(
      parseHostedConfigurationArguments(shortArguments, {}),
      parseHostedConfigurationArguments(longArguments, {}),
    )
  }
  assert.match(hostedConfigurationUsage(), /-a, --account-id/)
  assert.match(hostedConfigurationUsage(), /-h, --help/)
})

test("single-purpose maintenance CLIs keep short options equivalent", () => {
  assert.deepEqual(
    parseCaptureScreenshotsArguments(["-o", "screenshots"]),
    parseCaptureScreenshotsArguments(["--output", "screenshots"]),
  )
  assert.deepEqual(
    parseImportHostedStateArguments(["-f", "-c", "wrangler.jsonc", "state.json"]),
    parseImportHostedStateArguments(["--force", "--config", "wrangler.jsonc", "state.json"]),
  )
  assert.deepEqual(
    parseDocumentationServerArguments(["-p", "8080"]),
    parseDocumentationServerArguments(["--port", "8080"]),
  )
})

test("maintenance help is explicit and side-effect free to parse", () => {
  const cases = [
    [parseCaptureScreenshotsArguments, captureScreenshotsUsage, /-o, --output/],
    [parseImportHostedStateArguments, importHostedStateUsage, /-f, --force/],
    [parseDocumentationServerArguments, documentationServerUsage, /-p, --port/],
  ]
  for (const [parse, usage, expected] of cases) {
    assert.equal(parse(["-h"]).help, true)
    assert.deepEqual(parse(["-h"]), parse(["--help"]))
    assert.match(usage(), expected)
    assert.match(usage(), /-h, --help/)
  }
})

test("maintenance CLIs reject unsupported short options", () => {
  assert.throws(() => parseCaptureScreenshotsArguments(["-x"]), /Unknown option: -x/)
  assert.throws(() => parseImportHostedStateArguments(["-x"]), /Unknown option: -x/)
  assert.throws(() => parseDocumentationServerArguments(["-x"]), /Unknown option: -x/)
})

test("documentation server mirrors clean Worker routes and branded not-found handling", async () => {
  const server = createDocumentationServer()
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  try {
    const address = server.address()
    const origin = `http://127.0.0.1:${address.port}`
    const deployment = await fetch(`${origin}/deployment`)
    assert.equal(deployment.status, 200)
    assert.match(await deployment.text(), /Stand up a protected Worker without losing local mode/u)
    const missing = await fetch(`${origin}/nested/missing`)
    assert.equal(missing.status, 404)
    assert.match(await missing.text(), /This fleet coordinate does not exist/u)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
