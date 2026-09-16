import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/ui",
  outputDir: "artifacts/ui-review/results",
  reporter: [["list"], ["html", { outputFolder: "artifacts/ui-review/report", open: "never" }]],
  use: {
    browserName: "chromium", baseURL: "http://127.0.0.1:1422",
    locale: "en-US", timezoneId: "UTC", colorScheme: "dark",
    reducedMotion: "reduce", deviceScaleFactor: 1,
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
    { name: "narrow", use: { viewport: { width: 412, height: 915 } } },
  ],
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 1422 --strictPort",
    url: "http://127.0.0.1:1422/tests/ui/", reuseExistingServer: false,
  },
});
