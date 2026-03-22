// tasks/deliver-webhook.ts
import { task } from "@reload-dev/sdk/task";
import { createHmac, randomUUID } from "node:crypto";
var deliverWebhook = task({
  id: "deliver-webhook",
  queue: "webhooks",
  retry: { maxAttempts: 5, minTimeout: 1e3, maxTimeout: 6e4, factor: 3 },
  run: async (payload) => {
    const { targetUrl, event, data, secret = "whsec_default" } = payload;
    const deliveryId = randomUUID();
    const timestamp = Math.floor(Date.now() / 1e3).toString();
    const body = JSON.stringify({
      id: deliveryId,
      event,
      data,
      timestamp: Number(timestamp)
    });
    const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    console.log(`[webhook] Delivering ${event} to ${targetUrl} (${deliveryId})`);
    const start = performance.now();
    const res = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Id": deliveryId,
        "X-Webhook-Timestamp": timestamp,
        "X-Webhook-Signature": `sha256=${signature}`,
        "User-Agent": "reload-dev-webhooks/1.0"
      },
      body,
      signal: AbortSignal.timeout(15e3)
    });
    const latencyMs = Math.round(performance.now() - start);
    const responseBody = await res.text();
    const delivered = res.status >= 200 && res.status < 300;
    console.log(
      `[webhook] ${deliveryId} \u2192 ${res.status} (${latencyMs}ms) ${delivered ? "\u2713 delivered" : "\u2717 failed"}`
    );
    if (!delivered) {
      throw new Error(
        `Webhook delivery failed: ${res.status} ${res.statusText} \u2014 ${responseBody.slice(0, 200)}`
      );
    }
    return {
      delivered,
      statusCode: res.status,
      deliveryId,
      latencyMs,
      responseBody: responseBody.slice(0, 500),
      deliveredAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
});

// tasks/site-health-check.ts
import { task as task2 } from "@reload-dev/sdk/task";
var siteHealthCheck = task2({
  id: "site-health-check",
  queue: "monitoring",
  retry: { maxAttempts: 3, minTimeout: 2e3, maxTimeout: 15e3, factor: 2 },
  run: async (payload) => {
    const { url, expectedStatus = 200, timeoutMs = 1e4 } = payload;
    console.log(`[health-check] Pinging ${url}...`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const start = performance.now();
    try {
      const res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        redirect: "follow",
        headers: { "User-Agent": "reload-dev-health-checker/1.0" }
      });
      const latencyMs = Math.round(performance.now() - start);
      const body = await res.text();
      const healthy = res.status === expectedStatus;
      const headers = {};
      res.headers.forEach((value, key) => {
        headers[key] = value;
      });
      console.log(
        `[health-check] ${url} \u2192 ${res.status} (${latencyMs}ms) ${healthy ? "\u2713 healthy" : "\u2717 unhealthy"}`
      );
      return {
        url,
        status: res.status,
        healthy,
        latencyMs,
        headers,
        contentLength: body.length,
        checkedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
    } finally {
      clearTimeout(timeout);
    }
  }
});

// tasks/scrape-metadata.ts
import { task as task3 } from "@reload-dev/sdk/task";
function extractMeta(html, name) {
  const nameRe = new RegExp(
    `<meta[^>]*(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`,
    "i"
  );
  const match = html.match(nameRe);
  if (match?.[1]) return match[1];
  const reverseRe = new RegExp(
    `<meta[^>]*content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`,
    "i"
  );
  const reverseMatch = html.match(reverseRe);
  return reverseMatch?.[1] ?? null;
}
var scrapeMetadata = task3({
  id: "scrape-metadata",
  queue: "scraping",
  retry: { maxAttempts: 2, minTimeout: 3e3, maxTimeout: 1e4, factor: 2 },
  run: async (payload) => {
    const { url } = payload;
    console.log(`[scraper] Fetching ${url}...`);
    const start = performance.now();
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; reload-dev-scraper/1.0; +https://reload.dev)",
        Accept: "text/html,application/xhtml+xml"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(2e4)
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
    }
    const html = await res.text();
    const loadTimeMs = Math.round(performance.now() - start);
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch?.[1] ? titleMatch[1].trim() : null;
    const description = extractMeta(html, "description") || extractMeta(html, "Description");
    const ogImage = extractMeta(html, "og:image");
    const ogTitle = extractMeta(html, "og:title");
    const ogDescription = extractMeta(html, "og:description");
    const faviconMatch = html.match(
      /<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']*)["']/i
    );
    const favicon = faviconMatch?.[1] ?? null;
    const linkCount = (html.match(/<a\s/gi) || []).length;
    const imageCount = (html.match(/<img\s/gi) || []).length;
    const textContent = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const wordCount = textContent.split(/\s+/).filter(Boolean).length;
    console.log(
      `[scraper] ${url} \u2192 "${title}" | ${linkCount} links, ${imageCount} images, ${wordCount} words (${loadTimeMs}ms)`
    );
    return {
      url,
      title,
      description,
      ogImage,
      ogTitle,
      ogDescription,
      favicon,
      linkCount,
      imageCount,
      wordCount,
      contentLengthBytes: html.length,
      loadTimeMs,
      scrapedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
});

