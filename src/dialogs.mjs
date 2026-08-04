export const DIALOG_DISMISS_VALUE = "cancel"

const DIALOG_CLOSE_SELECTOR = "[data-dialog-close]"
const openerByDialog = new WeakMap()
const fallbackFocusByDialog = new WeakMap()

export function dismissDialog(dialog) {
  if (dialog.open) dialog.close(DIALOG_DISMISS_VALUE)
}

function focusElement(element) {
  if (!element || typeof element.focus !== "function") return
  element.focus({ preventScroll: true })
}

function availableFocusTarget(target) {
  const element = typeof target === "function" ? target() : target
  if (!element?.isConnected || element.disabled) return null
  if (typeof element.getClientRects === "function"
    && element.getClientRects().length === 0) return null
  return element
}

function scheduleFocusRestoration(dialog, restoreFocus) {
  const view = dialog.ownerDocument?.defaultView
  if (typeof view?.requestAnimationFrame === "function") {
    view.requestAnimationFrame(restoreFocus)
    return
  }
  queueMicrotask(restoreFocus)
}

export function showDialog(dialog, options = {}) {
  const opener = dialog.ownerDocument?.activeElement
  if (opener && opener !== dialog.ownerDocument?.body) {
    openerByDialog.set(dialog, opener)
  }
  if (options.fallbackFocus) {
    fallbackFocusByDialog.set(dialog, options.fallbackFocus)
  }
  dialog.returnValue = ""
  dialog.showModal()
  const initialFocus = typeof options.initialFocus === "string"
    ? dialog.querySelector(options.initialFocus)
    : options.initialFocus
  focusElement(initialFocus)
}

export function installDismissibleDialog(dialog) {
  dialog.addEventListener("click", (event) => {
    const closeControl = event.target.closest?.(DIALOG_CLOSE_SELECTOR)
    if (event.target === dialog || closeControl) dismissDialog(dialog)
  })
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault()
    dismissDialog(dialog)
  })
  dialog.addEventListener("close", () => {
    const opener = openerByDialog.get(dialog)
    const fallbackFocus = fallbackFocusByDialog.get(dialog)
    openerByDialog.delete(dialog)
    fallbackFocusByDialog.delete(dialog)
    scheduleFocusRestoration(dialog, () => {
      focusElement(
        availableFocusTarget(opener)
          || availableFocusTarget(fallbackFocus),
      )
    })
  })
}

export function installDismissibleDialogs(root) {
  for (const dialog of root.querySelectorAll("dialog")) {
    installDismissibleDialog(dialog)
  }
}
