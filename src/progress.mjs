const PROGRESS_INTERVAL = 25

export function createProgressReporter(stderr, prefix) {
  let lastMessage = ""
  let lastStage = ""
  return (progress) => {
    const stage = progress.stage || "working"
    const message = progress.message
      || `${stage} ${progress.completed}/${progress.total}`
    if (message === lastMessage) return
    const counted = Number.isInteger(progress.completed)
      && Number.isInteger(progress.total)
    const shouldReport = !counted
      || stage !== lastStage
      || progress.completed === progress.total
      || progress.completed % PROGRESS_INTERVAL === 0
    if (!shouldReport) return
    lastMessage = message
    lastStage = stage
    stderr.write(`${prefix} ${message}\n`)
  }
}
