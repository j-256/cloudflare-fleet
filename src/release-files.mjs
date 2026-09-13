import { constants, promises as fs } from "node:fs"

export const MAX_RELEASE_INPUT_BYTES = 20 * 1024 * 1024
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)

export async function readRegularReleaseFile(file, maxBytes = MAX_RELEASE_INPUT_BYTES, { open = fs.open } = {}) {
  const handle = await open(file, READ_FLAGS)
  try {
    const metadata = await handle.stat()
    const entry = await fs.lstat(file)
    if (!metadata.isFile() || entry.isSymbolicLink() || entry.dev !== metadata.dev || entry.ino !== metadata.ino
      || !Number.isSafeInteger(metadata.size) || metadata.size > maxBytes) throw new Error("Release input is not a bounded regular file")
    const content = Buffer.alloc(metadata.size + 1)
    let length = 0
    while (length < content.length) {
      const { bytesRead } = await handle.read(content, length, content.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    const after = await handle.stat()
    if (length !== metadata.size || after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || after.ctimeMs !== metadata.ctimeMs) {
      throw new Error("Release input changed while it was being read")
    }
    return { content: content.subarray(0, length), mode: metadata.mode }
  } finally {
    await handle.close()
  }
}
