#!/usr/bin/env node
import { startDaemon } from "./server.mjs";

try {
  const d = await startDaemon();
  console.log(`cohandd listening on ${d.sock}`);
  const stop = async () => { await d.close(); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
