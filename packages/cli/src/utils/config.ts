import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import * as esbuild from "esbuild";
import type { ReloadConfig } from "@reload-dev/sdk/config";

export function getApiKey(): string {
  const key = process.env.RELOAD_API_KEY;
  if (!key) {
    console.error("Error: RELOAD_API_KEY environment variable is not set.");
    console.error("Get one from your project dashboard: Settings → API Keys");
    process.exit(1);
  }
  return key;
}

export function getServerUrl(): string {
  return process.env.RELOAD_SERVER_URL ?? "http://localhost:3000";
}

export async function loadConfig(configPath: string): Promise<ReloadConfig> {
  const absPath = resolve(process.cwd(), configPath);
  if (!existsSync(absPath)) {
    console.error(`Error: Config file not found: ${absPath}`);
    console.error('Run "reload-dev init" to create one.');
    process.exit(1);
  }

  // Bundle the config file with esbuild (handles TS + imports)
  const tmpOut = resolve(process.cwd(), ".reload", "_config.mjs");
  await esbuild.build({
    entryPoints: [absPath],
    bundle: true,
    outfile: tmpOut,
    format: "esm",
    platform: "node",
    target: "node20",
    external: ["@reload-dev/sdk", "@reload-dev/sdk/*"],
  });

  const mod = await import(pathToFileURL(tmpOut).href);
  const config = mod.default as ReloadConfig;

  if (!config || !config.project || !config.dirs) {
    console.error("Error: Invalid reload.config.ts — must export default defineConfig({ project, dirs })");
    process.exit(1);
  }

  return config;
}
