import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Database } from "./db/index.js";

export function createAuth(db: Database) {
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      usePlural: true,
    }),
    secret: process.env.BETTER_AUTH_SECRET ?? "dev-secret-change-in-production-min-32-chars",
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
    basePath: "/api/auth",
    emailAndPassword: {
      enabled: true,
    },
    session: {
      expiresIn: 7 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60,
      },
    },
    trustedOrigins: [
      process.env.DASHBOARD_URL ?? "http://localhost:3001",
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
