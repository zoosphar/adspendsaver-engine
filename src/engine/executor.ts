import type { Page } from "playwright";
import type { FlowConfig, FlowStep, StepResult, VariantCombination, VariantGroup } from "../types/index.js";
import * as actions from "./actions.js";
import { locatorToString } from "./actions.js";
import { takeStepScreenshot } from "./evidence.js";
import { verifyFailure } from "./failure-verifier.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { readFile } from "fs/promises";

export interface ExecutionOptions {
  comboName: string;
  evidenceDir: string;
  enableEvidence: boolean;
  enableGeminiVerification: boolean;
  /** Skip screenshot + Gemini on failure (used for variant selection steps) */
  lightweight?: boolean;
}

export interface FlowExecutionResult {
  steps: StepResult[];
  overallSuccess: boolean;
}

export interface VariantFlowResult {
  variantCombination: string;  // e.g. "Red / M" or "no variants"
  flowResult: FlowExecutionResult;
}

/**
 * Generate all available variant combinations from the variant groups.
 * Only includes options marked as available.
 * Returns an array of VariantCombination objects.
 */
export function generateVariantCombinations(
  variants: VariantGroup[]
): VariantCombination[] {
  const availableGroups = variants
    .map((group) => ({
      ...group,
      options: group.options.filter((o) => o.available),
    }))
    .filter((group) => group.options.length > 0);

  if (availableGroups.length === 0) return [];

  // Cartesian product of all available options across groups
  let combos: VariantCombination[] = [{ label: "", selections: [] }];

  for (const group of availableGroups) {
    const newCombos: VariantCombination[] = [];
    for (const existing of combos) {
      for (const option of group.options) {
        newCombos.push({
          label: existing.label
            ? `${existing.label} / ${option.label}`
            : option.label,
          selections: [
            ...existing.selections,
            {
              groupName: group.name,
              optionLabel: option.label,
              locator: option.locator,
            },
          ],
        });
      }
    }
    combos = newCombos;
  }

  return combos;
}

