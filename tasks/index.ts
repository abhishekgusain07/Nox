// This is the entry point that reload-dev bundles and deploys.
// Export every task you want deployed:

export { deliverWebhook } from "./deliver-webhook.js";
export { siteHealthCheck } from "./site-health-check.js";
export { scrapeMetadata } from "./scrape-metadata.js";
export { generateReport } from "./generate-report.js";
export { processImage } from "./process-image.js";
