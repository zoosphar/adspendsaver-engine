export interface BrowserDeviceCombo {
  browser: "chromium" | "firefox" | "webkit";
  device: "desktop" | "mobile";
  name: string;
  viewport: { width: number; height: number };
  userAgent?: string;
}

export interface FailureVerification {
  confirmed: boolean;
  reasoning: string;
  suggestedFix?: string;
}

export interface StepResult {
  stepIndex: number;
  action: string;
  locator: string;          // human-readable locator description, e.g. 'role=button[name="Add to Cart"]'
  description: string;
  success: boolean;
  errorMessage?: string;
  screenshotPath?: string;
  geminiVerification?: FailureVerification;
  durationMs: number;
}

export interface SimulationResult {
  flowType: string;
  comboName: string;
  browser: string;
  device: string;
  variantCombination?: string;  // e.g. "Red / M" — undefined if no variants
  overallSuccess: boolean;
  adParamsPreserved: boolean;
  steps: StepResult[];
  pageLoadTimeMs: number;
  consoleErrors: string[];
  evidenceUrls: string[];
  durationMs: number;
}
