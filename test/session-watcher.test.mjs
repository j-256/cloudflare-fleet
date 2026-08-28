import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"

import {
  CACHE_SNAPSHOT_GLOBAL,
  createCacheRecord,
} from "../src/cache.mjs"
import {
  evaluateDevToolsExpression,
  parseWatcherOptions,
  runtimePathIsSafe,
  stopBrowser,
  watchSession,
} from "../src/session-watcher.mjs"
import {
  makeInventory,
  makeZone,
} from "./fixtures.mjs"

function watcherOptions() {
  return {
    cacheDir: "/tmp/cloudflare-fleet-cache-test",
    chromePid: 12345,
    port: 9222,
    runtimeBase: "/tmp",
    runtimeDir: "/tmp/cloudflare-fleet.abc123",
    serviceTarget: "gui/501/app.cloudflare-fleet.watcher.abc123",
    sessionId: "abc123",
    sessionUrl: "file:///tmp/cloudflare-fleet.abc123/index.html",
    targetId: "target-id",
  }
}

function serializedRecord(timestamp = "2026-08-10T01:00:00.000Z") {
  const inventory = makeInventory([makeZone("alpha.example")])
  inventory.loadedAt = timestamp
  return JSON.stringify(createCacheRecord("account-id", inventory, {
    updatedAt: timestamp,
  }))
}

function targetFor(options) {
  return {
    id: options.targetId,
    url: options.sessionUrl,
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/target-id",
  }
}

function watcherDependencies(overrides = {}) {
  const signalTarget = new EventEmitter()
  const warnings = []
  const cleanup = {
    browser: 0,
    runtime: 0,
    service: 0,
  }
  return {
    cleanup,
    dependencies: {
      delay: async () => {},
      evaluate: async () => null,
      listTargets: async () => [],
      persistCacheRecord: async () => {},
      removeLaunchdService: () => {
        cleanup.service += 1
      },
      removeRuntime: async () => {
        cleanup.runtime += 1
      },
      signalTarget,
      stderr: {
        write(message) {
          warnings.push(message)
        },
      },
      stopBrowser: async () => {
        cleanup.browser += 1
        return true
      },
      ...overrides,
    },
    signalTarget,
    warnings,
  }
}

class FakeWebSocket {
  constructor(onSend = null) {
    this.listeners = new Map()
    this.onSend = onSend
    this.closed = false
  }

  addEventListener(type, callback, options = {}) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push({
      callback,
      once: options.once === true,
    })
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.emit("close", {})
  }

  emit(type, event) {
    const entries = this.listeners.get(type) || []
    this.listeners.set(type, entries.filter((entry) => !entry.once))
    for (const entry of entries) entry.callback(event)
  }

  send(message) {
    this.onSend?.(message, this)
  }
}

test("watcher options constrain cleanup and process targets", () => {
  const options = watcherOptions()
  const args = [
    String(options.port),
    options.targetId,
    options.sessionUrl,
    options.runtimeDir,
    options.runtimeBase,
    options.cacheDir,
    options.sessionId,
    String(options.chromePid),
    options.serviceTarget,
  ]

  assert.deepEqual(parseWatcherOptions(args), options)

  for (const [index, value, message] of [
    [0, "0", /Invalid DevTools port/],
    [0, "65536", /Invalid DevTools port/],
    [6, "../escape", /Invalid session identifier/],
    [7, "0", /Invalid Chrome process identifier/],
    [8, "gui/501/com.example.unsafe", /Invalid launchd service target/],
  ]) {
    const invalid = [...args]
    invalid[index] = value
    assert.throws(() => parseWatcherOptions(invalid), message)
  }

  const unsafeRuntime = [...args]
  unsafeRuntime[3] = "/tmp/unrelated.abc123"
  assert.throws(() => parseWatcherOptions(unsafeRuntime), /Invalid session runtime path/)

  const unrelatedSession = [...args]
  unrelatedSession[2] = "file:///tmp/another-session/index.html"
  assert.throws(() => parseWatcherOptions(unrelatedSession), /Invalid session URL/)

  const mismatchedRuntime = [...args]
  mismatchedRuntime[3] = "/tmp/cloudflare-fleet.other"
  assert.throws(() => parseWatcherOptions(mismatchedRuntime), /Invalid session runtime path/)

  const mismatchedService = [...args]
  mismatchedService[8] = "gui/501/app.cloudflare-fleet.watcher.other"
  assert.throws(() => parseWatcherOptions(mismatchedService), /Invalid launchd service target/)
})

