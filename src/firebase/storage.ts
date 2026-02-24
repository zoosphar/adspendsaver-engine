import { getBucket } from "../config/firebase.js";
import { logger } from "../utils/logger.js";
import { readFile, unlink, readdir, stat } from "fs/promises";
import { join, basename } from "path";

export async function uploadEvidence(
  localPath: string,
  remotePath: string
): Promise<string> {
  const bucket = getBucket();
  const file = bucket.file(remotePath);
  const content = await readFile(localPath);

  await file.save(content, {
    metadata: {
      contentType: getContentType(localPath),
    },
  });

  await file.makePublic();
  const publicUrl = `https://storage.googleapis.com/${bucket.name}/${remotePath}`;
  logger.info("Uploaded evidence", { remotePath, publicUrl });
  return publicUrl;
}

export async function uploadEvidenceDirectory(
  localDir: string,
  remotePrefix: string
): Promise<string[]> {
  const urls: string[] = [];

  try {
    const entries = await readdir(localDir, { recursive: true });
    for (const entry of entries) {
      const filePath = typeof entry === "string" ? entry : entry;
      const localPath = join(localDir, filePath);

      // Skip directories
      const fileStat = await stat(localPath).catch(() => null);
      if (!fileStat || fileStat.isDirectory()) continue;

      const remotePath = `${remotePrefix}/${filePath}`;

      try {
        const url = await uploadEvidence(localPath, remotePath);
        urls.push(url);
      } catch (err) {
        logger.warn("Failed to upload evidence file", {
          localPath,
          error: String(err),
        });
      }
    }
  } catch (err) {
    logger.warn("Failed to read evidence directory", {
      localDir,
      error: String(err),
    });
  }

  return urls;
}

export async function deleteLocalEvidence(dirPath: string): Promise<void> {
  try {
    const entries = await readdir(dirPath, { recursive: true });
    for (const entry of entries) {
      const filePath = join(dirPath, typeof entry === "string" ? entry : entry);
      const fileStat = await stat(filePath).catch(() => null);
      if (fileStat?.isFile()) {
        await unlink(filePath).catch(() => {});
      }
    }
    logger.debug("Deleted local evidence", { dirPath });
  } catch {
    // Directory may not exist
  }
}

function getContentType(path: string): string {
  const ext = basename(path).split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "webm": return "video/webm";
    case "mp4": return "video/mp4";
    default: return "application/octet-stream";
  }
}
