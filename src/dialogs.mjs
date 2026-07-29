export const DIALOG_DISMISS_VALUE = "cancel"

const DIALOG_CLOSE_SELECTOR = "[data-dialog-close]"
const openerByDialog = new WeakMap()

export function dismissDialog(dialog) {
  if (dialog.open) dialog.close(DIALOG_DISMISS_VALUE)
}

function focusElement(element) {
  if (!element || typeof element.focus !== "function") return
  element.focus({ preventScroll: true })
}

export function showDialog(dialog, options = {}) {
  const opener = dialog.ownerDocument?.activeElement
  if (opener && opener !== dialog.ownerDocument?.body) {
    openerByDialog.set(dialog, opener)
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
    openerByDialog.delete(dialog)
    if (!opener?.isConnected || opener.disabled) return
    queueMicrotask(() => focusElement(opener))
  })
}

export function installDismissibleDialogs(root) {
  for (const dialog of root.querySelectorAll("dialog")) {
    installDismissibleDialog(dialog)
  }
}