test("runtime cleanup requires an exact direct session directory", () => {
  assert.equal(runtimePathIsSafe("/tmp/cloudflare-fleet.abc123", "/tmp"), true)
  assert.equal(runtimePathIsSafe("/tmp/cloudflare-fleet.", "/tmp"), false)
  assert.equal(runtimePathIsSafe("/tmp/cloudflare-fleet.abc-123", "/tmp"), false)
  assert.equal(runtimePathIsSafe("/tmp/cloudflare-fleet.abc123/nested", "/tmp"), false)
})

test("DevTools evaluation returns the matching protocol response", async () => {
  const socket = new FakeWebSocket((message, activeSocket) => {
    const request = JSON.parse(message)
    assert.equal(request.method, "Runtime.evaluate")
    assert.equal(request.params.expression, "globalThis.snapshot")
    queueMicrotask(() => activeSocket.emit("message", {
      data: JSON.stringify({
        id: request.id,
        result: {
          result: {
            value: "serialized snapshot",
          },
        },
      }),
    }))
  })
  queueMicrotask(() => socket.emit("open", {}))

  const result = await evaluateDevToolsExpression(
    "ws://127.0.0.1/devtools/page/target-id",
    "globalThis.snapshot",
    { createSocket: () => socket },
  )

  assert.equal(result, "serialized snapshot")
  assert.equal(socket.closed, true)
})

test("DevTools evaluation rejects malformed and interrupted responses", async () => {
  const malformed = new FakeWebSocket((_message, socket) => {
    queueMicrotask(() => socket.emit("message", { data: "not json" }))
  })
  queueMicrotask(() => malformed.emit("open", {}))
  await assert.rejects(
    evaluateDevToolsExpression("ws://invalid", "expression", {
      createSocket: () => malformed,
    }),
    /invalid evaluation response/,
  )

  const interrupted = new FakeWebSocket((_message, socket) => {
    queueMicrotask(() => socket.close())
  })
  queueMicrotask(() => interrupted.emit("open", {}))
  await assert.rejects(
    evaluateDevToolsExpression("ws://invalid", "expression", {
      createSocket: () => interrupted,
    }),
    /closed before evaluation completed/,
  )
})

test("DevTools evaluation reports setup, protocol, send, and timeout failures", async () => {
  await assert.rejects(
    evaluateDevToolsExpression("ws://invalid", "expression", {
      createSocket() {
        throw new Error("Socket setup failed")
      },
    }),
    /Socket setup failed/,
  )

  const failed = new FakeWebSocket((_message, socket) => {
    queueMicrotask(() => socket.emit("message", {
      data: JSON.stringify({
        error: { message: "Evaluation denied" },
        id: 1,
      }),
    }))
  })
  queueMicrotask(() => failed.emit("open", {}))
  await assert.rejects(
    evaluateDevToolsExpression("ws://invalid", "expression", {
      createSocket: () => failed,
    }),
    /Evaluation denied/,
  )

  const sendFailure = new FakeWebSocket(() => {
    throw new Error("send failed")
  })
  queueMicrotask(() => sendFailure.emit("open", {}))
  await assert.rejects(
    evaluateDevToolsExpression("ws://invalid", "expression", {
      createSocket: () => sendFailure,
    }),
    /could not be sent/,
  )

  const timedOut = new FakeWebSocket()
  await assert.rejects(
    evaluateDevToolsExpression("ws://invalid", "expression", {
      createSocket: () => timedOut,
      timeoutMs: 1,
    }),
    /timed out/,
  )
  assert.equal(timedOut.closed, true)
})

