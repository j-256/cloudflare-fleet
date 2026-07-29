import { realpathSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export function isMainModule(moduleUrl, entryPath = process.argv[1]) {
  if (!entryPath) return false
  try {
    return realpathSync(fileURLToPath(moduleUrl))
      === realpathSync(path.resolve(entryPath))
  } catch {
    return false
  }
}
