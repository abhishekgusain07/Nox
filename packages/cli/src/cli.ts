#!/usr/bin/env node
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { deployCommand } from "./commands/deploy.js";
import { devCommand } from "./commands/dev.js";
import { whoamiCommand } from "./commands/whoami.js";

const program = new Command()
  .name("reload-dev")
  .description("reload.dev CLI — deploy and manage your task queue")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize a reload.dev project with config and example task")
  .action(initCommand);

program
  .command("deploy")
  .description("Bundle tasks and deploy to the server")
  .option("--config <path>", "Path to reload.config.ts", "reload.config.ts")
  .option("--dry-run", "Bundle without uploading")
  .action(deployCommand);

program
  .command("dev")
  .description("Start local worker with file watching (no bundling)")
  .option("--config <path>", "Path to reload.config.ts", "reload.config.ts")
  .action(devCommand);

program
  .command("whoami")
  .description("Show current project from API key")
  .action(whoamiCommand);

program.parse();
