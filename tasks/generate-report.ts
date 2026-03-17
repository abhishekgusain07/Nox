import { task } from "@reload-dev/sdk/task";
import { createHash } from "node:crypto";

interface ReportPayload {
  datasetSize: number;
  reportName: string;
  filters?: {
    minValue?: number;
    maxValue?: number;
    category?: string;
  };
}

interface ReportResult {
  reportName: string;
  reportId: string;
  datasetSize: number;
  filteredSize: number;
  stats: {
    mean: number;
    median: number;
    stdDev: number;
    min: number;
    max: number;
    p95: number;
    p99: number;
  };
  distribution: Record<string, number>;
  computeTimeMs: number;
  generatedAt: string;
}

function generateDataset(size: number, seed: number): number[] {
  // Deterministic pseudo-random number generator (mulberry32)
  let state = seed;
  const random = () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const data: number[] = [];
  for (let i = 0; i < size; i++) {
    // Mix of normal-ish distribution with some outliers
    const u1 = random();
    const u2 = random();
    const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const value = 50 + normal * 15; // mean=50, stddev=15
    data.push(Math.round(value * 100) / 100);
  }
  return data;
}

function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (idx - lower);
}

export const generateReport = task<ReportPayload, ReportResult>({
  id: "generate-report",
  run: async (payload) => {
    const { datasetSize, reportName, filters } = payload;
    const start = performance.now();

    console.log(
      `[report] Generating "${reportName}" with ${datasetSize} data points...`,
    );

    // Step 1: Generate dataset (CPU-bound)
    console.log(`[report] Step 1/4: Generating dataset...`);
    const seed = createHash("md5").update(reportName).digest().readUInt32LE(0);
    let data = generateDataset(datasetSize, seed);

    // Step 2: Apply filters
    console.log(`[report] Step 2/4: Applying filters...`);
    const originalSize = data.length;
    if (filters?.minValue != null) {
      data = data.filter((v) => v >= filters.minValue!);
    }
    if (filters?.maxValue != null) {
      data = data.filter((v) => v <= filters.maxValue!);
    }

    // Simulate processing time proportional to dataset
    const processingDelay = Math.min(datasetSize / 500, 5000);
    await new Promise((r) => setTimeout(r, processingDelay));

    // Step 3: Compute statistics
    console.log(`[report] Step 3/4: Computing statistics (${data.length} records)...`);
    const sorted = [...data].sort((a, b) => a - b);
    const sum = data.reduce((a, b) => a + b, 0);
    const mean = sum / data.length;
    const variance =
      data.reduce((acc, v) => acc + (v - mean) ** 2, 0) / data.length;
    const stdDev = Math.sqrt(variance);

    const stats = {
      mean: Math.round(mean * 100) / 100,
      median: Math.round(percentile(sorted, 50) * 100) / 100,
      stdDev: Math.round(stdDev * 100) / 100,
      min: sorted[0]!,
      max: sorted[sorted.length - 1]!,
      p95: Math.round(percentile(sorted, 95) * 100) / 100,
      p99: Math.round(percentile(sorted, 99) * 100) / 100,
    };

    // Step 4: Build distribution buckets
    console.log(`[report] Step 4/4: Building distribution...`);
    const bucketSize = 10;
    const distribution: Record<string, number> = {};
    for (const value of data) {
      const bucket = Math.floor(value / bucketSize) * bucketSize;
      const key = `${bucket}-${bucket + bucketSize}`;
      distribution[key] = (distribution[key] || 0) + 1;
    }

    const computeTimeMs = Math.round(performance.now() - start);
    const reportId = createHash("sha256")
      .update(`${reportName}-${Date.now()}`)
      .digest("hex")
      .slice(0, 12);

    console.log(
      `[report] "${reportName}" complete → mean=${stats.mean}, median=${stats.median}, p99=${stats.p99} (${computeTimeMs}ms)`,
    );

    return {
      reportName,
      reportId,
      datasetSize: originalSize,
      filteredSize: data.length,
      stats,
      distribution,
      computeTimeMs,
      generatedAt: new Date().toISOString(),
    };
  },
});
