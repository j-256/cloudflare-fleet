import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const appSource = await readFile(new URL("../src/app.mjs", import.meta.url), "utf8")

test("offline guidance matches automatic session reconnection", () => {
  assert.match(appSource, /SESSION_RECONNECT_ESCALATION_MS = 10000/)
  assert.match(
    appSource,
    /SESSION_RECONNECT_DETAIL = "The loaded matrix remains available while the dashboard reconnects automatically; live reads and writes are locked"/,
  )
  assert.match(
    appSource,
    /SESSION_RECONNECT_EMPTY_DETAIL = "No fleet inventory is loaded\. The dashboard is reconnecting automatically; live reads and writes are locked"/,
  )
  assert.match(
    appSource,
    /SESSION_RECONNECT_WRITE_STATUS = "Reconnecting to the session broker; writes remain locked"/,
  )
  assert.match(
    appSource,
    /SESSION_RELAUNCH_DETAIL = "The loaded matrix remains available, but automatic reconnection has not succeeded\. Relaunch the dashboard to restore live reads and writes"/,
  )
  assert.match(
    appSource,
    /return state\.inventory\s*\? SESSION_RELAUNCH_DETAIL\s*: SESSION_RELAUNCH_EMPTY_DETAIL/,
  )
  assert.match(
    appSource,
    /setTimeout\(\(\) => \{\s*state\.transportReconnectTimer = null\s*if \(state\.transportAvailable\) return\s*state\.transportReconnectEscalated = true/,
  )
  assert.match(
    appSource,
    /onDisconnected: \(\) => \{\s*state\.transportAvailable = false\s*beginSessionReconnectEscalation\(\)\s*restoreInventoryStatus\(\)/,
  )
})
