import { getDb } from "../config/firebase.js";
import { COLLECTIONS, flowConfigDocId, runDocId, resultDocId } from "./collections.js";
import type { FlowConfig } from "../types/flow-config.js";
import type { PipelineOutput, PipelineInput } from "../types/pipeline.js";
import { logger } from "../utils/logger.js";

export async function saveFlowConfig(config: FlowConfig): Promise<string> {
  const db = getDb();
  const docId = flowConfigDocId(config.pageUrl);
  await db.collection(COLLECTIONS.FLOW_CONFIGS).doc(docId).set({
    ...config,
    updatedAt: new Date().toISOString(),
  });
  logger.info("Saved flow config", { docId, pageUrl: config.pageUrl });
  return docId;
}

export async function getFlowConfig(pageUrl: string): Promise<FlowConfig | null> {
  const db = getDb();
  const docId = flowConfigDocId(pageUrl);
  const doc = await db.collection(COLLECTIONS.FLOW_CONFIGS).doc(docId).get();
  if (!doc.exists) return null;
  return doc.data() as FlowConfig;
}

export async function createRun(
  input: PipelineInput,
  timestamp: number
): Promise<string> {
  const db = getDb();
  const docId = runDocId(input.adId, timestamp);
  await db.collection(COLLECTIONS.RUNS).doc(docId).set({
    adId: input.adId,
    pageUrl: input.pageUrl,
    clientWebsite: input.clientWebsite,
    status: "running",
    startedAt: new Date(timestamp).toISOString(),
    createdAt: new Date().toISOString(),
  });
  logger.info("Created run", { docId });
  return docId;
}

export async function updateRunStatus(
  docId: string,
  status: "completed" | "failed",
  durationMs?: number
): Promise<void> {
  const db = getDb();
  await db.collection(COLLECTIONS.RUNS).doc(docId).update({
    status,
    durationMs,
    completedAt: new Date().toISOString(),
  });
}

export async function saveResult(
  output: PipelineOutput,
  timestamp: number
): Promise<string> {
  const db = getDb();
  const docId = resultDocId(output.adId, timestamp);
  await db.collection(COLLECTIONS.RESULTS).doc(docId).set({
    ...output,
    savedAt: new Date().toISOString(),
  });
  logger.info("Saved result", { docId });
  return docId;
}
