import { getPageUrlHash } from "../utils/url.js";

export const COLLECTIONS = {
  FLOW_CONFIGS: "flow_configs",
  RUNS: "runs",
  RESULTS: "results",
} as const;

export function flowConfigDocId(pageUrl: string): string {
  return `fc_${getPageUrlHash(pageUrl)}`;
}

export function runDocId(adId: string, timestamp?: number): string {
  const ts = timestamp ?? Date.now();
  return `run_${adId}_${ts}`;
}

export function resultDocId(adId: string, timestamp?: number): string {
  const ts = timestamp ?? Date.now();
  return `result_${adId}_${ts}`;
}
