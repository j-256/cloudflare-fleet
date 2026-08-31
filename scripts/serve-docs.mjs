import { promises as fs } from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { parseCliOptions } from "../src/cli-options.mjs"
import { isMainModule } from "../src/entrypoint.mjs"

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DOCS_ROOT = path.join(PROJECT_ROOT, "docs")
const DEFAULT_PORT = 4173
const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
})

export function documentationServerUsage() {
  return [
    "Usage: serve-docs.mjs [options]",
    "",
    "Options:",
    "  -p, --port PORT   Listen on PORT (default: 4173)",
    "  -h, --help        Show this help",
  ].join("\n")
}

export function parseDocumentationServerArguments(argv) {
  const options = parseCliOptions(argv, [
    { default: false, name: "help", short: "h", value: false },
    { default: String(DEFAULT_PORT), name: "port", short: "p", value: true },
  ])
  const port = Number(options.port)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("Documentation server port is invalid")
  }
  return { help: options.help, port }
}

function documentationPath(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, "http://localhost").pathname)
  let relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
  if (relative && !path.extname(relative)) relative = `${relative}.html`
  const resolved = path.resolve(DOCS_ROOT, relative)
  if (!resolved.startsWith(`${DOCS_ROOT}${path.sep}`)) return null
  return resolved
}

export function createDocumentationServer() {
  return http.createServer(async (request, response) => {
    const filePath = documentationPath(request.url || "/")
    if (!filePath) {
      response.writeHead(404)
      response.end("Not found\n")
      return
    }
    try {
      const body = await fs.readFile(filePath)
      response.writeHead(200, {
        "Content-Length": body.length,
        "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      })
      response.end(body)
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.error(error)
        response.writeHead(500)
        response.end("Internal server error\n")
        return
      }
      try {
        const body = await fs.readFile(path.join(DOCS_ROOT, "404.html"))
        response.writeHead(404, {
          "Content-Length": body.length,
          "Content-Type": MIME_TYPES[".html"],
          "X-Content-Type-Options": "nosniff",
        })
        response.end(body)
      } catch (fallbackError) {
        console.error(fallbackError)
        response.writeHead(500)
        response.end("Internal server error\n")
      }
    }
  })
}

if (isMainModule(import.meta.url)) {
  let options
  try {
    options = parseDocumentationServerArguments(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
  if (options?.help) {
    process.stdout.write(`${documentationServerUsage()}\n`)
  } else if (options) {
    const { port } = options
    const server = createDocumentationServer()
    server.listen(port, "127.0.0.1", () => {
      process.stdout.write(`Cloudflare Fleet docs: http://127.0.0.1:${port}/\n`)
    })
    const close = () => server.close()
    process.once("SIGINT", close)
    process.once("SIGTERM", close)
  }
}
