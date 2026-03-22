import { registerTask, startWorker } from "@reload-dev/worker";
import { siteHealthCheck } from "./site-health-check.js";
import { deliverWebhook } from "./deliver-webhook.js";
import { scrapeMetadata } from "./scrape-metadata.js";
import { generateReport } from "./generate-report.js";
import { processImage } from "./process-image.js";

registerTask(siteHealthCheck);
registerTask(deliverWebhook);
registerTask(scrapeMetadata);
registerTask(generateReport);
registerTask(processImage);

startWorker().catch((err) => {
  console.error("Worker failed:", err);
  process.exit(1);
});
