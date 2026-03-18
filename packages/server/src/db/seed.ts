import { eq, isNull, sql } from "drizzle-orm";
import { createDb, schema } from "./index.js";
import { createHash, randomBytes } from "node:crypto";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://reload:reload@localhost:5432/reload";

async function seed() {
  const db = createDb(DATABASE_URL);

  console.log("[seed] Starting multi-tenancy backfill...");

  // 1. Create default user (idempotent)
  const [defaultUser] = await db
    .insert(schema.users)
    .values({
      email: "admin@reload.dev",
      name: "Default Admin",
      passwordHash: createHash("sha256").update("changeme").digest("hex"),
    })
    .onConflictDoNothing({ target: schema.users.email })
    .returning();

  const userId = defaultUser?.id ?? (
    await db.select({ id: schema.users.id }).from(schema.users)
      .where(eq(schema.users.email, "admin@reload.dev")).limit(1)
  )[0]!.id;

  console.log(`[seed] Default user: ${userId}`);

  // 2. Create default project (idempotent)
  const [defaultProject] = await db
    .insert(schema.projects)
    .values({
      userId,
      name: "Default Project",
      slug: "default",
    })
    .onConflictDoNothing()
    .returning();

  const projectId = defaultProject?.id ?? (
    await db.select({ id: schema.projects.id }).from(schema.projects)
      .where(eq(schema.projects.slug, "default")).limit(1)
  )[0]!.id;

  console.log(`[seed] Default project: ${projectId}`);

  // 3. Create a default API key for the project
  const keySecret = randomBytes(24).toString("base64url");
  const rawKey = `rl_dev_${keySecret}`;
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  const keyPrefix = rawKey.slice(0, 12);

  await db
    .insert(schema.apiKeys)
    .values({
      projectId,
      name: "Default Dev Key",
      keyHash,
      keyPrefix,
      keyType: "server",
      environment: "dev",
    })
    .onConflictDoNothing({ target: schema.apiKeys.keyHash });

  console.log(`[seed] Default API key: ${rawKey}`);
  console.log("[seed] ^^^ SAVE THIS KEY — it will not be shown again ^^^");

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
    let updated = 0;
    let batch: number;
    do {
      const result = await db.execute(
        sql`UPDATE ${table} SET project_id = ${projectId} WHERE project_id IS NULL LIMIT 1000`
      );
      batch = (result as any).count ?? (result as any).rowCount ?? 0;
      updated += batch;
      if (batch > 0) {
        console.log(`[seed] Backfilled ${updated} rows in ${name}...`);
      }
    } while (batch > 0);

    if (updated > 0) {
      console.log(`[seed] ${name}: ${updated} rows backfilled`);
    } else {
      console.log(`[seed] ${name}: no rows to backfill`);
    }
  }

  console.log("[seed] Backfill complete!");
  process.exit(0);
}

seed().catch((err) => {
  console.error("[seed] Failed:", err);
  process.exit(1);
});
