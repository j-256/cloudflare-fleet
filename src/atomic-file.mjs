import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"

const PRIVATE_FILE_MODE = 0o600

function temporaryPath(filePath) {
  return `${filePath}.${process.pid}.${randomUUID()}.tmp`
}

async function syncParentDirectory(filePath) {
  const directory = await fs.open(path.dirname(filePath), "r")
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

export async function atomicWriteFile(filePath, content) {
  const temporaryFile = temporaryPath(filePath)
  let handle = null
  try {
    handle = await fs.open(temporaryFile, "wx", PRIVATE_FILE_MODE)
    await handle.writeFile(content, "utf8")
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(temporaryFile, filePath)
    await syncParentDirectory(filePath)
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await fs.rm(temporaryFile, { force: true }).catch(() => {})
    throw error
  }
}
