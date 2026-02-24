import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mcpTools, type MCPClientLike } from "@anthropic-ai/sdk/helpers/beta/mcp";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool.js";
import { logger } from "../utils/logger.js";

// Minimal set for page exploration + DOM inspection
const ALLOWED_TOOLS = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_select_option",
  "browser_wait_for",
  "browser_navigate_back",
]);

export interface MCPSession {
  mcpClient: Client;
  tools: BetaRunnableTool<Record<string, unknown>>[];
  disconnect: () => Promise<void>;
}

export async function createMCPSession(options?: {
  headless?: boolean;
}): Promise<MCPSession> {
  const headless = options?.headless ?? true;

  const args = ["@playwright/mcp"];
  if (headless) {
    args.push("--headless");
  }

  logger.info("Spawning Playwright MCP server", { headless });

  const transport = new StdioClientTransport({
    command: "npx",
    args,
    stderr: "pipe",
  });

  const mcpClient = new Client({
    name: "ass-bot-agentic",
    version: "1.0.0",
  });

  await mcpClient.connect(transport);
  logger.info("Connected to MCP server");

  const { tools: allTools } = await mcpClient.listTools();
  const filteredTools = allTools.filter((t) => ALLOWED_TOOLS.has(t.name));
  const tools = mcpTools(filteredTools, mcpClient as unknown as MCPClientLike);

  logger.info("Loaded MCP tools", {
    total: allTools.length,
    using: tools.length,
    names: filteredTools.map((t) => t.name),
  });

  async function disconnect() {
    logger.info("Disconnecting MCP session");
    await mcpClient.close();
  }

  return { mcpClient, tools, disconnect };
}
