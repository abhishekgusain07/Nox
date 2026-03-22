import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { Database } from "../db/index.js";
import type { Auth } from "../auth.js";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

const CreateProjectSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens"),
});

const CreateKeySchema = z.object({
  name: z.string().min(1).max(255),
  keyType: z.enum(["client", "server"]).default("client"),
  environment: z.enum(["dev", "staging", "prod"]).default("dev"),
});

export function createProjectRoutes(db: Database, auth: Auth) {
  const api = new Hono();

  // Helper: get user from session
  async function getSessionUser(c: { req: { raw: Request } }): Promise<{ id: string; email: string; name: string } | null> {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) return null;
    return { id: session.user.id, email: session.user.email, name: session.user.name };
  }

  // GET /api/auth/projects — list user's projects
  api.get("/projects", async (c) => {
    const user = await getSessionUser(c);
    if (!user) return c.json({ error: "Not authenticated" }, 401);

    const projects = await db.select().from(schema.projects)
      .where(eq(schema.projects.userId, user.id));

    return c.json({ projects });
  });

  // POST /api/auth/projects — create a project
  api.post("/projects", async (c) => {
    const user = await getSessionUser(c);
    if (!user) return c.json({ error: "Not authenticated" }, 401);

    const parseResult = CreateProjectSchema.safeParse(await c.req.json());
    if (!parseResult.success) {
      return c.json({ error: parseResult.error.format() }, 400);
    }
    const body = parseResult.data;

    const [project] = await db.insert(schema.projects)
      .values({
        userId: user.id,
        name: body.name,
        slug: body.slug,
      })
      .returning();

    if (!project) {
      return c.json({ error: "Failed to create project" }, 500);
    }

    // Auto-create a default server API key for the new project
    const secret = randomBytes(24).toString("base64url");
    const rawKey = `rl_dev_${secret}`;
    const keyHash = sha256(rawKey);
    const keyPrefix = rawKey.slice(0, 14);

    await db.insert(schema.apiKeys).values({
      projectId: project.id,
      name: "Default Server Key",
      keyHash,
      keyPrefix,
      keyType: "server",
      environment: "dev",
    });

    return c.json({
      project,
      apiKey: {
        key: rawKey,
        keyPrefix,
        keyType: "server",
        environment: "dev",
      },
    }, 201);
  });

  // GET /api/auth/projects/:id — get project details
  api.get("/projects/:id", async (c) => {
    const user = await getSessionUser(c);
    if (!user) return c.json({ error: "Not authenticated" }, 401);

    const projectId = c.req.param("id");
    const [project] = await db.select().from(schema.projects)
      .where(and(eq(schema.projects.id, projectId), eq(schema.projects.userId, user.id)))
      .limit(1);

    if (!project) return c.json({ error: "Project not found" }, 404);

    return c.json({ project });
  });

  // GET /api/auth/projects/:id/keys — list API keys for a project
  api.get("/projects/:id/keys", async (c) => {
    const user = await getSessionUser(c);
    if (!user) return c.json({ error: "Not authenticated" }, 401);

    const projectId = c.req.param("id");

    // Verify user owns this project
    const [project] = await db.select().from(schema.projects)
      .where(and(eq(schema.projects.id, projectId), eq(schema.projects.userId, user.id)))
      .limit(1);
    if (!project) return c.json({ error: "Project not found" }, 404);

    const keys = await db.select({
      id: schema.apiKeys.id,
      name: schema.apiKeys.name,
      keyPrefix: schema.apiKeys.keyPrefix,
      keyType: schema.apiKeys.keyType,
      environment: schema.apiKeys.environment,
      lastUsedAt: schema.apiKeys.lastUsedAt,
      expiresAt: schema.apiKeys.expiresAt,
      createdAt: schema.apiKeys.createdAt,
    }).from(schema.apiKeys)
      .where(eq(schema.apiKeys.projectId, projectId));

    return c.json({ keys });
  });

  // POST /api/auth/projects/:id/keys — create API key for a project
  api.post("/projects/:id/keys", async (c) => {
    const user = await getSessionUser(c);
    if (!user) return c.json({ error: "Not authenticated" }, 401);

    const projectId = c.req.param("id");

    // Verify user owns this project
    const [project] = await db.select().from(schema.projects)
      .where(and(eq(schema.projects.id, projectId), eq(schema.projects.userId, user.id)))
      .limit(1);
    if (!project) return c.json({ error: "Project not found" }, 404);

    const parseResult = CreateKeySchema.safeParse(await c.req.json());
    if (!parseResult.success) {
      return c.json({ error: parseResult.error.format() }, 400);
    }
    const body = parseResult.data;

    const secret = randomBytes(24).toString("base64url");
    const rawKey = `rl_${body.environment}_${secret}`;
    const keyHash = sha256(rawKey);
    const keyPrefix = rawKey.slice(0, 14);

    const [apiKey] = await db.insert(schema.apiKeys)
      .values({
        projectId,
        name: body.name,
        keyHash,
        keyPrefix,
        keyType: body.keyType,
        environment: body.environment,
      })
      .returning();

    if (!apiKey) return c.json({ error: "Failed to create key" }, 500);

    return c.json({
      id: apiKey.id,
      name: apiKey.name,
      key: rawKey,
      keyPrefix,
      keyType: apiKey.keyType,
      environment: apiKey.environment,
      createdAt: apiKey.createdAt,
    }, 201);
  });

  // DELETE /api/auth/projects/:id/keys/:keyId — revoke API key
  api.delete("/projects/:id/keys/:keyId", async (c) => {
    const user = await getSessionUser(c);
    if (!user) return c.json({ error: "Not authenticated" }, 401);

    const projectId = c.req.param("id");
    const keyId = c.req.param("keyId");

    // Verify user owns project
    const [project] = await db.select().from(schema.projects)
      .where(and(eq(schema.projects.id, projectId), eq(schema.projects.userId, user.id)))
      .limit(1);
    if (!project) return c.json({ error: "Project not found" }, 404);

    const deleted = await db.delete(schema.apiKeys)
      .where(and(eq(schema.apiKeys.id, keyId), eq(schema.apiKeys.projectId, projectId)))
      .returning();

    if (deleted.length === 0) return c.json({ error: "Key not found" }, 404);

    return c.json({ ok: true });
  });

  // GET /api/auth/me — get current user info from session
  api.get("/me", async (c) => {
    const user = await getSessionUser(c);
    if (!user) return c.json({ error: "Not authenticated" }, 401);
    return c.json({ user });
  });

  return api;
}
