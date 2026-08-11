import {
  closeDashboardSession,
  createDashboardSession,
} from "./dashboard.fixture.mjs"

const session = await createDashboardSession()
process.stdout.write(`${session.url}\n`)

await new Promise((resolve) => {
  process.once("SIGINT", resolve)
  process.once("SIGTERM", resolve)
  session.broker.closed.then(resolve)
})

session.broker.server.closeAllConnections?.()
await closeDashboardSession(session)
