// Session lifetime, login throttling, rate limits and photo auth, against the
// real handler and a throwaway SQLite database.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp, type App } from "./app.ts";
import { SESSION_TTL_MS } from "./account-routes.ts";
import { clientAddress, createRateLimiter } from "./rate-limit.ts";

let app: App;
let server: Server;
let base: string;
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "wearroute-auth-"));
  app = createApp(join(dir, "test.db"), { autoSweep: false });
  server = createServer(app.handle);
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  base = `http://localhost:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
  app.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

async function register(email: string): Promise<string> {
  const res = await call("POST", "/api/register", {
    email,
    password: "correct-horse",
    name: "Anna",
    gender: "female",
    age: 28,
    heightCm: 168,
    weightKg: 55,
  });
  assert.equal(res.status, 201);
  return res.body.token;
}

function sessions() {
  return new DatabaseSync(join(dir, "test.db"));
}

test("an expired session is rejected and an active one slides forward", async () => {
  const token = await register("expiry@example.com");
  const db = sessions();
  try {
    db.prepare(`UPDATE sessions SET expires_at = ? WHERE token = ?`).run(Date.now() + 60_000, token);
    assert.equal((await call("GET", "/api/me", undefined, token)).status, 200);
    const renewed = db.prepare(`SELECT expires_at FROM sessions WHERE token = ?`).get(token) as {
      expires_at: number;
    };
    assert.ok(renewed.expires_at > Date.now() + SESSION_TTL_MS - 60_000, "used session renewed");

    db.prepare(`UPDATE sessions SET expires_at = ? WHERE token = ?`).run(Date.now() - 1, token);
    assert.equal((await call("GET", "/api/me", undefined, token)).status, 401);
  } finally {
    db.close();
  }
});

test("login attempts are throttled per account", async () => {
  await register("throttle@example.com");
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) {
    statuses.push(
      (await call("POST", "/api/login", { email: "Throttle@example.com", password: "wrong" })).status
    );
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
  const blocked = await call("POST", "/api/login", { email: "throttle@example.com", password: "correct-horse" });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
});

test("the unauthenticated personal-colour helper is rate limited before it runs", async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) {
    statuses.push((await call("POST", "/api/personal-color/analyze", { image: "x" })).status);
  }
  // Without VISION_API_KEY the handler answers 503; the 11th call never reaches it.
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(503));
  assert.equal(statuses[10], 429);
});

test("wardrobe photos no longer accept a session token in the URL", async () => {
  const token = await register("photo@example.com");
  const res = await fetch(`${base}/api/wardrobe/photo/missing?token=${token}`);
  assert.equal(res.status, 401);
  assert.equal((await call("GET", "/api/wardrobe/photo/missing", undefined, token)).status, 404);
});

test("X-Forwarded-For is only trusted behind a proxy", () => {
  const req = {
    headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.7" },
    socket: { remoteAddress: "10.0.0.1" },
  } as unknown as IncomingMessage;
  assert.equal(clientAddress(req, false), "10.0.0.1");
  assert.equal(clientAddress(req, true), "203.0.113.7", "the hop the proxy appended");
});

test("a fixed window resets once it has passed", () => {
  let now = 0;
  const limiter = createRateLimiter(() => now);
  const limit = { max: 2, windowMs: 1_000 };
  assert.equal(limiter.hit("k", limit), 0);
  assert.equal(limiter.hit("k", limit), 0);
  assert.equal(limiter.hit("k", limit), 1);
  now = 1_000;
  assert.equal(limiter.hit("k", limit), 0);
});
