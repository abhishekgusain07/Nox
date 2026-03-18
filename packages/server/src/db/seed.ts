import { eq, sql } from "drizzle-orm";
import { createDb, schema } from "./index.js";
import { createHash, randomBytes, scryptSync } from "node:crypto";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://reload:reload@localhost:5432/reload";

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

async function seed() {
  const db = createDb(DATABASE_URL);

  console.log("[seed] Starting seed...");

  // 1. Create default user (better-auth compatible)
  const userId = crypto.randomUUID();
  const [existingUser] = await db.select().from(schema.users)
    .where(eq(schema.users.email, "admin@reload.dev")).limit(1);

  const finalUserId = existingUser?.id ?? userId;

  if (!existingUser) {
    await db.insert(schema.users).values({
      id: userId,
      name: "Default Admin",
      email: "admin@reload.dev",
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create account entry (better-auth stores password here)
    await db.insert(schema.accounts).values({
      id: crypto.randomUUID(),
      userId,
      accountId: userId,
      providerId: "credential",
      password: hashPassword("changeme123"),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    console.log(`[seed] Created user: ${userId} (admin@reload.dev)`);
  } else {
    console.log(`[seed] User already exists: ${finalUserId}`);
  }

  // 2. Create default project
  const [existingProject] = await db.select().from(schema.projects)
    .where(eq(schema.projects.slug, "default")).limit(1);

  let projectId: string;

  if (!existingProject) {
    const [project] = await db.insert(schema.projects).values({
      userId: finalUserId,
      name: "Default Project",
      slug: "default",
    }).returning();
    projectId = project!.id;
    console.log(`[seed] Created project: ${projectId}`);
  } else {
    projectId = existingProject.id;
    console.log(`[seed] Project already exists: ${projectId}`);
  }

  // 3. Create default API key
  const keySecret = randomBytes(24).toString("base64url");
  const rawKey = `rl_dev_${keySecret}`;
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  const keyPrefix = rawKey.slice(0, 14);

  const [existingKey] = await db.select().from(schema.apiKeys)
    .where(eq(schema.apiKeys.projectId, projectId)).limit(1);

  if (!existingKey) {
    await db.insert(schema.apiKeys).values({
      projectId,
      name: "Default Server Key",
      keyHash,
      keyPrefix,
      keyType: "server",
      environment: "dev",
    });

    console.log(`[seed] API key: ${rawKey}`);
    console.log("[seed] ^^^ SAVE THIS KEY — it will not be shown again ^^^");
  } else {
    console.log(`[seed] API key already exists for project`);
  }

  // 4. Backfill projectId on existing tables (chunked)
  const tablesToBackfill = [
    { table: schema.queues, name: "queues" },
    { table: schema.tasks, name: "tasks" },
    { table: schema.runs, name: "runs" },
    { table: schema.workers, name: "workers" },
    { table: schema.runEvents, name: "run_events" },
    { table: schema.runSteps, name: "run_steps" },
    { table: schema.waitpoints, name: "waitpoints" },
  ];

  for (const { table, name } of tablesToBackfill) {
    try {
      const result = await db.execute(
        sql`UPDATE ${table} SET project_id = ${projectId} WHERE project_id IS NULL`
      );
      const count = typeof result === "object" && result !== null && "rowCount" in result
        ? (result as { rowCount: number }).rowCount
        : 0;
      if (count > 0) {
        console.log(`[seed] Backfilled ${count} rows in ${name}`);
      }
    } catch {
      // Table might not have null project_ids
    }
  }

  console.log("[seed] Done!");
  process.exit(0);
}

seed().catch((err) => {
  console.error("[seed] Failed:", err);
  process.exit(1);
});
