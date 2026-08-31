import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  documentationBuildUsage,
  parseDocumentationBuildArguments,
} from "../scripts/build-documentation.mjs"
import {
  parsePublicDocumentationCheckArguments,
  publicDocumentationCheckUsage,
} from "../scripts/check-public-documentation.mjs"
import {
  documentationDeployCommand,
  documentationDeploymentContextError,
  documentationDeployUsage,
  parseDocumentationDeployArguments,
} from "../scripts/deploy-documentation.mjs"
import { referencesUrlOrigin } from "../scripts/check-publication.mjs"
import {
  buildDocumentationArtifact,
  canonicalJson,
  DOCUMENTATION_ASSETS_IGNORE_PATH,
  DOCUMENTATION_MANIFEST_PATH,
  documentationAssetsIgnore,
  readDocumentationManifest,
  verifyPublicDocumentation,
} from "../scripts/documentation-publication.mjs"

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..")
const VALID_DEPLOYMENT_ENVIRONMENT = Object.freeze({
  CLOUDFLARE_ACCOUNT_ID: "test-account",
  CLOUDFLARE_API_TOKEN: "test-token",
  CLOUDFLARE_FLEET_PUBLISH_DOCUMENTATION: "true",
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "push",
  GITHUB_JOB: "documentation",
  GITHUB_REF: "refs/heads/main",
  GITHUB_REF_PROTECTED: "true",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_WORKFLOW_REF: "example/repository/.github/workflows/ci.yml@refs/heads/main",
})

async function withTemporaryProject(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudflare-fleet-docs."))
  try {
    await fs.mkdir(path.join(root, "docs", "assets"), { recursive: true })
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "cloudflare-fleet",
      version: "1.2.3",
    }))
    await fs.writeFile(path.join(root, "docs", "index.html"), "<h1>Fleet</h1>\n")
    await fs.writeFile(path.join(root, "docs", "404.html"), "<h1>Not found</h1>\n")
    await fs.writeFile(path.join(root, "docs", "assets", "site.css"), "body {}\n")
    await callback(root)
  } finally {
    await fs.rm(root, { force: true, recursive: true })
  }
}

function publicArtifactFetch(manifest, files, options = {}) {
  let requests = 0
  return async (input) => {
    requests += 1
    if (options.failFirst && requests === 1) {
      return new Response("Not ready\n", { status: 503 })
    }
    const pathname = new URL(input).pathname.replace(/^\/+/, "")
    if (pathname === DOCUMENTATION_MANIFEST_PATH) {
      return new Response(`${JSON.stringify(manifest, null, 2)}\n`, {
        headers: { "content-type": "application/json; charset=utf-8" },
      })
    }
    let outputPath = pathname
    let status = 200
    if (pathname === "") outputPath = "index.html"
    else if (pathname.startsWith("publication-missing-")) {
      outputPath = "404.html"
      status = 404
    } else if (!path.extname(pathname)) {
      outputPath = `${pathname}.html`
    }
    const body = files.get(outputPath)
    if (body === undefined) return new Response("Not found\n", { status: 404 })
    return new Response(body, { status })
  }
}

test("documentation build creates a deterministic exact artifact", async () => {
  await withTemporaryProject(async (root) => {
    const outputRoot = path.join(root, "documentation-dist")
    const result = await buildDocumentationArtifact({
      outputRoot,
      projectRoot: root,
      sourcePaths: ["404.html", "assets/site.css", "index.html"],
    })
    assert.equal(result.outputCount, 3)
    assert.deepEqual(result.manifest.package, {
      name: "cloudflare-fleet",
      version: "1.2.3",
    })
    assert.deepEqual(
      result.manifest.outputs.map((output) => output.path),
      ["404.html", "assets/site.css", "index.html"],
    )
    assert.deepEqual(
      await readDocumentationManifest(result.manifestPath),
      result.manifest,
    )
    assert.equal(
      await fs.readFile(path.join(outputRoot, "index.html"), "utf8"),
      "<h1>Fleet</h1>\n",
    )
    assert.equal(
      await fs.readFile(path.join(outputRoot, DOCUMENTATION_ASSETS_IGNORE_PATH), "utf8"),
      [
        "*",
        "!*/",
        "!/404.html",
        "!/assets/site.css",
        "!/index.html",
        "!/publication-manifest.json",
        "",
      ].join("\n"),
    )
  })
})

