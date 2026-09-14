import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { isAnalysisAborted } from "./abort.js";
import { getModelLabel, runAnalysis } from "./pipeline.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, "public");
const PORT = Number(process.env.PORT ?? 3456);
const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;

/** In-flight analysis (POC: one run at a time). Stop via POST /api/abort-analysis without closing SSE. */
let activeAnalysisAbort: AbortController | null = null;

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

function serveStatic(path: string, res: import("node:http").ServerResponse): void {
  if (!existsSync(path)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": contentType(path) });
  createReadStream(path).pipe(res);
}

async function parseMultipartAnalyze(
  req: import("node:http").IncomingMessage,
): Promise<{
  tempPath: string;
  tempDir: string;
  includePlacementSentiment: boolean;
  allowGoogleSearch: boolean;
}> {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.includes("multipart/form-data")) {
    throw new Error("Expected multipart/form-data upload");
  }

  const boundaryMatch = /boundary=(.+)$/i.exec(contentType);
  if (!boundaryMatch) throw new Error("Missing multipart boundary");
  const boundary = boundaryMatch[1].trim();

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_UPLOAD_BYTES) {
      throw new Error("Video file too large (max 80MB)");
    }
    chunks.push(buf);
  }

  const body = Buffer.concat(chunks);
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const parts = splitBuffer(body, boundaryBuf).filter((p) => p.length > 4);

  let includePlacementSentiment = false;
  let allowGoogleSearch = false;
  let videoPart: { headerText: string; fileData: Buffer } | null = null;

  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headerText = part.subarray(0, headerEnd).toString("utf8");
    const valueStart = headerEnd + 4;
    let valueEnd = part.length;
    if (part.subarray(valueEnd - 2).toString() === "\r\n") valueEnd -= 2;
    const value = part.subarray(valueStart, valueEnd);

    if (headerText.includes('name="includePlacement"')) {
      includePlacementSentiment = value.toString("utf8").trim() === "true";
      continue;
    }
    if (headerText.includes('name="allowGoogleSearch"')) {
      allowGoogleSearch = value.toString("utf8").trim() === "true";
      continue;
    }
    if (headerText.includes('name="video"') && value.length) {
      videoPart = { headerText, fileData: value };
    }
  }

  if (!videoPart) {
    throw new Error('No video file in form field "video"');
  }

  const tempDir = join(ROOT, ".tmp", randomUUID());
  await mkdir(tempDir, { recursive: true });
  const ext = videoPart.headerText.includes("video/mp4") ? ".mp4" : ".bin";
  const tempPath = join(tempDir, `upload${ext}`);
  await writeFile(tempPath, videoPart.fileData);
  return { tempPath, tempDir, includePlacementSentiment, allowGoogleSearch };
}

function splitBuffer(buf: Buffer, sep: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  let index = buf.indexOf(sep, start);
  while (index !== -1) {
    if (index > start) parts.push(buf.subarray(start, index));
    start = index + sep.length;
    index = buf.indexOf(sep, start);
  }
  if (start < buf.length) parts.push(buf.subarray(start));
  return parts;
}

createServer(async (req, res) => {
  const url = req.url ?? "/";

  if (req.method === "GET" && (url === "/" || url === "/index.html")) {
    serveStatic(join(PUBLIC, "index.html"), res);
    return;
  }

  if (req.method === "GET" && (url === "/styles.css" || url === "/app.js")) {
    serveStatic(join(PUBLIC, url.slice(1)), res);
    return;
  }

  if (req.method === "GET" && url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, model: getModelLabel() }));
    return;
  }

  if (req.method === "POST" && url === "/api/abort-analysis") {
    if (activeAnalysisAbort && !activeAnalysisAbort.signal.aborted) {
      activeAnalysisAbort.abort();
    }
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && url === "/api/analyze") {
    let tempDir: string | null = null;
    const abortController = new AbortController();
    let analysisFinished = false;

    /** Abort only when the client drops the SSE response — not when the upload body ends (`req` "close"). */
    const onClientDisconnect = () => {
      if (!analysisFinished && !abortController.signal.aborted) {
        abortController.abort();
      }
    };

    try {
      const { tempPath, tempDir: dir, includePlacementSentiment, allowGoogleSearch } =
        await parseMultipartAnalyze(req);
      tempDir = dir;

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.on("close", onClientDisconnect);
      activeAnalysisAbort = abortController;

      const send = (data: unknown) => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
      };

      const result = await runAnalysis(
        tempPath,
        (event) => {
          send({ type: "progress", event });
        },
        {
          signal: abortController.signal,
          includePlacementSentiment,
          allowGoogleSearch,
        },
      );

      analysisFinished = true;
      send({ type: "result", result });
      res.end();
    } catch (error) {
      if (isAnalysisAborted(error)) {
        if (res.headersSent && !res.writableEnded) {
          res.write(
            `data: ${JSON.stringify({ type: "cancelled", message: "Analysis stopped." })}\n\n`,
          );
          res.end();
        }
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      } else if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
        res.end();
      }
    } finally {
      if (activeAnalysisAbort === abortController) {
        activeAnalysisAbort = null;
      }
      res.removeListener("close", onClientDisconnect);
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
}).listen(PORT, () => {
  console.log(`Brand Placement Analysis: http://localhost:${PORT}`);
  console.log(`Model: ${getModelLabel()}`);
});
