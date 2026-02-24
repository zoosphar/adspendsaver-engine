import { chromium, type Browser, type Page, type Frame } from "playwright";
import type { FlowConfig, FlowStep, LocatorDescriptor, SanityCheck, StageResult } from "../types/index.js";
import * as actions from "../engine/actions.js";
import { locatorToString } from "../engine/actions.js";
import { logger } from "../utils/logger.js";

export interface SanityCheckResult {
  allFound: boolean;
  phaseResults: {
    phase: string;
    transitionSuccess: boolean;
    missingChecks: {
      description: string;
      locator: string;
      fallbacksTried: string[];
    }[];
  }[];
  feedback: string;
}

/**
 * Check if a locator finds at least one element in a specific page or frame.
 */
async function locatorExistsIn(target: Page | Frame, desc: LocatorDescriptor): Promise<boolean> {
  try {
    switch (desc.method) {
      case "role":
        return await target.getByRole(desc.role as any, {
          name: desc.name,
          exact: desc.exact,
        }).first().isVisible().catch(() => false)
          || await target.getByRole(desc.role as any, {
            name: desc.name,
            exact: desc.exact,
          }).count().then((c) => c > 0).catch(() => false);
      case "text":
        return await target.getByText(desc.text, { exact: desc.exact }).count().then((c) => c > 0).catch(() => false);
      case "label":
        return await target.getByLabel(desc.label, { exact: desc.exact }).count().then((c) => c > 0).catch(() => false);
      case "css":
        return await target.locator(desc.selector).count().then((c) => c > 0).catch(() => false);
      case "testId":
        return await target.getByTestId(desc.testId).count().then((c) => c > 0).catch(() => false);
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * Check if a locator finds at least one element on the page or inside any iframe.
 */
async function locatorExists(page: Page, desc: LocatorDescriptor): Promise<boolean> {
  // Try main page first
  if (await locatorExistsIn(page, desc)) return true;

  // Try child frames (iframes)
  for (const frame of page.frames()) {
    if (frame === page.mainFrame() || frame.isDetached()) continue;
    if (await locatorExistsIn(frame, desc)) {
      logger.info("Stage 2: Found locator in iframe", {
        locator: locatorToString(desc),
        frameUrl: frame.url(),
      });
      return true;
    }
  }

  return false;
}

/**
 * Execute a transition step on the page (click, wait_for, etc.)
 */
async function executeTransitionStep(page: Page, step: FlowStep): Promise<boolean> {
  let result: actions.ActionResult;

  switch (step.action) {
    case "click":
      result = await actions.click(page, step);
      break;
    case "wait_for":
      result = await actions.waitFor(page, step);
      break;
    case "select_if_exists":
      result = await actions.selectIfExists(page, step);
      break;
    case "type_input":
      result = await actions.typeInput(page, step);
      break;
    default:
      return false;
  }

  if (!result.success) {
    logger.warn("Sanity transition step failed", {
      description: step.description,
      error: result.errorMessage,
    });
  }

  return result.success;
}

/**
 * Verify checks in a sanity check list.
 * Returns the missing checks.
 */
async function verifyChecks(
  page: Page,
  checks: SanityCheck[]
): Promise<SanityCheckResult["phaseResults"][0]["missingChecks"]> {
  const missing: SanityCheckResult["phaseResults"][0]["missingChecks"] = [];

  for (const check of checks) {
    const primaryLocStr = locatorToString(check.locator);

    // Check primary locator
    const primaryFound = await locatorExists(page, check.locator);
    logger.info("Stage 2: Checking locator", {
      description: check.description,
      locator: primaryLocStr,
      method: check.locator.method,
      found: primaryFound,
    });

    if (primaryFound) continue;

    // Check fallback locators
    const fallbacksTried: string[] = [];
    let fallbackFound = false;

    if (check.fallbackLocators) {
      for (const fallback of check.fallbackLocators) {
        const fallbackStr = locatorToString(fallback);
        fallbacksTried.push(fallbackStr);
        const found = await locatorExists(page, fallback);
        logger.info("Stage 2: Checking fallback locator", {
          description: check.description,
          locator: fallbackStr,
          method: fallback.method,
          found,
        });
        if (found) {
          fallbackFound = true;
          break;
        }
      }
    }

    if (!fallbackFound) {
      missing.push({
        description: check.description,
        locator: primaryLocStr,
        fallbacksTried,
      });
    }
  }

  return missing;
}

export async function executeStage2(
  flowConfig: FlowConfig,
  pageUrl: string,
  existingPage?: Page
): Promise<StageResult<SanityCheckResult>> {
  const startTime = Date.now();
  let browser: Browser | null = null;

  try {
    logger.info("Stage 2: Starting sanity check", { pageUrl, reusingPage: !!existingPage });

    if (!flowConfig.sanityConfig) {
      logger.warn("Stage 2: No sanityConfig found, failed to do sanity check.");
      return {
        success: false,
        data: { allFound: false, phaseResults: [], feedback: "" },
        durationMs: Date.now() - startTime,
      };
    }

    let page: Page;

    if (existingPage) {
      // Reuse page from Stage 1 — navigate back to initial URL
      page = existingPage;
      await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(3000);
    } else {
      // Launch fresh browser (used by rerunPipeline with cached config)
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
      });
      page = await context.newPage();
      await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(3000);
    }

    // Log the full sanity config for debugging
    logger.info("Stage 2: Sanity config", {
      phases: flowConfig.sanityConfig.phases.map((p) => ({
        name: p.name,
        transitionSteps: p.transitionSteps.map((s) => ({
          action: s.action,
          description: s.description,
          locator: locatorToString(s.locator),
        })),
        checks: p.checks.map((c) => ({
          description: c.description,
          locator: locatorToString(c.locator),
          fallbacks: c.fallbackLocators?.map(locatorToString) ?? [],
        })),
      })),
    });

    const phaseResults: SanityCheckResult["phaseResults"] = [];
    let allFound = true;

    for (const phase of flowConfig.sanityConfig.phases) {
      logger.info("Stage 2: Running phase", {
        phase: phase.name,
        transitionSteps: phase.transitionSteps.length,
        checks: phase.checks.length,
      });

      // Execute transition steps to reach the right page state
      let transitionSuccess = true;
      for (const step of phase.transitionSteps) {
        logger.info("Stage 2: Executing transition step", {
          phase: phase.name,
          description: step.description,
        });

        const success = await executeTransitionStep(page, step);
        if (!success && step.required !== false) {
          transitionSuccess = false;
          logger.warn("Stage 2: Transition step failed, cannot verify phase", {
            phase: phase.name,
            step: step.description,
          });
          break;
        }

        // Brief wait after each transition step
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      if (!transitionSuccess) {
        // If transition failed, all checks in this phase are "missing"
        phaseResults.push({
          phase: phase.name,
          transitionSuccess: false,
          missingChecks: phase.checks.map((c) => ({
            description: c.description,
            locator: locatorToString(c.locator),
            fallbacksTried: [],
          })),
        });
        allFound = false;
        continue;
      }

      // Wait for page to settle after transitions
      if (phase.transitionSteps.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      // Verify all checks in this phase
      const missingChecks = await verifyChecks(page, phase.checks);

      phaseResults.push({
        phase: phase.name,
        transitionSuccess: true,
        missingChecks,
      });

      if (missingChecks.length > 0) {
        allFound = false;
        logger.warn("Stage 2: Missing locators in phase", {
          phase: phase.name,
          missingCount: missingChecks.length,
          missing: missingChecks.map((m) => m.description),
        });
      } else {
        logger.info("Stage 2: All checks passed for phase", {
          phase: phase.name,
          checksVerified: phase.checks.length,
        });
      }
    }

    // Build feedback string for Stage 1 re-extraction
    let feedback = "";
    if (!allFound) {
      const parts: string[] = [];
      for (const pr of phaseResults) {
        if (!pr.transitionSuccess) {
          parts.push(
            `Phase "${pr.phase}": transition steps failed — could not reach this page state. ` +
            `All locators for this phase could not be verified.`
          );
        } else if (pr.missingChecks.length > 0) {
          parts.push(
            `Phase "${pr.phase}": the following locators were NOT found:\n` +
            pr.missingChecks.map((m) =>
              `- ${m.description}: locator ${m.locator} not found` +
              (m.fallbacksTried.length ? `, fallbacks tried: ${m.fallbacksTried.join(", ")}` : "")
            ).join("\n")
          );
        }
      }
      feedback = parts.join("\n\n") + "\n\nPlease re-examine the page and provide corrected locators.";
    }

    logger.info("Stage 2: Sanity check complete", {
      allFound,
      phases: phaseResults.map((p) => ({
        phase: p.phase,
        transitionSuccess: p.transitionSuccess,
        missingCount: p.missingChecks.length,
      })),
      durationMs: Date.now() - startTime,
    });

    return {
      success: true,
      data: { allFound, phaseResults, feedback },
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    logger.error("Stage 2 failed", { error: String(err) });
    return {
      success: false,
      data: null,
      error: String(err),
      durationMs: Date.now() - startTime,
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
