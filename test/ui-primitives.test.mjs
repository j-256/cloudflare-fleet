import assert from "node:assert/strict"
import test, { afterEach } from "node:test"

import {
  actionButton,
  attachTooltip,
} from "../src/ui-primitives.mjs"

const ORIGINAL_DOCUMENT = globalThis.document
const ESCAPE_KEY = "Escape"

class FakeClassList {
  constructor(element) {
    this.element = element
  }

  add(...names) {
    const classes = new Set(this.element.className.split(/\s+/).filter(Boolean))
    for (const name of names) classes.add(name)
    this.element.className = [...classes].join(" ")
  }

  contains(name) {
    return this.element.className.split(/\s+/).includes(name)
  }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.attributes = new Map()
    this.children = []
    this.className = ""
    this.classList = new FakeClassList(this)
    this.disabled = false
    this.listeners = new Map()
    this.ownerDocument = ownerDocument
    this.tabIndex = tagName === "button" ? 0 : -1
    this.tagName = tagName
    this.textContent = ""
    this.type = ""
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  append(...children) {
    this.children.push(...children)
  }

  blur() {
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = null
    }
  }

  contains(element) {
    return element === this || this.children.some((child) => child?.contains?.(element))
  }

  dispatch(type, event = {}) {
    const dispatched = {
      currentTarget: this,
      preventDefault() {
        this.defaultPrevented = true
      },
      stopPropagation() {
        this.propagationStopped = true
      },
      ...event,
    }
    for (const listener of this.listeners.get(type) || []) listener(dispatched)
    return dispatched
  }

  focus() {
    this.ownerDocument.activeElement = this
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }
}

class FakeDocument {
  constructor() {
    this.activeElement = null
  }

  createElement(tagName) {
    return new FakeElement(tagName, this)
  }

  createElementNS(_namespace, tagName) {
    return this.createElement(tagName)
  }

  createTextNode(textContent) {
    return { textContent }
  }
}

afterEach(() => {
  if (ORIGINAL_DOCUMENT === undefined) delete globalThis.document
  else globalThis.document = ORIGINAL_DOCUMENT
})

test("attachTooltip creates a positioned focus target that Escape dismisses", () => {
  const document = new FakeDocument()
  const host = document.createElement("span")
  attachTooltip(host, "Live state was validated", {
    align: "start",
    below: true,
    focusable: true,
  })

  assert.equal(host.classList.contains("tooltip-host"), true)
  assert.equal(host.tabIndex, 0)
  assert.equal(host.children.length, 1)
  assert.equal(
    host.children[0].className,
    "tooltip tooltip--below tooltip--align-start",
  )
  assert.equal(host.children[0].getAttribute("aria-hidden"), "true")
  assert.equal(host.children[0].textContent, "Live state was validated")

  host.focus()
  const event = host.dispatch("keydown", { key: ESCAPE_KEY })
  assert.equal(document.activeElement, null)
  assert.equal(event.defaultPrevented, true)
  assert.equal(event.propagationStopped, true)
})

test("actionButton preserves an accessible label and tooltip for icon-only actions", () => {
  const document = new FakeDocument()
  globalThis.document = document
  let clicks = 0
  const button = actionButton("Remove", () => {
    clicks += 1
  }, {
    context: "Policy for All zones",
    danger: true,
    icon: "remove",
    iconOnly: true,
  })

  assert.equal(button.className, "button button-danger button-icon tooltip-host")
  assert.equal(button.type, "button")
  assert.equal(button.getAttribute("aria-label"), "Remove: Policy for All zones")
  assert.equal(button.children[0].tagName, "svg")
  assert.equal(button.children[1].textContent, "Remove: Policy for All zones")
  button.dispatch("click")
  assert.equal(clicks, 1)
})
