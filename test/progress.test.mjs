import assert from "node:assert/strict"
import test from "node:test"

import { createProgressReporter } from "../src/progress.mjs"

function outputStream() {
  let output = ""
  return {
    stream: {
      write(value) {
        output += value
      },
    },
    value() {
      return output
    },
  }
}

test("progress reporting preserves milestones without flooding diagnostics", () => {
  const output = outputStream()
  const report = createProgressReporter(output.stream, "[fleet]")

  for (let completed = 1; completed <= 60; completed += 1) {
    report({
      completed,
      message: `Reading ${completed}/60`,
      stage: "surfaces",
      total: 60,
    })
  }
  report({
    completed: 1,
    message: "Reading rules 1/2",
    stage: "rulesets",
    total: 2,
  })
  report({
    completed: 2,
    message: "Reading rules 2/2",
    stage: "rulesets",
    total: 2,
  })

  assert.equal(output.value(), [
    "[fleet] Reading 1/60",
    "[fleet] Reading 25/60",
    "[fleet] Reading 50/60",
    "[fleet] Reading 60/60",
    "[fleet] Reading rules 1/2",
    "[fleet] Reading rules 2/2",
    "",
  ].join("\n"))
})
