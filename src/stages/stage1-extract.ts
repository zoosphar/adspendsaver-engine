import Anthropic from "@anthropic-ai/sdk";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { FlowConfig, FlowStep, PipelineInput, StageResult, SanityConfig, SanityPhase, SanityCheck } from "../types/index.js";
import { locatorToString } from "../engine/actions.js";
import * as actions from "../engine/actions.js";
import { buildPreCartPrompt, buildPostCartPrompt } from "../mcp/prompts.js";
import { saveFlowConfig } from "../firebase/firestore.js";
import { computeSnapshotDiff } from "../utils/snapshot-diff.js";
import { takeStepScreenshot } from "../engine/evidence.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { mkdir } from "fs/promises";
import { join } from "path";

export interface Stage1Result extends StageResult<FlowConfig> {
  /** The page from Stage 1's browser session — reuse in Stage 2 to avoid relaunching */
  page?: Page;
  /** Call to close the browser when done with the page */
  cleanup?: () => Promise<void>;
}

function extractJsonFromText(text: string): string | null {
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();
  const jsonMatch = text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (jsonMatch) return jsonMatch[0];
  return null;
}

function isValidLocator(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  const loc = obj as Record<string, unknown>;
  const validMethods = ["role", "text", "label", "css", "testId"];
  if (!validMethods.includes(loc.method as string)) return false;

  switch (loc.method) {
    case "role":
      return typeof loc.role === "string" && !!loc.role;
    case "text":
      return typeof loc.text === "string" && !!loc.text;
    case "label":
      return typeof loc.label === "string" && !!loc.label;
    case "css":
      return typeof loc.selector === "string" && !!loc.selector;
    case "testId":
      return typeof loc.testId === "string" && !!loc.testId;
    default:
      return false;
  }
}

function isValidStep(step: unknown): boolean {
  if (!step || typeof step !== "object") return false;
  const s = step as Record<string, unknown>;
  const validActions = ["click", "select_if_exists", "wait_for", "type_input"];
  if (!validActions.includes(s.action as string)) return false;
  if (!isValidLocator(s.locator)) return false;
  if (typeof s.description !== "string") return false;
  return true;
}

function validatePartialFlowConfig(obj: unknown): obj is FlowConfig {
  if (!obj || typeof obj !== "object") return false;
  const config = obj as Record<string, unknown>;

  const validFlowTypes = [
    "product_to_checkout",
    "product_to_checkout_from_grid",
    "multiple_products_to_checkout_from_grid",
  ];
  if (!validFlowTypes.includes(config.flow_type as string)) return false;
  if (typeof config.pageUrl !== "string") return false;
  if (!Array.isArray(config.steps) || config.steps.length === 0) return false;

  for (const step of config.steps) {
    if (!isValidStep(step)) return false;
  }

  // Validate variants if present
  if (config.variants !== undefined) {
    if (!Array.isArray(config.variants)) return false;
    const validTypes = ["color", "size", "other"];
    for (const group of config.variants) {
      if (!group || typeof group !== "object") return false;
      const g = group as Record<string, unknown>;
      if (typeof g.name !== "string") return false;
      if (!validTypes.includes(g.type as string)) return false;
      if (!Array.isArray(g.options) || g.options.length === 0) return false;
      for (const opt of g.options) {
        if (!opt || typeof opt !== "object") return false;
        const o = opt as Record<string, unknown>;
        if (typeof o.label !== "string") return false;
        if (!isValidLocator(o.locator)) return false;
        if (typeof o.available !== "boolean") return false;
      }
    }
  }

  return true;
}

function validatePostCartSteps(arr: unknown): arr is FlowStep[] {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  for (const step of arr) {
    if (!isValidStep(step)) return false;
  }
  return true;
}

/**
 * Execute partial FlowConfig steps on a live page (variant selection + ATC).
 * Returns feedback string describing the failure, or null on success.
 */
