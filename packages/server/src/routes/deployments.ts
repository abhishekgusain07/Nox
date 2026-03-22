import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getAuthContext } from "../middleware/auth.js";

interface ManifestTask {
  id: string;
  queue: string | undefined;
  retry: Record<string, unknown> | undefined;
  exportName: string;
}

const CreateDeploymentSchema = z.object({
  version: z.string().min(1),
  bundleHash: z.string().min(1),
  manifest: z.object({
    tasks: z.array(z.object({
      id: z.string().min(1),
      queue: z.string().optional(),
      retry: z.record(z.unknown()).optional(),
      exportName: z.string().min(1),
    })),
  }),
  bundle: z.string().min(1),
});

const BUNDLES_DIR = resolve(process.cwd(), "data", "bundles");

export function createDeploymentRoutes(db: Database) {
  const api = new Hono();

  // POST /api/deployments — upload a new deployment
  api.post("/deployments", async (c) => {
    const { projectId } = getAuthContext(c);

    const parseResult = CreateDeploymentSchema.safeParse(await c.req.json());
    if (!parseResult.success) {
      return c.json({ error: parseResult.error.format() }, 400);
    }
    const body = parseResult.data;

    // Store bundle to filesystem
    const bundleDir = resolve(BUNDLES_DIR, projectId, body.bundleHash);
    mkdirSync(bundleDir, { recursive: true });

    const bundleBuffer = Buffer.from(body.bundle, "base64");
    const bundlePath = resolve(bundleDir, "bundle.js");
    writeFileSync(bundlePath, new Uint8Array(bundleBuffer));

    // Create deployment record
    const [deployment] = await db.insert(schema.deployments)
      .values({
        projectId,
        version: body.version,
        bundleHash: body.bundleHash,
        bundlePath,
        manifest: body.manifest,
        status: "STAGED",
      })
      .returning();

    if (!deployment) {
      return c.json({ error: "Failed to create deployment" }, 500);
    }

    return c.json({
      deploymentId: deployment.id,
      version: deployment.version,
      status: deployment.status,
    }, 201);
  });

  // GET /api/deployments — list deployments for project
  api.get("/deployments", async (c) => {
    const { projectId } = getAuthContext(c);

    const deploys = await db.select({
      id: schema.deployments.id,
      version: schema.deployments.version,
      status: schema.deployments.status,
      manifest: schema.deployments.manifest,
      createdAt: schema.deployments.createdAt,
      activatedAt: schema.deployments.activatedAt,
    })
      .from(schema.deployments)
      .where(eq(schema.deployments.projectId, projectId))
      .orderBy(desc(schema.deployments.createdAt));

    return c.json({ deployments: deploys });
  });

  // GET /api/deployments/active — get currently active deployment
  api.get("/deployments/active", async (c) => {
    const { projectId } = getAuthContext(c);

    const [active] = await db.select()
      .from(schema.deployments)
      .where(and(
        eq(schema.deployments.projectId, projectId),
        eq(schema.deployments.status, "ACTIVE"),
      ))
      .limit(1);

    if (!active) {
      return c.json({ error: "No active deployment" }, 404);
    }

    return c.json({
      id: active.id,
      version: active.version,
      bundleHash: active.bundleHash,
      manifest: active.manifest,
      activatedAt: active.activatedAt,
    });
  });

  // POST /api/deployments/:id/activate — activate a staged deployment
  api.post("/deployments/:id/activate", async (c) => {
    const { projectId } = getAuthContext(c);
    const deploymentId = c.req.param("id");

    // Find the deployment
    const [deployment] = await db.select()
      .from(schema.deployments)
      .where(and(
        eq(schema.deployments.id, deploymentId),
        eq(schema.deployments.projectId, projectId),
      ))
      .limit(1);

    if (!deployment) {
      return c.json({ error: "Deployment not found" }, 404);
    }

    if (deployment.status !== "STAGED") {
      return c.json({ error: `Cannot activate deployment in ${deployment.status} status` }, 409);
    }

    // Supersede any currently active deployment
    await db.update(schema.deployments)
      .set({ status: "SUPERSEDED" })
      .where(and(
        eq(schema.deployments.projectId, projectId),
        eq(schema.deployments.status, "ACTIVE"),
      ));

    // Activate the new deployment
    const now = new Date();
    await db.update(schema.deployments)
      .set({ status: "ACTIVE", activatedAt: now })
      .where(eq(schema.deployments.id, deploymentId));

    // Upsert tasks from manifest
    const manifest = deployment.manifest as { tasks: ManifestTask[] };
    for (const task of manifest.tasks) {
      const queueId = task.queue ?? "default";

      // Auto-create queue if needed
      await db.insert(schema.queues)
        .values({ id: queueId, projectId })
        .onConflictDoNothing();

      // Upsert task
      await db.insert(schema.tasks)
        .values({
          id: task.id,
          projectId,
          queueId,
          retryConfig: task.retry ?? null,
        })
        .onConflictDoUpdate({
          target: schema.tasks.id,
          set: {
            queueId,
            retryConfig: task.retry ?? null,
          },
        });
    }

    return c.json({ ok: true, activatedAt: now.toISOString() });
  });

  // GET /api/deployments/:id/bundle — download the bundle file
  api.get("/deployments/:id/bundle", async (c) => {
    const { projectId } = getAuthContext(c);
    const deploymentId = c.req.param("id");

    const [deployment] = await db.select()
      .from(schema.deployments)
      .where(and(
        eq(schema.deployments.id, deploymentId),
        eq(schema.deployments.projectId, projectId),
      ))
      .limit(1);

    if (!deployment) {
      return c.json({ error: "Deployment not found" }, 404);
    }

    if (!existsSync(deployment.bundlePath)) {
      return c.json({ error: "Bundle file not found on disk" }, 404);
    }

    const bundle = readFileSync(deployment.bundlePath);
    return new Response(new Uint8Array(bundle), {
      headers: {
        "Content-Type": "application/javascript",
        "Content-Length": bundle.length.toString(),
        "X-Bundle-Hash": deployment.bundleHash,
      },
    });
  });

  // GET /api/deployments/:id/status — deployment rollout status
  api.get("/deployments/:id/status", async (c) => {
    const { projectId } = getAuthContext(c);
    const deploymentId = c.req.param("id");

    const [deployment] = await db.select({
      id: schema.deployments.id,
      version: schema.deployments.version,
      status: schema.deployments.status,
      activatedAt: schema.deployments.activatedAt,
    })
      .from(schema.deployments)
      .where(and(
        eq(schema.deployments.id, deploymentId),
        eq(schema.deployments.projectId, projectId),
      ))
      .limit(1);

    if (!deployment) {
      return c.json({ error: "Deployment not found" }, 404);
    }

    // Count workers that have this deployment's tasks loaded
    const allWorkers = await db.select({
      id: schema.workers.id,
      status: schema.workers.status,
      lastHeartbeat: schema.workers.lastHeartbeat,
    })
      .from(schema.workers)
      .where(eq(schema.workers.projectId, projectId));

    const onlineWorkers = allWorkers.filter((w) => w.status === "online");
    const recentThreshold = new Date(Date.now() - 60_000); // active in last 60s
    const activeWorkers = onlineWorkers.filter((w) => w.lastHeartbeat > recentThreshold);

    return c.json({
      deployment: {
        id: deployment.id,
        version: deployment.version,
        status: deployment.status,
        activatedAt: deployment.activatedAt,
      },
      workers: {
        total: allWorkers.length,
        online: onlineWorkers.length,
        active: activeWorkers.length,
      },
    });
  });

  return api;
}
