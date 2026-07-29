import assert from "node:assert/strict"
import test from "node:test"

import {
  matrixNavigationTarget,
} from "../src/matrix-navigation.mjs"

const ACTIONS = Object.freeze([
  { actionIndex: 0, cellIndex: 1, rowIndex: 0, value: "rename-a" },
  { actionIndex: 0, cellIndex: 2, rowIndex: 0, value: "fill-a" },
  { actionIndex: 1, cellIndex: 2, rowIndex: 0, value: "copy-a" },
  { actionIndex: 0, cellIndex: 1, rowIndex: 1, value: "rename-b" },
  { actionIndex: 0, cellIndex: 2, rowIndex: 1, value: "fill-b" },
  { actionIndex: 0, cellIndex: 3, rowIndex: 1, value: "fill-c" },
])

test("horizontal matrix navigation follows actions within a row", () => {
  assert.equal(
    matrixNavigationTarget(ACTIONS, "fill-a", "ArrowRight"),
    "copy-a",
  )
  assert.equal(
    matrixNavigationTarget(ACTIONS, "fill-a", "ArrowLeft"),
    "rename-a",
  )
})

test("vertical matrix navigation preserves the cell and action position", () => {
  assert.equal(
    matrixNavigationTarget(ACTIONS, "fill-a", "ArrowDown"),
    "fill-b",
  )
  assert.equal(
    matrixNavigationTarget(ACTIONS, "copy-a", "ArrowDown"),
    "fill-b",
  )
  assert.equal(
    matrixNavigationTarget(ACTIONS, "fill-b", "ArrowUp"),
    "fill-a",
  )
})

test("Home and End stay in the row unless modified", () => {
  assert.equal(
    matrixNavigationTarget(ACTIONS, "fill-b", "Home"),
    "rename-b",
  )
  assert.equal(
    matrixNavigationTarget(ACTIONS, "fill-b", "End"),
    "fill-c",
  )
  assert.equal(
    matrixNavigationTarget(ACTIONS, "fill-b", "Home", { ctrlKey: true }),
    "rename-a",
  )
  assert.equal(
    matrixNavigationTarget(ACTIONS, "fill-b", "End", { metaKey: true }),
    "fill-c",
  )
})