async function executePartialSteps(
  page: Page,
  partialConfig: FlowConfig
): Promise<string | null> {
  // Step 1: Select first available variant from each group
  if (partialConfig.variants && partialConfig.variants.length > 0) {
    for (const group of partialConfig.variants) {
      const available = group.options.find((o) => o.available);
      if (!available) {
        logger.warn("No available option in variant group", { group: group.name });
        continue;
      }

      logger.info("Selecting variant", {
        group: group.name,
        option: available.label,
        locator: locatorToString(available.locator),
      });

      const clickStep: FlowStep = {
        action: "click",
        locator: available.locator,
        description: `Select variant ${group.name}: ${available.label}`,
        required: true,
      };

      const result = await actions.click(page, clickStep);
      if (!result.success) {
        return `Variant selection failed for ${group.name}/${available.label}: ${result.errorMessage}`;
      }

      // Brief wait for variant UI to update
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // Step 2: Execute each step in the partial config
  for (let i = 0; i < partialConfig.steps.length; i++) {
    const step = partialConfig.steps[i];
    logger.info("Executing partial step", {
      index: i,
      action: step.action,
      description: step.description,
    });

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
    }

    if (!result.success && step.required !== false) {
      return `Step ${i} (${step.description}) failed: ${result.errorMessage}`;
    }
  }

  return null;
}

export async function executeStage1(
  input: PipelineInput,
  feedback?: string
): Promise<Stage1Result> {
  const startTime = Date.now();
  const maxRetries = env.MAX_SANITY_RETRIES;
  const evidenceDir = join("evidence", "stage1", Date.now().toString());

  let browser: Browser | null = null as Browser | null;

  try {
    logger.info("Stage 1: Starting two-phase flow config extraction", {
      pageUrl: input.pageUrl,
      hasFeedback: !!feedback,
      maxRetries,
    });

    let lastError = "";

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let context: BrowserContext | null = null;

      try {
        logger.info(`Stage 1: Attempt ${attempt}/${maxRetries}`);

        // Launch browser (fresh per attempt)
        browser = await chromium.launch({ headless: true });

        // Create context with video recording on last attempt
        const contextOptions: Record<string, unknown> = {
          viewport: { width: 1920, height: 1080 },
        };

        if (attempt === maxRetries) {
          await mkdir(join(evidenceDir, "recordings"), { recursive: true });
          contextOptions.recordVideo = {
            dir: join(evidenceDir, "recordings"),
            size: { width: 1280, height: 720 },
          };
        }

        context = await browser.newContext(contextOptions);
        const page = await context.newPage();

        // ── Phase A: Snapshot initial page → extract variants + ATC steps ──
        logger.info("Phase A: Navigating to page", { url: input.pageUrl });
        await page.goto(input.pageUrl, { waitUntil: "domcontentloaded" });
        await new Promise((resolve) => setTimeout(resolve, 3000));

        logger.info("Phase A: Taking accessibility snapshot #1");
        const snapshot1 = await page.locator("body").ariaSnapshot();

        logger.info("Phase A: Snapshot #1 captured", { length: snapshot1.length });

        // Claude call #1: extract pre-cart config
        const anthropic = new Anthropic({
          apiKey: env.ANTHROPIC_API_KEY,
          maxRetries: 5,
        });

        const feedbackForAttempt = attempt === 1 ? feedback : lastError;
        const preCartPrompt = buildPreCartPrompt(input, snapshot1, feedbackForAttempt || undefined);

        logger.info("Phase A: Calling Claude for pre-cart extraction", {
          model: env.EXPLORATION_MODEL,
          promptLength: preCartPrompt.length,
        });

        const preCartResponse = await anthropic.messages.create({
          model: env.EXPLORATION_MODEL,
          max_tokens: 4096,
          messages: [{ role: "user", content: preCartPrompt }],
        });

        logger.info("Phase A: Claude response received", {
          inputTokens: preCartResponse.usage.input_tokens,
          outputTokens: preCartResponse.usage.output_tokens,
        });

        const preCartText = preCartResponse.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n");

        const preCartJson = extractJsonFromText(preCartText);
        if (!preCartJson) {
          lastError = "Phase A: Claude did not produce valid JSON";
          logger.warn(lastError);
          await context.close();
          await browser.close();
          browser = null;
          continue;
        }

        let partialConfig: FlowConfig;
        try {
          const parsed = JSON.parse(preCartJson);
          if (!validatePartialFlowConfig(parsed)) {
            lastError = "Phase A: Parsed JSON does not match FlowConfig schema";
            logger.warn(lastError, { keys: Object.keys(parsed) });
            await context.close();
            await browser.close();
            browser = null;
            continue;
          }
          partialConfig = parsed as FlowConfig;
        } catch (err) {
          lastError = `Phase A: JSON parse error: ${String(err)}`;
          logger.warn(lastError);
          await context.close();
          if (browser) { await browser.close(); browser = null; }
          continue;
        }

        logger.info("Phase A: Partial FlowConfig extracted", {
          flowType: partialConfig.flow_type,
          variantGroups: partialConfig.variants?.length ?? 0,
          steps: partialConfig.steps.length,
          variants: partialConfig.variants?.map((g) => ({
            name: g.name,
            type: g.type,
            optionCount: g.options.length,
          })),
          stepDescriptions: partialConfig.steps.map((s) => s.description),
        });

        // ── Phase B: Execute partial steps → snapshot cart → extract cart/checkout ──
        logger.info("Phase B: Executing partial config steps on live page");

        const execError = await executePartialSteps(page, partialConfig);
        if (execError) {
          lastError = `Phase B: Partial step execution failed: ${execError}`;
          logger.warn(lastError);

          // Take screenshot on failure
          if (attempt === maxRetries) {
            await mkdir(join(evidenceDir, "screenshots"), { recursive: true });
            await takeStepScreenshot(
              page,
              "stage1-failure",
              attempt,
              "partial-steps-failed",
              evidenceDir
            );
          }

          await context.close();
          await browser.close();
          browser = null;
          continue;
        }

        // Wait for cart state to settle after ATC
        logger.info("Phase B: Waiting for cart state to settle");
        await new Promise((resolve) => setTimeout(resolve, 3000));

        logger.info("Phase B: Taking accessibility snapshot #2 (cart state)");
        const snapshot2 = await page.locator("body").ariaSnapshot();
        logger.info("Phase B: Snapshot #2 captured", { length: snapshot2.length });

        // Snapshot iframe content (cart drawers/sidebars may be inside iframes)
        const iframeSnapshots: string[] = [];
        for (const frame of page.frames()) {
          if (frame === page.mainFrame() || frame.isDetached()) continue;
          try {
            const frameSnapshot = await frame.locator("body").ariaSnapshot();
            if (frameSnapshot && frameSnapshot.trim().length > 0) {
              iframeSnapshots.push(frameSnapshot);
              logger.info("Phase B: Iframe snapshot captured", {
                frameUrl: frame.url(),
                length: frameSnapshot.length,
              });
            }
          } catch {
            // Frame might not be accessible (cross-origin, detached, etc.)
          }
        }

        if (iframeSnapshots.length > 0) {
          logger.info("Phase B: Iframe snapshots captured", { count: iframeSnapshots.length });
        }

        // Compute diff
        const diff = computeSnapshotDiff(snapshot1, snapshot2);
        logger.info("Phase B: Snapshot diff computed", { diffLength: diff.length });

        // Claude call #2: extract cart/checkout steps
        const postCartPrompt = buildPostCartPrompt(input, snapshot2, diff, iframeSnapshots);

        logger.info("Phase B: Calling Claude for post-cart extraction", {
          model: env.EXPLORATION_MODEL,
          promptLength: postCartPrompt.length,
        });

        const postCartResponse = await anthropic.messages.create({
          model: env.EXPLORATION_MODEL,
          max_tokens: 4096,
          messages: [{ role: "user", content: postCartPrompt }],
        });

        logger.info("Phase B: Claude response received", {
          inputTokens: postCartResponse.usage.input_tokens,
          outputTokens: postCartResponse.usage.output_tokens,
        });

        const postCartText = postCartResponse.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n");

        const postCartJson = extractJsonFromText(postCartText);
        if (!postCartJson) {
          lastError = "Phase B: Claude did not produce valid JSON for cart/checkout steps";
          logger.warn(lastError);

          if (attempt === maxRetries) {
            await mkdir(join(evidenceDir, "screenshots"), { recursive: true });
            await takeStepScreenshot(
              page,
              "stage1-failure",
              attempt,
              "post-cart-extraction-failed",
              evidenceDir
            );
          }

          await context.close();
          await browser.close();
          browser = null;
          continue;
        }

        let cartSteps: FlowStep[];
        try {
          const parsed = JSON.parse(postCartJson);
          if (!validatePostCartSteps(parsed)) {
            lastError = "Phase B: Cart/checkout steps do not match FlowStep schema";
            logger.warn(lastError);
            await context.close();
            await browser.close();
            browser = null;
            continue;
          }
          cartSteps = parsed as FlowStep[];
        } catch (err) {
          lastError = `Phase B: JSON parse error for cart steps: ${String(err)}`;
          logger.warn(lastError);
          await context.close();
          if (browser) { await browser.close(); browser = null; }
          continue;
        }

        logger.info("Phase B: Cart/checkout steps extracted", {
          stepCount: cartSteps.length,
          stepDescriptions: cartSteps.map((s) => s.description),
        });

        // ── Merge: combine Phase A config + Phase B steps ──

        // Build sanity config so Stage 2 knows how to verify locators
        const preCartChecks: SanityCheck[] = [];

        // Check all variant locators on initial page
        if (partialConfig.variants) {
          for (const group of partialConfig.variants) {
            for (const option of group.options) {
              if (!option.available) continue;
              preCartChecks.push({
                description: `Variant ${group.name}: ${option.label}`,
                locator: option.locator,
              });
            }
          }
        }

        // Check Phase A step locators (ATC button etc.)
        for (const step of partialConfig.steps) {
          preCartChecks.push({
            description: step.description,
            locator: step.locator,
            fallbackLocators: step.fallbackLocators,
          });
        }

        // Post-cart checks: transition = select first variant + execute Phase A steps
        const transitionSteps: FlowStep[] = [];

        // Select first available variant from each group
        if (partialConfig.variants) {
          for (const group of partialConfig.variants) {
            const firstAvailable = group.options.find((o) => o.available);
            if (firstAvailable) {
              transitionSteps.push({
                action: "click",
                locator: firstAvailable.locator,
                description: `Select ${group.name}: ${firstAvailable.label}`,
                required: true,
              });
            }
          }
        }

        // Then execute the Phase A steps (wait for ATC, click ATC)
        transitionSteps.push(...partialConfig.steps);

        // Build post-cart phases: split at click actions that change page state.
        // Intermediate clicks (followed by more steps) become transition steps
        // for a new sub-phase, so Stage 2 actually navigates through the flow.
        const postCartPhases: SanityPhase[] = [];
        let currentPhaseChecks: SanityCheck[] = [];
        let nextPhaseTransitions: FlowStep[] = [...transitionSteps];

        for (let i = 0; i < cartSteps.length; i++) {
          const step = cartSteps[i];
          const hasMoreSteps = i < cartSteps.length - 1;

          // Always add as a check (verify element exists on current page state)
          currentPhaseChecks.push({
            description: step.description,
            locator: step.locator,
            fallbackLocators: step.fallbackLocators,
          });

          // If it's a click with more steps after, it's a navigation action:
          // finalize current phase, start a new phase with this click as transition
          if (step.action === "click" && hasMoreSteps) {
            postCartPhases.push({
              name: postCartPhases.length === 0 ? "post-cart" : `post-cart-${postCartPhases.length + 1}`,
              transitionSteps: nextPhaseTransitions,
              checks: currentPhaseChecks,
            });
            nextPhaseTransitions = [step];
            currentPhaseChecks = [];
          }
        }

        // Finalize the last phase (contains the terminal action, e.g. Checkout)
        if (currentPhaseChecks.length > 0) {
          postCartPhases.push({
            name: postCartPhases.length === 0 ? "post-cart" : `post-cart-${postCartPhases.length + 1}`,
            transitionSteps: nextPhaseTransitions,
            checks: currentPhaseChecks,
          });
        }

        const sanityConfig: SanityConfig = {
          phases: [
            {
              name: "pre-cart",
              transitionSteps: [],
              checks: preCartChecks,
            },
            ...postCartPhases,
          ],
        };

        const completeConfig: FlowConfig = {
          ...partialConfig,
          steps: [...partialConfig.steps, ...cartSteps],
          sanityConfig,
          pageUrl: partialConfig.pageUrl || input.pageUrl,
          clientWebsite: partialConfig.clientWebsite || input.clientWebsite,
          extractedAt: partialConfig.extractedAt || new Date().toISOString(),
          pageStructure: partialConfig.pageStructure || {
            isSPA: false,
            notes: [],
          },
        };

        // Log the complete config
        logger.info("Stage 1: Complete FlowConfig assembled", {
          flowType: completeConfig.flow_type,
          pageUrl: completeConfig.pageUrl,
          framework: completeConfig.pageStructure?.framework,
          variants: completeConfig.variants?.map((g) => ({
            name: g.name,
            type: g.type,
            optionCount: g.options.length,
            availableCount: g.options.filter((o) => o.available).length,
            options: g.options.map((o) => ({
              label: o.label,
              locator: locatorToString(o.locator),
              available: o.available,
            })),
          })),
          steps: completeConfig.steps.map((s, i) => ({
            index: i,
            action: s.action,
            locator: locatorToString(s.locator),
            description: s.description,
            required: s.required,
          })),
        });

        // Save to Firestore
        try {
          await saveFlowConfig(completeConfig);
        } catch (err) {
          logger.warn("Failed to save flow config to Firestore", {
            error: String(err),
          });
        }

        // Keep browser open — return page + cleanup for Stage 2 to reuse
        const currentBrowser = browser;
        const currentContext = context;
        browser = null; // prevent finally block from closing it

        logger.info("Stage 1: Flow config extracted successfully", {
          steps: completeConfig.steps.length,
          variantGroups: completeConfig.variants?.length ?? 0,
          framework: completeConfig.pageStructure?.framework,
          attempt,
          durationMs: Date.now() - startTime,
        });

        return {
          success: true,
          data: completeConfig,
          page,
          cleanup: async () => {
            await currentContext.close().catch(() => {});
            await currentBrowser.close().catch(() => {});
          },
          durationMs: Date.now() - startTime,
        };
      } catch (err) {
        lastError = `Attempt ${attempt} exception: ${String(err)}`;
        logger.error(`Stage 1: Attempt ${attempt} failed with exception`, {
          error: String(err),
        });

        // Take evidence on final attempt
        if (attempt === maxRetries && context) {
          try {
            const pages = context.pages();
            if (pages.length > 0) {
              await mkdir(join(evidenceDir, "screenshots"), { recursive: true });
              await takeStepScreenshot(
                pages[0],
                "stage1-failure",
                attempt,
                "exception",
                evidenceDir
              );
            }
          } catch {
            // Best effort evidence capture
          }
        }

        if (context) await context.close().catch(() => {});
        if (browser) {
          await browser.close().catch(() => {});
          browser = null;
        }
      }
    }

    // All retries exhausted
    logger.error("Stage 1: All retries exhausted", {
      attempts: maxRetries,
      lastError,
      evidenceDir,
    });

    return {
      success: false,
      data: null,
      error: `Stage 1 failed after ${maxRetries} attempts. Last error: ${lastError}. Evidence saved to ${evidenceDir}`,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    logger.error("Stage 1 failed (outer)", { error: String(err) });
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
