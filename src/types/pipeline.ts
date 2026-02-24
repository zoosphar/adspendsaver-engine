import type { FlowConfig } from "./flow-config.js";
import type { SimulationResult } from "./simulation.js";
import type { AdditionalChecks } from "./checks.js";
import type { VariantSweepResult } from "./variant-sweep.js";

export interface PipelineInput {
  prompt: string;
  clientWebsite: string;
  enableEvidence?: boolean;
  adId: string;
  adProvider?: string;
  pageUrl: string;
}

export interface LLMSummary {
  overallStatus: "pass" | "fail" | "partial";
  findings: string[];
  recommendedActions: string[];
  severity: "critical" | "high" | "medium" | "low" | "none";
  rawSummary: string;
}

export interface PipelineOutput {
  success: boolean;
  adId: string;
  pageUrl: string;
  flowConfigs: FlowConfig[];
  simulationResults: SimulationResult[];
  additionalChecks: AdditionalChecks | null;
  variantSweep: VariantSweepResult | null;
  summary: LLMSummary | null;
  errors: string[];
  evidenceUrls: string[];
  durationMs: number;
}

export interface PipelineState {
  input: PipelineInput;
  flowConfigs: FlowConfig[];
  simulationResults: SimulationResult[];
  additionalChecks: AdditionalChecks | null;
  variantSweep: VariantSweepResult | null;
  summary: LLMSummary | null;
  errors: string[];
  evidenceUrls: string[];
  startedAt: number;
}

export interface StageResult<T> {
  success: boolean;
  data: T | null;
  error?: string;
  durationMs: number;
}
