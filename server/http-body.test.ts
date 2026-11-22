import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request, type IncomingMessage } from "node:http";
import { readJsonBody, BodyTooLargeError } from "./http-body.ts";

/** Start a throwaway server that reports what readJsonBody returned. */
async function withServer(
  maxBytes: number,
  run: (port: number) => Promise<void>
): Promise<void> {
  const server = createServer(async (req: IncomingMessage, res) => {
    try {
      const body = await readJsonBody(req, maxBytes);
      res.end(JSON.stringify({ ok: true, body }));
    } catch (error) {
      if (error instanceof BodyTooLargeError) res.setHeader("Connection", "close");
      res.statusCode = error instanceof BodyTooLargeError ? 413 : 400;
      res.end(JSON.stringify({ ok: false }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    await run((server.address() as { port: number }).port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Send `parts` as separate writes so the server sees separate chunks. */
function send(
  port: number,
  parts: Buffer[],
  headers: Record<string, string | number> = {}
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { port, method: "POST", headers: { "Content-Type": "application/json", ...headers } },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
      }
    );
    req.on("error", reject);
    (async () => {
      for (const part of parts.slice(0, -1)) {
        req.write(part);
        await new Promise((r) => setTimeout(r, 20));
      }
      req.end(parts.at(-1));
    })();
  });
}

test("a Chinese character split across two chunks survives", async () => {
  await withServer(1_000, async (port) => {
    const body = Buffer.from(JSON.stringify({ notes: "京都两日游" }));
    const cut = body.indexOf(Buffer.from("都")) + 1;
    const res = await send(port, [body.subarray(0, cut), body.subarray(cut)]);
    assert.equal(res.status, 200);
    assert.equal(res.body.body.notes, "京都两日游");
  });
});

test("the limit counts bytes, not UTF-16 characters", async () => {
  await withServer(20, async (port) => {
    // 8 Chinese characters = 8 string characters but 24 bytes (+ JSON quotes).
    const res = await send(port, [Buffer.from(JSON.stringify("京都京都京都京都"))], {
      "Transfer-Encoding": "chunked",
    });
    assert.equal(res.status, 413);
  });
});

test("an oversized declared Content-Length is rejected before reading", async () => {
  await withServer(10, async (port) => {
    const payload = Buffer.from(JSON.stringify({ text: "x".repeat(50) }));
    const res = await send(port, [payload], { "Content-Length": payload.length });
    assert.equal(res.status, 413);
  });
});

test("malformed JSON is reported as invalid", async () => {
  await withServer(1_000, async (port) => {
    const res = await send(port, [Buffer.from("{not json")]);
    assert.equal(res.status, 400);
  });
});
