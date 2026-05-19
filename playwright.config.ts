import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.SPOOL_E2E_PORT ?? "4318");
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./packages/server/src/e2e",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "node --import tsx/esm packages/server/src/e2e/serve-fixture.ts",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      SPOOL_E2E_PORT: String(PORT),
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
