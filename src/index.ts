import { runPipeline, rerunPipeline } from "./pipeline.js";
import type { PipelineInput, PipelineOutput } from "./types/index.js";
import { env } from "./config/env.js";
import { logger } from "./utils/logger.js";

// Re-exports for programmatic use
export { runPipeline, rerunPipeline };
export type { PipelineInput, PipelineOutput };
export type { FlowConfig, FlowStep, FlowAction } from "./types/index.js";

const server = Bun.serve({
  port: env.PORT,

  async fetch(req) {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === "/health" && req.method === "GET") {
      return Response.json({ status: "ok", timestamp: new Date().toISOString() });
    }

    // Full pipeline run
    if (url.pathname === "/api/run" && req.method === "POST") {
      try {
        const input = (await req.json()) as PipelineInput;

        if (!input.pageUrl || !input.adId || !input.clientWebsite) {
          return Response.json(
            { error: "Missing required fields: pageUrl, adId, clientWebsite" },
            { status: 400 }
          );
        }

        // Set default prompt if not provided
        input.prompt = input.prompt || "Analyze product page purchase flow";

        logger.info("POST /api/run", { adId: input.adId, pageUrl: input.pageUrl });
        const output = await runPipeline(input);
        return Response.json(output);
      } catch (err) {
        logger.error("POST /api/run error", { error: String(err) });
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    // Re-run with existing config
    if (url.pathname === "/api/rerun" && req.method === "POST") {
      try {
        const input = (await req.json()) as PipelineInput;

        if (!input.pageUrl || !input.adId || !input.clientWebsite) {
          return Response.json(
            { error: "Missing required fields: pageUrl, adId, clientWebsite" },
            { status: 400 }
          );
        }

        input.prompt = input.prompt || "Re-analyze product page purchase flow";

        logger.info("POST /api/rerun", { adId: input.adId, pageUrl: input.pageUrl });
        const output = await rerunPipeline(input);
        return Response.json(output);
      } catch (err) {
        logger.error("POST /api/rerun error", { error: String(err) });
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

logger.info(`Server running on port ${server.port}`);
