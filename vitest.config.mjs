import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          SESSION_SECRET: "local-test-session-secret-never-use-in-production",
          CODE_PEPPER: "local-test-code-pepper-never-use-in-production",
          BOOTSTRAP_ADMIN_KEY: "local-test-bootstrap-key-never-use-in-production"
        }
      }
    })
  ],
  test: {
    include: ["tests/cloudflare/**/*.test.js"],
    testTimeout: 15000,
    hookTimeout: 15000
  }
});
