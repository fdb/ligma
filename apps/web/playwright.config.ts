import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://localhost:5173",
  },
  webServer: [
    {
      command: "npm run dev:e2e --prefix ../worker",
      url: "http://127.0.0.1:8787/api/health",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "npm run dev",
      url: "http://localhost:5173",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
