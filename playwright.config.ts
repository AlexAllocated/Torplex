import { defineConfig } from "@playwright/test";

const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const firefoxPath = process.env.PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH;

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: chromiumPath ? { executablePath: chromiumPath } : {},
      },
    },
    ...(firefoxPath
      ? [{
          name: "firefox",
          use: {
            browserName: "firefox" as const,
            launchOptions: { executablePath: firefoxPath },
          },
        }]
      : []),
  ],
});
