import type { BrowserDeviceCombo } from "../types/index.js";

export const BROWSER_DEVICE_COMBOS: BrowserDeviceCombo[] = [
  {
    browser: "chromium",
    device: "desktop",
    name: "Chrome Desktop",
    viewport: { width: 1920, height: 1080 },
  },
  {
    browser: "chromium",
    device: "mobile",
    name: "Chrome Android",
    viewport: { width: 390, height: 844 },
    userAgent:
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  },
  {
    browser: "firefox",
    device: "desktop",
    name: "Firefox Desktop",
    viewport: { width: 1920, height: 1080 },
  },
  {
    browser: "firefox",
    device: "mobile",
    name: "Firefox Android",
    viewport: { width: 390, height: 844 },
    userAgent:
      "Mozilla/5.0 (Android 13; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0",
  },
  {
    browser: "webkit",
    device: "desktop",
    name: "Safari Desktop",
    viewport: { width: 1920, height: 1080 },
  },
  {
    browser: "webkit",
    device: "mobile",
    name: "Safari iOS",
    viewport: { width: 390, height: 844 },
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
];
