import { promises as fs } from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DOCS_ROOT = path.join(PROJECT_ROOT, "docs")
const DEFAULT_PORT = 4173
const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
})

function parsePort(argv) {
  if (argv.length === 0) return DEFAULT_PORT
  if (argv.length !== 2 || argv[0] !== "--port") {
    throw new Error("Usage: serve-docs.mjs [--port PORT]")
  }
  const port = Number(argv[1])
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("Documentation server port is invalid")
  }
  return port
}

function documentationPath(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, "http://localhost").pathname)
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
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
      if (error?.code !== "ENOENT") console.error(error)
      response.writeHead(404)
      response.end("Not found\n")
    }
  })
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  let port
  try {
    port = parsePort(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
  if (port) {
    const server = createDocumentationServer()
    server.listen(port, "127.0.0.1", () => {
      process.stdout.write(`Cloudflare Fleet docs: http://127.0.0.1:${port}/\n`)
    })
    const close = () => server.close()
    process.once("SIGINT", close)
    process.once("SIGTERM", close)
  }
}
