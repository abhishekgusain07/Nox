// packages/sdk/dist/config.js
function defineConfig(config) {
  return config;
}

// reload.config.ts
var reload_config_default = defineConfig({
  project: "reload-dev",
  dirs: ["./tasks"]
});
export {
  reload_config_default as default
};
