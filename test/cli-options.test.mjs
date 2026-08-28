import assert from "node:assert/strict"
import test from "node:test"

import {
  CliUsageError,
  parseCliOptions,
} from "../src/cli-options.mjs"

const DEFINITIONS = Object.freeze([
  { default: false, name: "alpha", short: "a", value: false },
  { default: false, name: "beta", short: "b", value: false },
  { name: "output", short: "o", value: true },
  { key: "values", multiple: true, name: "value", short: "v", value: true },
])

test("shared CLI parser supports bundles, glued values, equals, and repeats", () => {
  assert.deepEqual(
    parseCliOptions([
      "-aboresult.json",
      "--value=one",
      "-vtwo",
    ], DEFINITIONS),
    {
      alpha: true,
      beta: true,
      output: "result.json",
      positionals: [],
      values: ["one", "two"],
    },
  )
})

test("shared CLI parser permits interleaved positionals and option termination", () => {
  assert.deepEqual(
    parseCliOptions([
      "first",
      "-a",
      "--",
      "-b",
      "second",
    ], DEFINITIONS, { maxPositionals: 3 }),
    {
      alpha: true,
      beta: false,
      output: null,
      positionals: ["first", "-b", "second"],
      values: [],
    },
  )
})

test("shared CLI parser rejects ambiguity and invalid option grammar", () => {
  assert.throws(
    () => parseCliOptions(["-aa"], DEFINITIONS),
    (error) => error instanceof CliUsageError
      && /may only be provided once/.test(error.message),
  )
  assert.throws(
    () => parseCliOptions(["--alpha=true"], DEFINITIONS),
    /does not take a value/,
  )
  assert.throws(
    () => parseCliOptions(["--unknown"], DEFINITIONS),
    /Unknown option/,
  )
  assert.throws(
    () => parseCliOptions(["extra"], DEFINITIONS),
    /Expected 0 positional arguments/,
  )
})
