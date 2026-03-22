export interface ReloadConfig {
  project: string;
  dirs: string[];
  runtime?: "node";
  logLevel?: "debug" | "info" | "warn" | "error";
  retries?: {
    enabledInDev?: boolean;
    default?: {
      maxAttempts?: number;
      factor?: number;
      minTimeoutInMs?: number;
      maxTimeoutInMs?: number;
    };
  };
}

export function defineConfig(config: ReloadConfig): ReloadConfig {
  return config;
}
