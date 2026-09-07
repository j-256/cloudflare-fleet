import { spawnSync } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"

import { isMainModule } from "../src/entrypoint.mjs"
import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/package-metadata.mjs"

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ATTENTION_EXIT_CODE = 4

function commandFailure(command, result) {
  const detail = [result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .trim()
  return new Error(`${command.join(" ")} failed${detail ? `:\n${detail}` : ""}`)
}

function run(command, options = {}) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
  })
  const acceptedExitCodes = options.acceptedExitCodes || [0]
  if (result.error) throw result.error
  if (!acceptedExitCodes.includes(result.status)) {
    throw commandFailure(command, result)
  }
  return result
}

function parseJsonOutput(command, result) {
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`${command.join(" ")} returned invalid JSON:\n${result.stdout}`)
  }
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative !== ""
    && !relative.startsWith(`..${path.sep}`)
    && relative !== ".."
    && !path.isAbsolute(relative)
}

async function verifyMcp(executable, cwd, environment) {
  const transport = new StdioClientTransport({
    args: ["mcp"],
    command: executable,
    cwd,
    env: environment,
    stderr: "pipe",
  })
  let diagnostics = ""
  transport.stderr.on("data", (chunk) => {
    diagnostics += chunk
  })
  const client = new Client(
    { name: "cloudflare-fleet-install-check", version: "1.0.0" },
    { capabilities: {} },
  )
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    if (!tools.tools.some((tool) => tool.name === "get_runtime_status")) {
      throw new Error("Installed MCP server did not advertise runtime diagnostics")
    }
    const result = await client.callTool({
      arguments: {},
      name: "get_runtime_status",
    })
    if (!["attention", "ready"].includes(result.structuredContent?.status)) {
      throw new Error("Installed MCP runtime diagnostic returned an invalid status")
    }
  } finally {
    await client.close().catch(() => {})
  }
  if (diagnostics.includes(environment.CLOUDFLARE_API_TOKEN)) {
    throw new Error("Installed MCP diagnostics exposed the Cloudflare API token")
  }
}

export async function checkInstall() {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudflare-fleet-install."),
  )
  try {
    const artifactDirectory = path.join(temporaryRoot, "artifact")
    const installPrefix = path.join(temporaryRoot, "prefix")
    const xdgConfig = path.join(temporaryRoot, "config")
    const xdgState = path.join(temporaryRoot, "state")
    await fs.mkdir(artifactDirectory, { recursive: true })

    const packCommand = [
      "npm",
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      artifactDirectory,
    ]
    const packReport = parseJsonOutput(
      packCommand,
      run(packCommand, { cwd: PROJECT_ROOT }),
    )
    const artifactName = packReport[0]?.filename
    if (!artifactName) throw new Error("npm pack did not report an artifact filename")
    const artifactPath = path.join(artifactDirectory, artifactName)

    run([
      "npm",
      "install",
      "--global",
      "--prefix",
      installPrefix,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      artifactPath,
    ], { cwd: temporaryRoot })

    const packageRoot = path.join(
      installPrefix,
      "lib",
      "node_modules",
      PACKAGE_NAME,
    )
    const packageMetadata = await fs.lstat(packageRoot)
    if (packageMetadata.isSymbolicLink()) {
      throw new Error("Installed package root is linked to its source checkout")
    }
    const resolvedPrefix = await fs.realpath(installPrefix)
    const resolvedPackageRoot = await fs.realpath(packageRoot)
    if (!isWithin(resolvedPrefix, resolvedPackageRoot)) {
      throw new Error("Installed package root resolves outside its isolated prefix")
    }

    const executable = path.join(installPrefix, "bin", PACKAGE_NAME)
    const resolvedExecutable = await fs.realpath(executable)
    if (!isWithin(resolvedPackageRoot, resolvedExecutable)) {
      throw new Error("Installed executable resolves outside the packed package")
    }

    const environment = { ...process.env }
    delete environment.CLOUDFLARE_FLEET_POLICY_FILE
    delete environment.CLOUDFLARE_FLEET_STATE_FILE
    Object.assign(environment, {
      CLOUDFLARE_FLEET_BACKEND: "local",
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_API_TOKEN: "install-smoke-token",
      XDG_CONFIG_HOME: xdgConfig,
      XDG_STATE_HOME: xdgState,
    })

    const version = run([executable, "--version"], {
      cwd: temporaryRoot,
      env: environment,
    }).stdout.trim()
    if (version !== PACKAGE_VERSION) {
      throw new Error(`Installed CLI reported version ${version || "<empty>"}`)
    }
    run([executable, "--help"], { cwd: temporaryRoot, env: environment })
    run([executable, "dashboard", "--help"], {
      cwd: temporaryRoot,
      env: environment,
    })
    run([executable, "mcp", "--help"], {
      cwd: temporaryRoot,
      env: environment,
    })
    await verifyMcp(executable, temporaryRoot, environment)

    const configCommand = [executable, "config", "show", "--format", "json"]
    const configuration = parseJsonOutput(
      configCommand,
      run(configCommand, { cwd: temporaryRoot, env: environment }),
    )
    if (configuration.paths.state.source !== "xdg"
      || configuration.paths.policy.source !== "xdg") {
      throw new Error("Installed CLI did not honor isolated XDG paths")
    }

    const doctorCommand = [executable, "doctor", "--format", "json"]
    const diagnosis = parseJsonOutput(
      doctorCommand,
      run(doctorCommand, {
        acceptedExitCodes: [0, ATTENTION_EXIT_CODE],
        cwd: temporaryRoot,
        env: environment,
      }),
    )
    if (!["attention", "ready"].includes(diagnosis.status)) {
      throw new Error(`Installed doctor reported unexpected status ${diagnosis.status}`)
    }

    return {
      artifact: artifactName,
      packageVersion: PACKAGE_VERSION,
    }
  } finally {
    await fs.rm(temporaryRoot, { force: true, recursive: true })
  }
}

if (isMainModule(import.meta.url)) {
  checkInstall().then((result) => {
    process.stdout.write(
      `Packed install is independent and ready (${result.artifact})\n`,
    )
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
