import { defineConfig, devices } from '@playwright/test';

const PORT = 5174;
// Lets machines with a preinstalled Chromium reuse it instead of downloading one.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}/treasury-dashboard/`,
    trace: 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/treasury-dashboard/`,
    // Emulator mode; HMR off so network emulation never triggers a dev-server reload.
    env: { VITE_USE_FIREBASE_EMULATORS: 'true', E2E_NO_HMR: '1' },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
