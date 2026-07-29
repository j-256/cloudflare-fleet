import assert from "node:assert/strict"
import test from "node:test"

import {
  DIALOG_DISMISS_VALUE,
  installDismissibleDialog,
  showDialog,
} from "../src/dialogs.mjs"

class FakeDialog {
  constructor() {
    this.handlers = new Map()
    this.open = false
    this.returnValue = "stale"
  }

  addEventListener(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, [])
    this.handlers.get(type).push(handler)
  }

  close(returnValue) {
    this.open = false
    this.returnValue = returnValue
  }

  emit(type, event) {
    for (const handler of this.handlers.get(type) || []) handler(event)
  }

  showModal() {
    this.open = true
  }
}

test("showDialog clears a stale confirmation result", () => {
  const dialog = new FakeDialog()

  showDialog(dialog)

  assert.equal(dialog.open, true)
  assert.equal(dialog.returnValue, "")
})

test("showDialog focuses dialog content and restores its opener", async () => {
  let initialFocusCount = 0
  let openerFocusCount = 0
  const opener = {
    disabled: false,
    focus: () => {
      openerFocusCount += 1
    },
    isConnected: true,
  }
  const initialFocus = {
    focus: () => {
      initialFocusCount += 1
    },
  }
  const dialog = new FakeDialog()
  dialog.ownerDocument = {
    activeElement: opener,
    body: {},
  }
  installDismissibleDialog(dialog)

  showDialog(dialog, { initialFocus })
  dialog.emit("close", {})
  await new Promise((resolve) => queueMicrotask(resolve))

  assert.equal(initialFocusCount, 1)
  assert.equal(openerFocusCount, 1)
})

test("dialogs dismiss from their close control and backdrop", () => {
  const dialog = new FakeDialog()
  installDismissibleDialog(dialog)

  showDialog(dialog)
  dialog.emit("click", {
    target: {
      closest: (selector) => selector === "[data-dialog-close]",
    },
  })
  assert.equal(dialog.open, false)
  assert.equal(dialog.returnValue, DIALOG_DISMISS_VALUE)

  showDialog(dialog)
  dialog.emit("click", {
    target: dialog,
  })
  assert.equal(dialog.open, false)
  assert.equal(dialog.returnValue, DIALOG_DISMISS_VALUE)
})

test("inside clicks stay open and Escape dismisses safely", () => {
  const dialog = new FakeDialog()
  let prevented = false
  installDismissibleDialog(dialog)

  showDialog(dialog)
  dialog.emit("click", {
    target: {
      closest: () => null,
    },
  })
  assert.equal(dialog.open, true)

  dialog.emit("cancel", {
    preventDefault: () => {
      prevented = true
    },
  })
  assert.equal(prevented, true)
  assert.equal(dialog.open, false)
  assert.equal(dialog.returnValue, DIALOG_DISMISS_VALUE)
})
