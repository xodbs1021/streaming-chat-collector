import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:4010",
    trace: "on-first-retry"
  },
  webServer: {
    command: "pnpm preview",
    url: "http://127.0.0.1:4010/api/health",
    reuseExistingServer: true,
    timeout: 30_000
  },
  projects: [
    {
      name: "chromium-1080p",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 } }
    },
    {
      name: "chromium-720p",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } }
    }
  ]
});