test("documentation build rejects non-file source entries", async () => {
  await withTemporaryProject(async (root) => {
    await fs.symlink("index.html", path.join(root, "docs", "linked.html"))
    await assert.rejects(
      buildDocumentationArtifact({
        outputRoot: path.join(root, "documentation-dist"),
        projectRoot: root,
        sourcePaths: ["linked.html"],
      }),
      /unsupported entry: linked\.html/,
    )
  })
})

test("public verification fetches and hashes every declared output", async () => {
  await withTemporaryProject(async (root) => {
    const result = await buildDocumentationArtifact({
      outputRoot: path.join(root, "documentation-dist"),
      projectRoot: root,
      sourcePaths: ["404.html", "assets/site.css", "index.html"],
    })
    const files = new Map()
    for (const output of result.manifest.outputs) {
      files.set(
        output.path,
        await fs.readFile(path.join(root, "documentation-dist", output.path)),
      )
    }
    let retryCount = 0
    const report = await verifyPublicDocumentation({
      attempts: 2,
      baseUrl: "https://docs.example/",
      expectedManifest: result.manifest,
      fetchImplementation: publicArtifactFetch(result.manifest, files, { failFirst: true }),
      onRetry() {
        retryCount += 1
      },
    })
    assert.equal(retryCount, 1)
    assert.match(
      report.manifestUrl,
      /^https:\/\/docs\.example\/publication-manifest\.json\?publication=/u,
    )
    assert.deepEqual({ ...report, manifestUrl: "<verified>" }, {
      manifestUrl: "<verified>",
      outputCount: 3,
      state: "exact",
      version: "1.2.3",
    })

    files.set("index.html", Buffer.from("changed\n"))
    await assert.rejects(
      verifyPublicDocumentation({
        baseUrl: "https://docs.example/",
        expectedManifest: result.manifest,
        fetchImplementation: publicArtifactFetch(result.manifest, files),
      }),
      /index\.html has the wrong (?:size|digest)/,
    )
  })
})

test("documentation maintenance CLIs expose equivalent option forms", () => {
  assert.deepEqual(
    parseDocumentationBuildArguments(["-h"]),
    parseDocumentationBuildArguments(["--help"]),
  )
  const short = parsePublicDocumentationCheckArguments([
    "-ja2",
    "-d5",
    "-mmanifest.json",
    "-uhttps://docs.example",
  ])
  const long = parsePublicDocumentationCheckArguments([
    "--json",
    "--attempts=2",
    "--delay-ms",
    "5",
    "--manifest",
    "manifest.json",
    "--url",
    "https://docs.example",
  ])
  assert.deepEqual(short, long)
  assert.match(documentationBuildUsage(), /Exit status: 0/u)
  assert.match(publicDocumentationCheckUsage(), /-m, --manifest/u)
  assert.match(publicDocumentationCheckUsage(), /-u, --url/u)
  assert.equal(
    parsePublicDocumentationCheckArguments([], {
      CLOUDFLARE_FLEET_DOCUMENTATION_URL: "https://configured.example",
    }).baseUrl,
    "https://configured.example",
  )
  assert.throws(
    () => parsePublicDocumentationCheckArguments([], {}),
    /CLOUDFLARE_FLEET_DOCUMENTATION_URL is required/u,
  )
  assert.throws(
    () => parsePublicDocumentationCheckArguments(
      ["--attempts", "13"],
      { CLOUDFLARE_FLEET_DOCUMENTATION_URL: "https://docs.example" },
    ),
    /between 1 and 12/,
  )
  assert.throws(
    () => parsePublicDocumentationCheckArguments(["--", "unexpected"]),
    /Expected 0 positional arguments/,
  )
  assert.deepEqual(
    parseDocumentationDeployArguments(["-mrelease"]),
    parseDocumentationDeployArguments(["--message", "release"]),
  )
  assert.deepEqual(documentationDeployCommand({ message: "release" }), {
    args: [
      "deploy",
      "--config",
      "wrangler.docs.jsonc",
      "--message",
      "release",
    ],
    command: "wrangler",
  })
  assert.throws(
    () => parseDocumentationDeployArguments(["--config", "other.jsonc"]),
    /Unknown option: --config/u,
  )
  assert.match(documentationDeployUsage(), /Exit status: 0/u)
})

