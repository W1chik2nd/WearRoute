// JSON request bodies: the API's trust boundary for size and shape
// (AGENTS.md §4). Kept apart from app.ts so it can be tested on its own.
import type { IncomingMessage } from "node:http";

export class BodyTooLargeError extends Error {
  constructor() {
    super("body too large");
    this.name = "BodyTooLargeError";
  }
}

export class InvalidJsonError extends Error {
  constructor() {
    super("invalid JSON");
    this.name = "InvalidJsonError";
  }
}

/**
 * Read a JSON body of at most `maxBytes` bytes.
 *
 * Chunks are kept as bytes and decoded once at the end: decoding each chunk
 * separately corrupts any multi-byte character (most Chinese text) that a
 * network chunk boundary happens to split. Once the limit is passed nothing
 * more is buffered, so an oversized upload cannot grow memory; the caller
 * answers 413 and closes the connection.
 */
export function readJsonBody(
  req: IncomingMessage,
  maxBytes = 1_000_000
): Promise<any> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return Promise.reject(new BodyTooLargeError());
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(error);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        fail(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new InvalidJsonError());
      }
    });
    req.on("error", fail);
  });
}
