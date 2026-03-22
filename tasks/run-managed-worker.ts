import { startManagedWorker } from "../packages/worker/src/managed.js";

startManagedWorker().catch((err) => {
  console.error("Managed worker failed:", err);
  process.exit(1);
});