function randomDelay(): Promise<void> {
  const min = env.HUMAN_DELAY_MIN_MS;
  const max = env.HUMAN_DELAY_MAX_MS;
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

async function executeStep(
  page: Page,
  step: FlowStep,
  stepIndex: number,
  options: ExecutionOptions
): Promise<StepResult> {
  const startTime = Date.now();

  // Take "before" screenshot if evidence enabled
  if (options.enableEvidence && !options.lightweight) {
    try {
      await takeStepScreenshot(
        page,
        options.comboName,
        stepIndex,
        `before_${step.description}`,
        options.evidenceDir
      );
    } catch {
      // Non-critical
    }
  }

  let result: actions.ActionResult;

  const actionStart = Date.now();
  switch (step.action) {
    case "click":
      result = await actions.click(page, step);
      break;
    case "select_if_exists":
      result = await actions.selectIfExists(page, step);
      break;
    case "wait_for":
      result = await actions.waitFor(page, step);
      break;
    case "type_input":
      result = await actions.typeInput(page, step);
      break;
    default:
      result = {
        success: false,
        usedLocator: locatorToString(step.locator),
        errorMessage: `Unknown action: ${step.action}`,
      };
  }
  const actionMs = Date.now() - actionStart;

  logger.info("Step action completed", {
    stepIndex,
    description: step.description,
    success: result.success,
    actionMs,
    locator: result.usedLocator,
    error: result.errorMessage,
  });

  // Take "after" screenshot — skip in lightweight mode
  let screenshotPath: string | undefined;
  if (!options.lightweight && (options.enableEvidence || !result.success)) {
    try {
      screenshotPath = await takeStepScreenshot(
        page,
        options.comboName,
        stepIndex,
        step.description,
        options.evidenceDir
      );
    } catch {
      // Non-critical
    }
  }

  // Gemini verification for failures — skip in lightweight mode
  let geminiVerification = undefined;
  if (
    !options.lightweight &&
    !result.success &&
    options.enableGeminiVerification &&
    screenshotPath
  ) {
    try {
      const screenshotBuffer = await readFile(screenshotPath);
      geminiVerification = await verifyFailure(
        Buffer.from(screenshotBuffer),
        step,
        result.errorMessage ?? "Unknown error"
      );
    } catch (err) {
      logger.warn("Gemini verification skipped", { error: String(err) });
    }
  }

  return {
    stepIndex,
    action: step.action,
    locator: result.usedLocator,
    description: step.description,
    success: result.success,
    errorMessage: result.errorMessage,
    screenshotPath,
    geminiVerification,
    durationMs: Date.now() - startTime,
  };
}

export async function executeFlow(
  page: Page,
  config: FlowConfig,
  options: ExecutionOptions
): Promise<FlowExecutionResult> {
  const steps: StepResult[] = [];
  let overallSuccess = true;

  for (let i = 0; i < config.steps.length; i++) {
    const step = config.steps[i];
    logger.info("Executing step", {
      combo: options.comboName,
      stepIndex: i,
      action: step.action,
      description: step.description,
    });

    const result = await executeStep(page, step, i, options);
    steps.push(result);

    if (!result.success) {
      const isRequired = step.required !== false;
      if (isRequired) {
        logger.warn("Required step failed, stopping flow", {
          combo: options.comboName,
          stepIndex: i,
          error: result.errorMessage,
        });
        overallSuccess = false;
        break;
      }
      logger.info("Optional step failed, continuing", {
        combo: options.comboName,
        stepIndex: i,
      });
    }

    // Human-like delay between steps
    await randomDelay();
  }

  return { steps, overallSuccess };
}

/**
 * Execute a single variant combination: select the variant options,
 * then run the base flow steps (add to cart → checkout).
 */
async function executeVariantCombination(
  page: Page,
  config: FlowConfig,
  combination: VariantCombination,
  options: ExecutionOptions
): Promise<FlowExecutionResult> {
  const allSteps: StepResult[] = [];
  let overallSuccess = true;

  // Step offset: variant selection steps come first
  let stepIndex = 0;

  // Variant selection uses lightweight mode: no screenshots or Gemini
  const variantOptions: ExecutionOptions = { ...options, lightweight: true };

  for (const selection of combination.selections) {
    const variantStep: FlowStep = {
      action: "click",
      locator: selection.locator,
      description: `Select ${selection.groupName}: ${selection.optionLabel}`,
      required: true,
    };

    logger.info("Selecting variant", {
      combo: options.comboName,
      variant: combination.label,
      group: selection.groupName,
      option: selection.optionLabel,
      locator: locatorToString(selection.locator),
    });

    const result = await executeStep(page, variantStep, stepIndex, variantOptions);
    allSteps.push(result);
    stepIndex++;

    if (!result.success) {
      logger.warn("Variant selection failed, stopping flow", {
        combo: options.comboName,
        variant: combination.label,
        group: selection.groupName,
        option: selection.optionLabel,
        error: result.errorMessage,
      });
      overallSuccess = false;
      return { steps: allSteps, overallSuccess };
    }

    await randomDelay();
  }

  // Run the base flow steps (add to cart, wait for cart, verify, checkout)
  for (const step of config.steps) {
    logger.info("Executing step", {
      combo: options.comboName,
      variant: combination.label,
      stepIndex,
      action: step.action,
      description: step.description,
    });

    const result = await executeStep(page, step, stepIndex, options);
    allSteps.push(result);
    stepIndex++;

    if (!result.success) {
      const isRequired = step.required !== false;
      if (isRequired) {
        logger.warn("Required step failed, stopping flow", {
          combo: options.comboName,
          variant: combination.label,
          stepIndex: stepIndex - 1,
          error: result.errorMessage,
        });
        overallSuccess = false;
        break;
      }
    }

    await randomDelay();
  }

  return { steps: allSteps, overallSuccess };
}

/**
 * Execute the flow for variant combinations on a single page.
 *
 * @param runAllVariants - If true, test every available variant combination
 *   (used for Chrome Desktop). If false, test only the first combination
 *   (used for other browser combos to verify cross-browser compatibility).
 */
export async function executeFlowWithVariants(
  page: Page,
  config: FlowConfig,
  options: ExecutionOptions,
  navigateUrl: string,
  runAllVariants: boolean
): Promise<VariantFlowResult[]> {
  const allCombinations = config.variants && config.variants.length > 0
    ? generateVariantCombinations(config.variants)
    : [];

  // No variants — run the base flow once
  if (allCombinations.length === 0) {
    const result = await executeFlow(page, config, options);
    return [{ variantCombination: "no variants", flowResult: result }];
  }

  // Non-primary browsers: only test the first variant combination
  const combinations = runAllVariants ? allCombinations : [allCombinations[0]];

  logger.info("Running variant combinations", {
    combo: options.comboName,
    runAllVariants,
    totalAvailable: allCombinations.length,
    running: combinations.length,
    combinations: combinations.map((c) => c.label),
  });

  const results: VariantFlowResult[] = [];
  const MAX_CONSECUTIVE_FAILURES = 5;
  let consecutiveFailures = 0;

  for (let i = 0; i < combinations.length; i++) {
    const combination = combinations[i];

    // Bail early if too many consecutive failures (likely rate-limited or page broken)
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      logger.warn("Too many consecutive variant failures, stopping early", {
        combo: options.comboName,
        consecutiveFailures,
        stoppedAt: i,
        totalVariants: combinations.length,
        remainingSkipped: combinations.length - i,
      });

      // Record remaining combinations as failed
      for (let j = i; j < combinations.length; j++) {
        results.push({
          variantCombination: combinations[j].label,
          flowResult: {
            steps: [],
            overallSuccess: false,
          },
        });
      }
      break;
    }

    logger.info("Starting variant combination", {
      combo: options.comboName,
      variantIndex: i + 1,
      totalVariants: combinations.length,
      variant: combination.label,
    });

    // Reload the page before each combination to get a clean state
    if (i > 0) {
      try {
        await page.goto(navigateUrl, {
          waitUntil: "networkidle",
          timeout: 30000,
        });
      } catch {
        // networkidle may timeout on heavy pages; fall back to domcontentloaded
        logger.warn("networkidle timeout, falling back", { variantIndex: i });
        await page.goto(navigateUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      // Wait for the first variant's element to confirm page is interactive
      const firstLocator = combinations[i].selections[0]?.locator;
      if (firstLocator) {
        try {
          const loc = firstLocator.method === "role"
            ? page.getByRole(firstLocator.role as any, { name: firstLocator.name, exact: firstLocator.exact })
            : firstLocator.method === "css"
              ? page.locator(firstLocator.selector)
              : firstLocator.method === "text"
                ? page.getByText(firstLocator.text, { exact: firstLocator.exact })
                : null;
          if (loc) {
            await loc.first().waitFor({ state: "attached", timeout: 10000 });
          }
        } catch {
          logger.warn("First variant element not found after reload, page may not have loaded", {
            variantIndex: i,
            variant: combinations[i].label,
          });
        }
      }
    }

    const flowResult = await executeVariantCombination(
      page,
      config,
      combination,
      options
    );

    results.push({
      variantCombination: combination.label,
      flowResult,
    });

    if (flowResult.overallSuccess) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
    }

    logger.info("Variant combination complete", {
      combo: options.comboName,
      variant: combination.label,
      success: flowResult.overallSuccess,
      consecutiveFailures,
    });
  }

  return results;
}
