import Anthropic from "@anthropic-ai/sdk";
import type {
  PipelineInput,
  PipelineOutput,
  PipelineState,
  LLMSummary,
  FlowConfig,
} from "./types/index.js";
import { generateVariantCombinations } from "./engine/executor.js";
import { executeStage1, type Stage1Result } from "./stages/stage1-extract.js";
import { executeStage2 } from "./stages/stage2-sanity.js";
import { executeStage3 } from "./stages/stage3-execute.js";
import { executeStage3B, generateAllCombinations } from "./stages/stage3b-variant-sweep.js";
import { getFlowConfig } from "./firebase/firestore.js";
import * as firestoreOps from "./firebase/firestore.js";
import { buildSummaryPrompt } from "./mcp/prompts.js";
import { env } from "./config/env.js";
import { logger } from "./utils/logger.js";

function extractJsonFromText(text: string): string | null {
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) return jsonMatch[0];
  return null;
}

async function generateSummary(
  state: PipelineState
): Promise<LLMSummary | null> {
  try {
    const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 5 });
    const prompt = buildSummaryPrompt(
      state.simulationResults,
      state.additionalChecks,
      state.input,
      state.variantSweep
    );

    const response = await anthropic.messages.create({
      model: env.SUMMARY_MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });

    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === "text"
    );
    if (!textBlock) return null;

    const jsonStr = extractJsonFromText(textBlock.text);
    if (!jsonStr) return null;

    return JSON.parse(jsonStr) as LLMSummary;
  } catch (err) {
    logger.error("Summary generation failed", { error: String(err) });
    return null;
  }
}

function buildOutput(state: PipelineState): PipelineOutput {
  return {
    success: state.errors.length === 0 && state.flowConfigs.length > 0,
    adId: state.input.adId,
    pageUrl: state.input.pageUrl,
    flowConfigs: state.flowConfigs,
    simulationResults: state.simulationResults,
    additionalChecks: state.additionalChecks,
    variantSweep: state.variantSweep,
    summary: state.summary,
    errors: state.errors,
    evidenceUrls: state.evidenceUrls,
    durationMs: Date.now() - state.startedAt,
  };
}

/**
 * Stage 1 → Stage 2 loop: extract FlowConfig, then sanity-check locators.
 * If sanity check fails, re-run Stage 1 with feedback describing missing locators.
 * Returns a validated FlowConfig or null after all retries exhausted.
 */
async function extractAndValidateConfig(
  input: PipelineInput
): Promise<FlowConfig | null> {
  const maxRetries = env.MAX_SANITY_RETRIES;
  let feedback: string | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    logger.info("Stage 1→2 loop", { attempt, maxRetries, hasFeedback: !!feedback });

    // Stage 1: Extract flow config (returns browser page for reuse)
    const stage1Result: Stage1Result = await executeStage1(input, feedback);
    if (!stage1Result.success || !stage1Result.data) {
      logger.error("Stage 1 failed", {
        attempt,
        error: stage1Result.error,
      });
      // Stage 1 has its own internal retries; if it still fails, no point retrying
      return null;
    }

    const config = stage1Result.data;

    logger.info("Stage 1 produced config, running Stage 2 sanity check", {
      attempt,
      steps: config.steps.length,
      variantGroups: config.variants?.length ?? 0,
    });

    // Stage 2: Sanity check — reuse Stage 1's browser page to avoid relaunch
    const stage2Result = await executeStage2(config, input.pageUrl, stage1Result.page);

    // Clean up Stage 1's browser now that Stage 2 is done
    await stage1Result.cleanup?.();

    if (!stage2Result.success || !stage2Result.data) {
      logger.error("Stage 2 failed to run", {
        attempt,
        error: stage2Result.error,
      });
      // Stage 2 infrastructure failure — retry from Stage 1
      feedback = `Stage 2 sanity check could not run: ${stage2Result.error}. Please produce a simpler, more robust config.`;
      continue;
    }

    const sanity = stage2Result.data;

    if (sanity.allFound) {
      logger.info("Stage 2: All locators verified", { attempt });
      return config;
    }

    // Sanity check failed — feed missing locators back to Stage 1
    const totalMissing = sanity.phaseResults.reduce((sum, pr) => sum + pr.missingChecks.length, 0);
    const failedTransitions = sanity.phaseResults.filter((pr) => !pr.transitionSuccess).length;
    logger.warn("Stage 2: Locators missing, retrying Stage 1 with feedback", {
      attempt,
      totalMissing,
      failedTransitions,
      phases: sanity.phaseResults.map((pr) => ({
        phase: pr.phase,
        transitionSuccess: pr.transitionSuccess,
        missingCount: pr.missingChecks.length,
      })),
    });

    feedback = sanity.feedback;
  }

  logger.error("Stage 1→2 loop exhausted all retries", { maxRetries });
  return null;
}

