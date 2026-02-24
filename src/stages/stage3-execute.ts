import { chromium, firefox, webkit, type Browser } from "playwright";
import type {
  FlowConfig,
  PipelineInput,
  StageResult,
  SimulationResult,
  AdditionalChecks,
  BrokenImage,
  ConsoleError,
} from "../types/index.js";
import { BROWSER_DEVICE_COMBOS } from "../utils/devices.js";
import { extractAdParams, compareAdParams } from "../utils/url.js";
import { executeFlowWithVariants } from "../engine/executor.js";
import { injectClickHighlighter, getVideoRecordingConfig } from "../engine/evidence.js";
import { uploadEvidenceDirectory } from "../firebase/storage.js";
import { logger } from "../utils/logger.js";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

export interface ExecutionResult {
  simulationResults: SimulationResult[];
  additionalChecks: AdditionalChecks;
  evidenceUrls: string[];
}

function launchBrowser(browserName: string): Promise<Browser> {
  const opts = { headless: true };
  switch (browserName) {
    case "firefox":
      return firefox.launch(opts);
    case "webkit":
      return webkit.launch(opts);
    default:
      return chromium.launch(opts);
  }
}

export async function executeStage3(
  flowConfig: FlowConfig,
  input: PipelineInput
): Promise<StageResult<ExecutionResult>> {
  const startTime = Date.now();

  try {
    logger.info("Stage 3: Starting execution across browser combos", {
      pageUrl: flowConfig.pageUrl,
      combos: BROWSER_DEVICE_COMBOS.length,
    });

    const evidenceDir = join(process.cwd(), "evidence", `${input.adId}_${startTime}`);
    await mkdir(evidenceDir, { recursive: true });
    const simulationResults: SimulationResult[] = [];
    const allEvidenceUrls: string[] = [];
    let globalAdditionalChecks: AdditionalChecks | null = null;

    // Extract ad params from original URL
    const originalAdParams = extractAdParams(input.pageUrl);

    for (const combo of BROWSER_DEVICE_COMBOS) {
      const comboStart = Date.now();
      let browser: Browser | null = null;

      try {
        logger.info("Running combo", { combo: combo.name });

        browser = await launchBrowser(combo.browser);

        const videoConfig = getVideoRecordingConfig(evidenceDir, combo.name);
        await mkdir(videoConfig.recordVideo.dir, { recursive: true });

        const contextOptions: Record<string, unknown> = {
          viewport: combo.viewport,
          ...(combo.userAgent ? { userAgent: combo.userAgent } : {}),
          ...videoConfig,
        };

        const context = await browser.newContext(contextOptions);
        const page = await context.newPage();

        // Collect console errors
        const consoleErrors: ConsoleError[] = [];
        page.on("console", (msg) => {
          if (msg.type() === "error") {
            consoleErrors.push({
              message: msg.text(),
              type: msg.type(),
              timestamp: Date.now(),
            });
          }
        });

        // Inject click highlighter
        await injectClickHighlighter(page);

        // Navigate and measure page load time
        const navStart = Date.now();
        const response = await page.goto(input.pageUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        const pageLoadTimeMs = Date.now() - navStart;

        // Check for 404
        const is404 = response?.status() === 404;

        // Check ad param preservation after navigation
        const finalUrl = page.url();
        const finalAdParams = extractAdParams(finalUrl);
        const adParamComparison = compareAdParams(originalAdParams, finalAdParams);

        // Check for broken images
        const brokenImages: BrokenImage[] = await page.evaluate(() => {
          const images = Array.from(document.querySelectorAll("img"));
          return images
            .filter((img) => !img.complete || img.naturalWidth === 0)
            .map((img) => ({
              src: img.src,
              alt: img.alt || undefined,
            }));
        });

        // Set global additional checks from first combo
        if (!globalAdditionalChecks) {
          globalAdditionalChecks = {
            is404,
            pageLoadTimeMs,
            adParamCheck: {
              originalParams: originalAdParams,
              finalParams: finalAdParams,
              preserved: adParamComparison.preserved,
              missingParams: adParamComparison.missingParams,
            },
            brokenImages,
            consoleErrors: [],
          };
        }

        // Wait for page to stabilize
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // All variant combos on Chrome Desktop, first combo only on other browsers
        // For now, only test the first variant combination across all browser combos.
        // TODO: re-enable all-variant testing on Chrome Desktop once rate-limiting is handled.
        const runAllVariants = false;
        const variantResults = await executeFlowWithVariants(page, flowConfig, {
          comboName: combo.name,
          evidenceDir,
          enableEvidence: input.enableEvidence ?? false,
          enableGeminiVerification: true,
        }, input.pageUrl, runAllVariants);

        // Close context (saves video recording)
        await context.close();

        // Collect local evidence paths for this combo
        const comboScreenshotDir = join(evidenceDir, combo.name.replace(/\s+/g, "_").toLowerCase(), "screenshots");

        // Create one SimulationResult per variant combination
        let anyFailed = false;
        for (const vr of variantResults) {
          const result: SimulationResult = {
            flowType: flowConfig.flow_type,
            comboName: combo.name,
            browser: combo.browser,
            device: combo.device,
            variantCombination: vr.variantCombination,
            overallSuccess: vr.flowResult.overallSuccess,
            adParamsPreserved: adParamComparison.preserved,
            steps: vr.flowResult.steps,
            pageLoadTimeMs,
            consoleErrors: consoleErrors.map((e) => e.message),
            evidenceUrls: [],
            durationMs: Date.now() - comboStart,
          };
          simulationResults.push(result);
          if (!vr.flowResult.overallSuccess) anyFailed = true;
        }

        if (anyFailed) {
          // Log local evidence paths for failed combos
          const failedSteps = variantResults
            .flatMap((vr) => vr.flowResult.steps)
            .filter((s) => !s.success && s.screenshotPath);

          logger.info("Evidence captured for failed combo", {
            combo: combo.name,
            screenshotDir: comboScreenshotDir,
            videoDir: videoConfig.recordVideo.dir,
            failedScreenshots: failedSteps.map((s) => s.screenshotPath),
          });
        }

        // Upload evidence if any variant combo failed
        if (anyFailed || input.enableEvidence) {
          try {
            const urls = await uploadEvidenceDirectory(
              evidenceDir,
              `ass-bot-evidence/${input.adId}/${startTime}/${combo.name.replace(/\s+/g, "_").toLowerCase()}`
            );
            allEvidenceUrls.push(...urls);
            // Attach evidence URLs to the failed results for this browser combo
            for (const sr of simulationResults.filter(
              (r) => r.comboName === combo.name && !r.overallSuccess
            )) {
              sr.evidenceUrls = urls;
            }
            logger.info("Evidence uploaded for combo", {
              combo: combo.name,
              uploadedFiles: urls.length,
            });
          } catch (err) {
            logger.warn("Failed to upload evidence", { error: String(err) });
          }
        }
      } catch (err) {
        logger.error("Combo execution failed", {
          combo: combo.name,
          error: String(err),
        });

        simulationResults.push({
          flowType: flowConfig.flow_type,
          comboName: combo.name,
          browser: combo.browser,
          device: combo.device,
          overallSuccess: false,
          adParamsPreserved: false,
          steps: [],
          pageLoadTimeMs: 0,
          consoleErrors: [String(err)],
          evidenceUrls: [],
          durationMs: Date.now() - comboStart,
        });
      } finally {
        if (browser) {
          await browser.close().catch(() => {});
        }
      }
    }

    logger.info("Evidence saved locally", { evidenceDir });

    const result: ExecutionResult = {
      simulationResults,
      additionalChecks: globalAdditionalChecks ?? {
        is404: false,
        pageLoadTimeMs: 0,
        adParamCheck: null,
        brokenImages: [],
        consoleErrors: [],
      },
      evidenceUrls: allEvidenceUrls,
    };

    logger.info("Stage 3: Execution complete", {
      totalCombos: BROWSER_DEVICE_COMBOS.length,
      successful: simulationResults.filter((r) => r.overallSuccess).length,
      failed: simulationResults.filter((r) => !r.overallSuccess).length,
      durationMs: Date.now() - startTime,
    });

    // Build the report
    const report = {
      generatedAt: new Date().toISOString(),
      pageUrl: flowConfig.pageUrl,
      flowType: flowConfig.flow_type,
      totalCombos: BROWSER_DEVICE_COMBOS.length,
      successful: simulationResults.filter((r) => r.overallSuccess).length,
      failed: simulationResults.filter((r) => !r.overallSuccess).length,
      durationMs: Date.now() - startTime,
      combos: simulationResults.map((r) => {
        const failedStep = r.steps.find((s) => !s.success);
        return {
          combo: r.comboName,
          variant: r.variantCombination ?? "no variants",
          success: r.overallSuccess,
          adParamsPreserved: r.adParamsPreserved,
          pageLoadTimeMs: r.pageLoadTimeMs,
          durationMs: r.durationMs,
          stepsCompleted: r.steps.filter((s) => s.success).length,
          totalSteps: r.steps.length,
          failedStep: failedStep
            ? {
                index: failedStep.stepIndex,
                description: failedStep.description,
                error: failedStep.errorMessage,
              }
            : null,
          consoleErrors: r.consoleErrors,
          evidenceUrls: r.evidenceUrls,
        };
      }),
      additionalChecks: result.additionalChecks,
    };

    // Save report JSON locally
    const reportPath = join(evidenceDir, "report.json");
    await writeFile(reportPath, JSON.stringify(report, null, 2));

    logger.info("Stage 3: Report saved", { reportPath });
    logger.info("Stage 3: Full report", { report });

    return {
      success: true,
      data: result,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    logger.error("Stage 3 failed", { error: String(err) });
    return {
      success: false,
      data: null,
      error: String(err),
      durationMs: Date.now() - startTime,
    };
  }
}