// tasks/generate-report.ts
import { task as task4 } from "@reload-dev/sdk/task";
import { createHash } from "node:crypto";
function generateDataset(size, seed) {
  let state = seed;
  const random = () => {
    state |= 0;
    state = state + 1831565813 | 0;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const data = [];
  for (let i = 0; i < size; i++) {
    const u1 = random();
    const u2 = random();
    const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const value = 50 + normal * 15;
    data.push(Math.round(value * 100) / 100);
  }
  return data;
}
function percentile(sorted, p) {
  const idx = p / 100 * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}
var generateReport = task4({
  id: "generate-report",
  run: async (payload) => {
    const { datasetSize, reportName, filters } = payload;
    const start = performance.now();
    console.log(
      `[report] Generating "${reportName}" with ${datasetSize} data points...`
    );
    console.log(`[report] Step 1/4: Generating dataset...`);
    const seed = createHash("md5").update(reportName).digest().readUInt32LE(0);
    let data = generateDataset(datasetSize, seed);
    console.log(`[report] Step 2/4: Applying filters...`);
    const originalSize = data.length;
    if (filters?.minValue != null) {
      data = data.filter((v) => v >= filters.minValue);
    }
    if (filters?.maxValue != null) {
      data = data.filter((v) => v <= filters.maxValue);
    }
    const processingDelay = Math.min(datasetSize / 500, 5e3);
    await new Promise((r) => setTimeout(r, processingDelay));
    console.log(`[report] Step 3/4: Computing statistics (${data.length} records)...`);
    const sorted = [...data].sort((a, b) => a - b);
    const sum = data.reduce((a, b) => a + b, 0);
    const mean = sum / data.length;
    const variance = data.reduce((acc, v) => acc + (v - mean) ** 2, 0) / data.length;
    const stdDev = Math.sqrt(variance);
    const stats = {
      mean: Math.round(mean * 100) / 100,
      median: Math.round(percentile(sorted, 50) * 100) / 100,
      stdDev: Math.round(stdDev * 100) / 100,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p95: Math.round(percentile(sorted, 95) * 100) / 100,
      p99: Math.round(percentile(sorted, 99) * 100) / 100
    };
    console.log(`[report] Step 4/4: Building distribution...`);
    const bucketSize = 10;
    const distribution = {};
    for (const value of data) {
      const bucket = Math.floor(value / bucketSize) * bucketSize;
      const key = `${bucket}-${bucket + bucketSize}`;
      distribution[key] = (distribution[key] || 0) + 1;
    }
    const computeTimeMs = Math.round(performance.now() - start);
    const reportId = createHash("sha256").update(`${reportName}-${Date.now()}`).digest("hex").slice(0, 12);
    console.log(
      `[report] "${reportName}" complete \u2192 mean=${stats.mean}, median=${stats.median}, p99=${stats.p99} (${computeTimeMs}ms)`
    );
    return {
      reportName,
      reportId,
      datasetSize: originalSize,
      filteredSize: data.length,
      stats,
      distribution,
      computeTimeMs,
      generatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
});

// tasks/process-image.ts
import { task as task5 } from "@reload-dev/sdk/task";
import { createHash as createHash2 } from "node:crypto";
function detectDimensions(buf) {
  try {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (buf[0] === 137 && buf[1] === 80) {
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (buf[0] === 255 && buf[1] === 216) {
      let offset = 2;
      while (offset < buf.byteLength - 9) {
        if (buf[offset] === 255 && (buf[offset + 1] === 192 || buf[offset + 1] === 194)) {
          return {
            height: view.getUint16(offset + 5),
            width: view.getUint16(offset + 7)
          };
        }
        offset += 2 + view.getUint16(offset + 2);
      }
    }
    if (buf[0] === 71 && buf[1] === 73 && buf[2] === 70) {
      return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    }
  } catch {
  }
  return { width: null, height: null };
}
function runOperation(buf, op) {
  switch (op) {
    case "thumbnail": {
      const blockSize = 1024;
      const blocks = Math.ceil(buf.byteLength / blockSize);
      const averages = [];
      for (let i = 0; i < blocks; i++) {
        const start = i * blockSize;
        const end = Math.min(start + blockSize, buf.byteLength);
        let sum = 0;
        for (let j = start; j < end; j++) sum += buf[j];
        averages.push(Math.round(sum / (end - start)));
      }
      return { thumbnailBlocks: blocks, compressedSize: averages.length };
    }
    case "grayscale": {
      const histogram = new Array(256).fill(0);
      const limit = Math.min(buf.byteLength, 1e5);
      for (let i = 0; i < limit; i++) {
        histogram[buf[i]]++;
      }
      const peak = histogram.indexOf(Math.max(...histogram));
      return { peakIntensity: peak, sampledBytes: limit };
    }
    case "blur": {
      const windowSize = 5;
      let checksum = 0;
      const limit = Math.min(buf.byteLength, 5e4);
      for (let i = windowSize; i < limit; i++) {
        let sum = 0;
        for (let j = i - windowSize; j < i; j++) sum += buf[j];
        checksum += Math.round(sum / windowSize);
      }
      return { blurChecksum: checksum % 65536, sampledBytes: limit };
    }
    case "hash": {
      const md5 = createHash2("md5").update(buf).digest("hex");
      const sha1 = createHash2("sha1").update(buf).digest("hex");
      return { md5, sha1 };
    }
    case "metadata": {
      const freq = new Array(256).fill(0);
      for (let i = 0; i < buf.byteLength; i++) freq[buf[i]]++;
      const entropy = freq.reduce((e, f) => {
        if (f === 0) return e;
        const p = f / buf.byteLength;
        return e - p * Math.log2(p);
      }, 0);
      return { entropy: Math.round(entropy * 1e3) / 1e3, uniqueBytes: freq.filter((f) => f > 0).length };
    }
    default:
      return null;
  }
}
var processImage = task5({
  id: "process-image",
  queue: "media",
  retry: { maxAttempts: 2, minTimeout: 2e3, maxTimeout: 1e4, factor: 2 },
  run: async (payload) => {
    const { imageUrl, operations } = payload;
    const totalStart = performance.now();
    console.log(`[image] Downloading ${imageUrl}...`);
    const res = await fetch(imageUrl, {
      headers: { "User-Agent": "reload-dev-image-processor/1.0" },
      signal: AbortSignal.timeout(3e4)
    });
    if (!res.ok) {
      throw new Error(`Failed to download image: ${res.status} ${res.statusText}`);
    }
    const arrayBuf = await res.arrayBuffer();
    const buf = new Uint8Array(arrayBuf);
    const contentType = res.headers.get("content-type");
    console.log(
      `[image] Downloaded ${buf.byteLength} bytes (${contentType}). Running ${operations.length} operations...`
    );
    const sha256 = createHash2("sha256").update(buf).digest("hex");
    const dimensions = detectDimensions(buf);
    const opResults = {};
    for (const op of operations) {
      const opStart = performance.now();
      console.log(`[image] Running: ${op}...`);
      const result = runOperation(buf, op);
      const durationMs = Math.round(performance.now() - opStart);
      opResults[op] = { completed: true, durationMs, result };
      console.log(`[image] ${op} done (${durationMs}ms)`);
    }
    const totalProcessingMs = Math.round(performance.now() - totalStart);
    console.log(
      `[image] ${imageUrl} \u2192 ${dimensions.width}x${dimensions.height}, ${operations.length} ops in ${totalProcessingMs}ms`
    );
    return {
      imageUrl,
      originalSizeBytes: buf.byteLength,
      contentType,
      sha256,
      dimensions,
      operations: opResults,
      totalProcessingMs,
      processedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
});
export {
  deliverWebhook,
  generateReport,
  processImage,
  scrapeMetadata,
  siteHealthCheck
};
//# sourceMappingURL=bundle.js.map
