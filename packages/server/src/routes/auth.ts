import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getAuthContext } from "../middleware/auth.js";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

const CreateKeySchema = z.object({
  name: z.string().min(1).max(255),
  keyType: z.enum(["client", "server"]).default("client"),
  environment: z.enum(["dev", "staging", "prod"]).default("dev"),
  expiresAt: z.string().datetime().optional(),
});

export function createAuthRoutes(db: Database) {
  const api = new Hono();

  // POST /api/keys — generate new API key
  api.post("/keys", async (c) => {
    const { projectId } = getAuthContext(c);

    const parseResult = CreateKeySchema.safeParse(await c.req.json());
    if (!parseResult.success) {
      return c.json({ error: parseResult.error.format() }, 400);
    }
    const body = parseResult.data;

    // Generate the raw key
    const secret = randomBytes(24).toString("base64url");
    const rawKey = `rl_${body.environment}_${secret}`;
    const keyHash = sha256(rawKey);
    const keyPrefix = rawKey.slice(0, 14);

    const [apiKey] = await db
      .insert(schema.apiKeys)
      .values({
        projectId,
        name: body.name,
        keyHash,
        keyPrefix,
        keyType: body.keyType,
        environment: body.environment,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      })
      .returning();

    if (!apiKey) {
      return c.json({ error: "Failed to create API key" }, 500);
    }

    // Return the raw key ONCE — it will never be shown again
    return c.json({
      id: apiKey.id,
      name: apiKey.name,
      key: rawKey,
      keyPrefix,
      keyType: apiKey.keyType,
      environment: apiKey.environment,
      expiresAt: apiKey.expiresAt,
      createdAt: apiKey.createdAt,
    }, 201);
  });

  // GET /api/keys — list keys for current project (prefix only, never raw)
  api.get("/keys", async (c) => {
    const { projectId } = getAuthContext(c);

    const keys = await db
      .select({
        id: schema.apiKeys.id,
        name: schema.apiKeys.name,
        keyPrefix: schema.apiKeys.keyPrefix,
        keyType: schema.apiKeys.keyType,
        environment: schema.apiKeys.environment,
        lastUsedAt: schema.apiKeys.lastUsedAt,
        expiresAt: schema.apiKeys.expiresAt,
        createdAt: schema.apiKeys.createdAt,
      })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.projectId, projectId));

    return c.json({ keys });
  });

  // DELETE /api/keys/:keyId — revoke a key
  api.delete("/keys/:keyId", async (c) => {
    const { projectId } = getAuthContext(c);
    const keyId = c.req.param("keyId");

    const deleted = await db
      .delete(schema.apiKeys)
      .where(and(
        eq(schema.apiKeys.id, keyId),
        eq(schema.apiKeys.projectId, projectId),
      ))
      .returning();

    if (deleted.length === 0) {
      return c.json({ error: "Key not found" }, 404);
    }

    return c.json({ ok: true });
  });

  return api;
}
