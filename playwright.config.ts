import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
    launchOptions: {
      executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
      // Locale UTF-8 : sans elle, Chromium remplace les noms de téléchargement accentués par « download ».
      env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } as Record<string, string>,
    },
  },
  webServer: {
    command: 'npx vite preview --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