test("documentation deployment requires the protected publication job", () => {
  assert.equal(
    documentationDeploymentContextError(VALID_DEPLOYMENT_ENVIRONMENT),
    null,
  )
  for (const [key, value, expected] of [
    ["GITHUB_ACTIONS", "false", /protected GitHub Actions job/u],
    ["GITHUB_JOB", "verify", /documentation job/u],
    ["GITHUB_REF", "refs/heads/topic", /refs\/heads\/main/u],
    ["GITHUB_REF_PROTECTED", "false", /protected GitHub ref/u],
    ["GITHUB_WORKFLOW_REF", "example/repository/.github/workflows/other.yml@refs/heads/main", /main CI workflow/u],
    ["GITHUB_EVENT_NAME", "pull_request", /push or workflow_dispatch/u],
    ["CLOUDFLARE_FLEET_PUBLISH_DOCUMENTATION", "false", /not enabled/u],
    ["GITHUB_SHA", "", /source revision/u],
    ["CLOUDFLARE_ACCOUNT_ID", "", /CLOUDFLARE_ACCOUNT_ID/u],
    ["CLOUDFLARE_API_TOKEN", "", /CLOUDFLARE_API_TOKEN/u],
  ]) {
    const environment = { ...VALID_DEPLOYMENT_ENVIRONMENT, [key]: value }
    assert.match(documentationDeploymentContextError(environment), expected)
  }
})

test("documentation CLI help and failure streams use documented statuses", async () => {
  const commands = [
    ["scripts/build-documentation.mjs", "--help"],
    ["scripts/check-public-documentation.mjs", "-h"],
    ["scripts/deploy-documentation.mjs", "--help"],
  ]
  for (const args of commands) {
    const result = spawnSync(process.execPath, args, {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
    })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /Usage:/u)
    assert.equal(result.stderr, "")
  }

  const usageFailure = spawnSync(
    process.execPath,
    ["scripts/check-public-documentation.mjs", "--unknown"],
    { cwd: PROJECT_ROOT, encoding: "utf8" },
  )
  assert.equal(usageFailure.status, 2)
  assert.equal(usageFailure.stdout, "")
  assert.match(usageFailure.stderr, /Unknown option/u)

  const missingManifest = path.join(
    os.tmpdir(),
    "cloudflare-fleet-missing-manifest.json",
  )
  const runtimeFailure = spawnSync(
    process.execPath,
    [
      "scripts/check-public-documentation.mjs",
      "--manifest",
      missingManifest,
      "--url",
      "https://docs.example",
    ],
    { cwd: PROJECT_ROOT, encoding: "utf8" },
  )
  assert.equal(runtimeFailure.status, 1)
  assert.equal(runtimeFailure.stdout, "")
  assert.match(runtimeFailure.stderr, /Cannot read documentation manifest/u)

  const blockedDeployment = spawnSync(
    process.execPath,
    ["scripts/deploy-documentation.mjs"],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      env: { PATH: process.env.PATH || "" },
    },
  )
  assert.equal(blockedDeployment.status, 2)
  assert.equal(blockedDeployment.stdout, "")
  assert.match(blockedDeployment.stderr, /protected GitHub Actions job/u)

  const missingWrangler = spawnSync(
    process.execPath,
    ["scripts/deploy-documentation.mjs"],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      env: { ...VALID_DEPLOYMENT_ENVIRONMENT, PATH: "" },
    },
  )
  assert.equal(missingWrangler.status, 3)
  assert.equal(missingWrangler.stdout, "")
  assert.match(missingWrangler.stderr, /Wrangler is required/u)
})

test("canonical documentation JSON ignores object key order but preserves arrays", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }))
  assert.notEqual(canonicalJson(["b", "a"]), canonicalJson(["a", "b"]))
})

test("publication URL checks compare complete origins", () => {
  const origin = "https://docs.cloudflare-fleet.lasers.app"
  assert.equal(referencesUrlOrigin(`url: ${origin}/guide`, origin), true)
  assert.equal(
    referencesUrlOrigin(`url: https://example.com/${origin}`, origin),
    false,
  )
  assert.equal(
    referencesUrlOrigin("url: https://docs.cloudflare-fleet.lasers.app.example.com", origin),
    false,
  )
})

test("public verification requires an explicit deployment origin", async () => {
  await assert.rejects(
    verifyPublicDocumentation({
      expectedManifest: {
        format: "cloudflare-fleet.documentation.v1",
        outputs: [{ path: "index.html", sha256: "0".repeat(64), size: 0 }],
        package: { name: "cloudflare-fleet", version: "1.2.3" },
      },
    }),
    /documentation URL is required/u,
  )
})

test("documentation asset ignore policy is an exact deployment allowlist", () => {
  assert.equal(
    documentationAssetsIgnore(["nested/allowed.txt", "index.html"]),
    [
      "*",
      "!*/",
      "!/index.html",
      "!/nested/allowed.txt",
      "!/publication-manifest.json",
      "",
    ].join("\n"),
  )
})