test("browser shutdown distinguishes exited and unresponsive processes", async () => {
  const exitedSignals = []
  const exited = await stopBrowser(12345, {
    delay: async () => {},
    sendSignal(processId, signal) {
      exitedSignals.push([processId, signal])
      if (exitedSignals.length > 3) throw new Error("Process exited")
    },
  })
  assert.equal(exited, true)
  assert.deepEqual(exitedSignals.slice(0, 2), [
    [12345, 0],
    [12345, "SIGTERM"],
  ])

  const unresponsive = await stopBrowser(12345, {
    delay: async () => {},
    sendSignal() {},
  })
  assert.equal(unresponsive, false)
})

test("snapshot failures do not count as a missing browser target", async () => {
  const options = watcherOptions()
  const target = targetFor(options)
  const targetLists = [[target], [], [], []]
  let targetReads = 0
  let persistAttempts = 0
  const harness = watcherDependencies({
    evaluate: async (_url, expression) => {
      assert.equal(
        expression,
        `globalThis[${JSON.stringify(CACHE_SNAPSHOT_GLOBAL)}] ?? null`,
      )
      return serializedRecord()
    },
    listTargets: async () => targetLists[targetReads++] ?? [],
    persistCacheRecord: async () => {
      persistAttempts += 1
      throw new Error("Cache volume is unavailable")
    },
  })

  await watchSession(options, harness.dependencies)

  assert.equal(targetReads, 4)
  assert.equal(persistAttempts, 1)
  assert.equal(harness.warnings.length, 1)
  assert.match(harness.warnings[0], /Cache volume is unavailable/)
  assert.deepEqual(harness.cleanup, {
    browser: 1,
    runtime: 1,
    service: 1,
  })
  assert.equal(harness.signalTarget.listenerCount("SIGINT"), 0)
  assert.equal(harness.signalTarget.listenerCount("SIGTERM"), 0)
})

test("snapshot persistence retries quietly and saves only changed records", async () => {
  const options = watcherOptions()
  const target = targetFor(options)
  const first = serializedRecord("2026-08-10T01:00:00.000Z")
  const second = serializedRecord("2026-08-10T01:00:01.000Z")
  const snapshots = [first, first, first, second, second]
  const targetLists = [
    [target],
    [target],
    [target],
    [target],
    [target],
    [],
    [],
    [],
  ]
  let targetReads = 0
  let evaluations = 0
  let persistAttempts = 0
  const persisted = []
  const harness = watcherDependencies({
    evaluate: async () => snapshots[evaluations++],
    listTargets: async () => targetLists[targetReads++] ?? [],
    persistCacheRecord: async (_cacheDir, _sessionId, record) => {
      persistAttempts += 1
      if (persistAttempts < 3) throw new Error("Cache volume is unavailable")
      persisted.push(record)
    },
  })

  await watchSession(options, harness.dependencies)

  assert.equal(targetReads, 8)
  assert.equal(evaluations, 5)
  assert.equal(persistAttempts, 4)
  assert.deepEqual(
    persisted.map((record) => record.updatedAt),
    [
      "2026-08-10T01:00:00.000Z",
      "2026-08-10T01:00:01.000Z",
    ],
  )
  assert.equal(harness.warnings.length, 1)
})

test("watcher preserves runtime files when the browser does not stop", async () => {
  const options = watcherOptions()
  const harness = watcherDependencies({
    stopBrowser: async () => false,
  })

  await watchSession(options, harness.dependencies)

  assert.equal(harness.cleanup.runtime, 0)
  assert.equal(harness.cleanup.service, 1)
  assert.equal(harness.warnings.length, 1)
  assert.match(harness.warnings[0], /did not stop; preserving/)
})
