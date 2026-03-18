import { createHash } from "node:crypto";
import type { Context, Next } from "hono";
import { eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { schema } from "../db/index.js";

export interface AuthContext {
  projectId: string;
  apiKeyId: string;
  keyType: "client" | "server";
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function createAuthMiddleware(db: Database) {
  return async function apiKeyAuth(c: Context, next: Next) {
    const header = c.req.header("authorization");
    if (!header?.startsWith("Bearer ")) {
      return c.json({ error: "Missing or invalid Authorization header. Expected: Bearer <api-key>" }, 401);
    }

    const keyRaw = header.slice(7);
    if (!keyRaw || keyRaw.length < 10) {
      return c.json({ error: "Invalid API key format" }, 401);
    }

    const keyHash = sha256(keyRaw);

    const rows = await db.select().from(schema.apiKeys)
      .where(eq(schema.apiKeys.keyHash, keyHash))
      .limit(1);

    const apiKey = rows[0];
    if (!apiKey) {
      return c.json({ error: "Invalid API key" }, 401);
    }

    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      return c.json({ error: "API key has expired" }, 401);
    }

    // Update lastUsedAt (fire and forget — don't block the request)
    db.update(schema.apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.apiKeys.id, apiKey.id))
      .then(() => {})
      .catch(() => {});

    c.set("projectId", apiKey.projectId);
    c.set("apiKeyId", apiKey.id);
    c.set("keyType", apiKey.keyType);

    await next();
  };
}

/** Require that the API key is a "server" type (for worker-only endpoints) */
export function requireServerKey() {
  return async function (c: Context, next: Next) {
    const keyType = c.get("keyType") as string;
    if (keyType !== "server") {
      return c.json({ error: "This endpoint requires a server API key" }, 403);
    }
    await next();
  };
}

/** Type-safe helper to get auth context from Hono context */
export function getAuthContext(c: Context): AuthContext {
  return {
    projectId: c.get("projectId") as string,
    apiKeyId: c.get("apiKeyId") as string,
    keyType: c.get("keyType") as "client" | "server",
  };
}
