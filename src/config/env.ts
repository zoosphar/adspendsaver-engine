function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

function optionalInt(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got: ${value}`);
  }
  return parsed;
}

export const env = {
  get ANTHROPIC_API_KEY() { return required("ANTHROPIC_API_KEY"); },
  get GEMINI_API_KEY() { return required("GEMINI_API_KEY"); },
  get FIREBASE_SERVICE_ACCOUNT_JSON() {
    // Supports either inline JSON or a file path
    const value = required("FIREBASE_SERVICE_ACCOUNT_JSON");
    if (value.startsWith("{")) return value;
    // Treat as file path
    const fs = require("fs");
    return fs.readFileSync(value, "utf-8");
  },
  get FIREBASE_STORAGE_BUCKET() { return required("FIREBASE_STORAGE_BUCKET"); },

  get PORT() { return optionalInt("PORT", 3000); },
  get EXPLORATION_MODEL() { return optional("EXPLORATION_MODEL", "claude-sonnet-4-6"); },
  get SUMMARY_MODEL() { return optional("SUMMARY_MODEL", "claude-haiku-4-5-20251001"); },
  get GEMINI_MODEL() { return optional("GEMINI_MODEL", "gemini-2.5-flash"); },
  get MAX_SANITY_RETRIES() { return optionalInt("MAX_SANITY_RETRIES", 3); },
  get STAGE_TIMEOUT_MS() { return optionalInt("STAGE_TIMEOUT_MS", 300_000); },
  get PIPELINE_TIMEOUT_MS() { return optionalInt("PIPELINE_TIMEOUT_MS", 900_000); },
  get HUMAN_DELAY_MIN_MS() { return optionalInt("HUMAN_DELAY_MIN_MS", 500); },
  get HUMAN_DELAY_MAX_MS() { return optionalInt("HUMAN_DELAY_MAX_MS", 2000); },
  get MAX_SWEEP_COMBINATIONS() { return optionalInt("MAX_SWEEP_COMBINATIONS", 500); },
} as const;
