const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results-characterization",
  timeout: 45_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
