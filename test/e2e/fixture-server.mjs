import {
  closeDashboardSession,
  createDashboardSession,
} from "./dashboard.fixture.mjs"
import { createDemoFleet } from "../demo-fleet.mjs"

const demo = createDemoFleet()
const session = await createDashboardSession({ inventory: demo.inventory, intentDocument: demo.intent })
process.stdout.write(`${session.url}\n`)

await new Promise((resolve) => {
  process.once("SIGINT", resolve)
  process.once("SIGTERM", resolve)
  session.broker.closed.then(resolve)
})

session.broker.server.closeAllConnections?.()
await closeDashboardSession(session)
