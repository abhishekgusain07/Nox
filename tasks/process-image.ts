import { task } from "@reload-dev/sdk/task";
import { createHash } from "node:crypto";

interface ImagePayload {
  imageUrl: string;
  operations: Array<"thumbnail" | "grayscale" | "blur" | "hash" | "metadata">;
}

interface ImageResult {
  imageUrl: string;
  originalSizeBytes: number;
  contentType: string | null;
  sha256: string;
  dimensions: { width: number | null; height: number | null };
  operations: Record<string, { completed: boolean; durationMs: number; result: unknown }>;
  totalProcessingMs: number;
  processedAt: string;
}

// Detect PNG/JPEG/GIF dimensions from raw bytes
function detectDimensions(buf: Uint8Array): { width: number | null; height: number | null } {
  try {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    // PNG: width at offset 16, height at offset 20
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    // JPEG: scan for SOF0/SOF2 marker
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let offset = 2;
      while (offset < buf.byteLength - 9) {
        if (buf[offset] === 0xff && (buf[offset + 1] === 0xc0 || buf[offset + 1] === 0xc2)) {
          return {
            height: view.getUint16(offset + 5),
            width: view.getUint16(offset + 7),
          };
        }
        offset += 2 + view.getUint16(offset + 2);
      }
    }
    // GIF: width at offset 6, height at offset 8 (little-endian)
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
      return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    }
  } catch {
    // Fall through
  }
  return { width: null, height: null };
}

// CPU-bound image operation (real computation on the buffer)
function runOperation(buf: Uint8Array, op: string): unknown {
  switch (op) {
    case "thumbnail": {
      const blockSize = 1024;
      const blocks = Math.ceil(buf.byteLength / blockSize);
      const averages: number[] = [];
      for (let i = 0; i < blocks; i++) {
        const start = i * blockSize;
        const end = Math.min(start + blockSize, buf.byteLength);
        let sum = 0;
        for (let j = start; j < end; j++) sum += buf[j]!;
        averages.push(Math.round(sum / (end - start)));
      }
      return { thumbnailBlocks: blocks, compressedSize: averages.length };
    }
    case "grayscale": {
      const histogram = new Array<number>(256).fill(0);
      const limit = Math.min(buf.byteLength, 100000);
      for (let i = 0; i < limit; i++) {
        histogram[buf[i]!]!++;
      }
      const peak = histogram.indexOf(Math.max(...histogram));
      return { peakIntensity: peak, sampledBytes: limit };
    }
    case "blur": {
      const windowSize = 5;
      let checksum = 0;
      const limit = Math.min(buf.byteLength, 50000);
      for (let i = windowSize; i < limit; i++) {
        let sum = 0;
        for (let j = i - windowSize; j < i; j++) sum += buf[j]!;
        checksum += Math.round(sum / windowSize);
      }
      return { blurChecksum: checksum % 65536, sampledBytes: limit };
    }
    case "hash": {
      const md5 = createHash("md5").update(buf).digest("hex");
      const sha1 = createHash("sha1").update(buf).digest("hex");
      return { md5, sha1 };
    }
    case "metadata": {
      const freq = new Array<number>(256).fill(0);
      for (let i = 0; i < buf.byteLength; i++) freq[buf[i]!]!++;
      const entropy = freq.reduce((e, f) => {
        if (f === 0) return e;
        const p = f / buf.byteLength;
        return e - p * Math.log2(p);
      }, 0);
      return { entropy: Math.round(entropy * 1000) / 1000, uniqueBytes: freq.filter((f) => f > 0).length };
    }
    default:
      return null;
  }
}

export const processImage = task<ImagePayload, ImageResult>({
  id: "process-image",
  queue: "media",
  retry: { maxAttempts: 2, minTimeout: 2000, maxTimeout: 10000, factor: 2 },
  run: async (payload) => {
    const { imageUrl, operations } = payload;
    const totalStart = performance.now();

    console.log(`[image] Downloading ${imageUrl}...`);

    const res = await fetch(imageUrl, {
      headers: { "User-Agent": "reload-dev-image-processor/1.0" },
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      throw new Error(`Failed to download image: ${res.status} ${res.statusText}`);
    }

    const arrayBuf = await res.arrayBuffer();
    const buf = new Uint8Array(arrayBuf);
    const contentType = res.headers.get("content-type");

    console.log(
      `[image] Downloaded ${buf.byteLength} bytes (${contentType}). Running ${operations.length} operations...`,
    );

    const sha256 = createHash("sha256").update(buf).digest("hex");
    const dimensions = detectDimensions(buf);

    const opResults: Record<string, { completed: boolean; durationMs: number; result: unknown }> = {};

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
      `[image] ${imageUrl} → ${dimensions.width}x${dimensions.height}, ${operations.length} ops in ${totalProcessingMs}ms`,
    );

    return {
      imageUrl,
      originalSizeBytes: buf.byteLength,
      contentType,
      sha256,
      dimensions,
      operations: opResults,
      totalProcessingMs,
      processedAt: new Date().toISOString(),
    };
  },
});