export async function runPipeline(
  input: PipelineInput
): Promise<PipelineOutput> {
  const state: PipelineState = {
    input,
    flowConfigs: [],
    simulationResults: [],
    additionalChecks: null,
    variantSweep: null,
    summary: null,
    errors: [],
    evidenceUrls: [],
    startedAt: Date.now(),
  };

  logger.info("Pipeline started", {
    adId: input.adId,
    pageUrl: input.pageUrl,
  });

  // Create Firestore run document
  let runDocId: string | undefined;
  try {
    runDocId = await firestoreOps.createRun(input, state.startedAt);
  } catch (err) {
    logger.warn("Failed to create run document", { error: String(err) });
  }

  try {
    // Stage 1 → Stage 2 loop: extract + validate
    const validatedConfig = await extractAndValidateConfig(input);

    if (!validatedConfig) {
      state.errors.push("Stage 1→2 failed: could not produce a validated FlowConfig");
    }

    // Stage 3: Execute across browser combos
    if (validatedConfig) {
      state.flowConfigs.push(validatedConfig);

      // Log variant combinations that will be tested
      if (validatedConfig.variants && validatedConfig.variants.length > 0) {
        const combos = generateVariantCombinations(validatedConfig.variants);
        logger.info("Variant combinations generated", {
          totalCombinations: combos.length,
          combinations: combos.map((c) => c.label),
        });
      } else {
        logger.info("No variants found, will run single flow");
      }

      // Brief cooldown before Stage 3 to let resources settle
      logger.info("Cooldown before Stage 3", { delayMs: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    for (const flowConfig of state.flowConfigs) {
      const stage3Result = await executeStage3(flowConfig, input);
      if (stage3Result.success && stage3Result.data) {
        state.simulationResults.push(...stage3Result.data.simulationResults);
        if (!state.additionalChecks) {
          state.additionalChecks = stage3Result.data.additionalChecks;
        }
        state.evidenceUrls.push(...stage3Result.data.evidenceUrls);
      } else {
        state.errors.push(
          `Stage 3 failed for ${flowConfig.flow_type}: ${stage3Result.error ?? "unknown error"}`
        );
      }
    }

    // Stage 3B: Variant Health Sweep (runs after Stage 3 if multiple variant combos exist)
    if (validatedConfig?.variants && validatedConfig.variants.length > 0) {
      const allCombos = generateAllCombinations(validatedConfig.variants);
      if (allCombos.length > 1) {
        logger.info("Stage 3B: Starting variant health sweep", {
          totalCombinations: allCombos.length,
        });
        const stage3bResult = await executeStage3B(validatedConfig, input);
        if (stage3bResult.success && stage3bResult.data) {
          state.variantSweep = stage3bResult.data;
        } else if (stage3bResult.error) {
          logger.warn("Stage 3B failed", { error: stage3bResult.error });
        }
      }
    }

    // LLM Summary
    if (state.simulationResults.length > 0) {
      state.summary = await generateSummary(state);
    }

    const output = buildOutput(state);

    // Save result to Firestore
    try {
      await firestoreOps.saveResult(output, state.startedAt);
    } catch (err) {
      logger.warn("Failed to save result", { error: String(err) });
    }

    // Update run status
    if (runDocId) {
      try {
        await firestoreOps.updateRunStatus(
          runDocId,
          output.success ? "completed" : "failed",
          output.durationMs
        );
      } catch (err) {
        logger.warn("Failed to update run status", { error: String(err) });
      }
    }

    logger.info("Pipeline completed", {
      success: output.success,
      durationMs: output.durationMs,
    });

    return output;
  } catch (err) {
    logger.error("Pipeline failed", { error: String(err) });
    state.errors.push(`Pipeline failed: ${String(err)}`);

    if (runDocId) {
      try {
        await firestoreOps.updateRunStatus(
          runDocId,
          "failed",
          Date.now() - state.startedAt
        );
      } catch {
        // Ignore
      }
    }

    return buildOutput(state);
  }
}

export async function rerunPipeline(
  input: PipelineInput
): Promise<PipelineOutput> {
  logger.info("Re-run pipeline started", {
    adId: input.adId,
    pageUrl: input.pageUrl,
  });

  // Try to load existing flow config
  let existingConfig: FlowConfig | null = null;
  try {
    existingConfig = await getFlowConfig(input.pageUrl);
  } catch (err) {
    logger.warn("Failed to load existing flow config", {
      error: String(err),
    });
  }

  if (!existingConfig) {
    logger.info("No existing config found, running full pipeline");
    return runPipeline(input);
  }

  // Validate existing config with Stage 2 before running Stage 3
  logger.info("Existing config found, running Stage 2 sanity check");

  const stage2Result = await executeStage2(existingConfig, input.pageUrl);
  if (!stage2Result.success || !stage2Result.data?.allFound) {
    logger.info("Existing config failed sanity check, running full pipeline");
    return runPipeline(input);
  }

  logger.info("Existing config passed sanity check, running Stage 3");

  const state: PipelineState = {
    input,
    flowConfigs: [existingConfig],
    simulationResults: [],
    additionalChecks: null,
    variantSweep: null,
    summary: null,
    errors: [],
    evidenceUrls: [],
    startedAt: Date.now(),
  };

  for (const flowConfig of state.flowConfigs) {
    const stage3Result = await executeStage3(flowConfig, input);
    if (stage3Result.success && stage3Result.data) {
      state.simulationResults.push(...stage3Result.data.simulationResults);
      if (!state.additionalChecks) {
        state.additionalChecks = stage3Result.data.additionalChecks;
      }
      state.evidenceUrls.push(...stage3Result.data.evidenceUrls);
    } else {
      state.errors.push(
        `Stage 3 failed for ${flowConfig.flow_type}: ${stage3Result.error ?? "unknown error"}`
      );
    }
  }

  // Stage 3B: Variant Health Sweep
  if (existingConfig.variants && existingConfig.variants.length > 0) {
    const allCombos = generateAllCombinations(existingConfig.variants);
    if (allCombos.length > 1) {
      logger.info("Stage 3B: Starting variant health sweep (rerun)", {
        totalCombinations: allCombos.length,
      });
      const stage3bResult = await executeStage3B(existingConfig, input);
      if (stage3bResult.success && stage3bResult.data) {
        state.variantSweep = stage3bResult.data;
      } else if (stage3bResult.error) {
        logger.warn("Stage 3B failed (rerun)", { error: stage3bResult.error });
      }
    }
  }

  if (state.simulationResults.length > 0) {
    state.summary = await generateSummary(state);
  }

  const output = buildOutput(state);

  try {
    await firestoreOps.saveResult(output, state.startedAt);
  } catch (err) {
    logger.warn("Failed to save result", { error: String(err) });
  }

  return output;
}
