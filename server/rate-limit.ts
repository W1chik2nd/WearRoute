// Request rate limits for the routes that cost money or invite brute force.
//
// The threat is concrete: registration is open, several routes forward to
// paid AI providers (and the personal-colour helper needs no account at all),
// and login had no limit. A fixed window per key in memory is enough for one
// Render instance; it resets on restart, which only ever loosens it briefly.
import type { IncomingMessage, ServerResponse } from "node:http";

export type Limit = { max: number; windowMs: number };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Per-client limits by route. Generous for real use, tight for scripts. */
const ROUTE_LIMITS: Record<string, Limit> = {
  "POST /api/login": { max: 20, windowMs: 15 * MINUTE },
  "POST /api/register": { max: 30, windowMs: HOUR },
  "POST /api/check-email": { max: 60, windowMs: HOUR },
  "POST /api/personal-color/analyze": { max: 10, windowMs: HOUR },
  "POST /api/wardrobe/recognize": { max: 60, windowMs: HOUR },
  "POST /api/upload-session/photo": { max: 60, windowMs: HOUR },
  "POST /api/chat": { max: 60, windowMs: HOUR },
  "POST /api/translate": { max: 300, windowMs: HOUR },
  "POST /api/trip-plans/generate": { max: 10, windowMs: HOUR },
  "GET /api/places": { max: 120, windowMs: HOUR },
};

/** Whole-service caps for routes reachable without an account. */
const GLOBAL_LIMITS: Record<string, Limit> = {
  "POST /api/personal-color/analyze": { max: 300, windowMs: 24 * HOUR },
};

/** Failed-or-not attempts per account, so a botnet cannot spread guesses. */
export const LOGIN_PER_EMAIL: Limit = { max: 10, windowMs: 15 * MINUTE };

export type RateLimiter = {
  /** Count one hit; returns the seconds to wait when over the limit, else 0. */
  hit: (key: string, limit: Limit) => number;
};

export function createRateLimiter(now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    hit(key, limit) {
      const t = now();
      if (windows.size > 50_000) {
        for (const [k, w] of windows) if (w.resetAt <= t) windows.delete(k);
      }
      const current = windows.get(key);
      if (!current || current.resetAt <= t) {
        windows.set(key, { count: 1, resetAt: t + limit.windowMs });
        return 0;
      }
      current.count += 1;
      return current.count > limit.max ? Math.ceil((current.resetAt - t) / 1000) : 0;
    },
  };
}

/**
 * The client address. Behind Render's proxy the socket peer is the proxy, so
 * the last X-Forwarded-For hop (the one the proxy appended) is used. Without
 * a proxy that header is client-controlled and is ignored.
 */
export function clientAddress(
  req: IncomingMessage,
  trustProxy = Boolean(process.env.RENDER || process.env.TRUST_PROXY === "1")
): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (trustProxy && typeof forwarded === "string") {
    const hops = forwarded.split(",").map((hop) => hop.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function tooManyRequests(
  res: ServerResponse,
  json: (res: ServerResponse, status: number, body: unknown) => void,
  retryAfter: number
): void {
  res.setHeader("Retry-After", String(retryAfter));
  json(res, 429, { error: "Too many requests. Please wait a moment and try again." });
}

/** Apply the route table; true when the request was rejected. */
export function rejectIfRateLimited(
  limiter: RateLimiter,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  json: (res: ServerResponse, status: number, body: unknown) => void
): boolean {
  const route = `${req.method} ${pathname}`;
  const perClient = ROUTE_LIMITS[route];
  if (!perClient) return false;
  const global = GLOBAL_LIMITS[route];
  const wait =
    limiter.hit(`${route} ${clientAddress(req)}`, perClient) ||
    (global ? limiter.hit(`${route} *`, global) : 0);
  if (wait === 0) return false;
  tooManyRequests(res, json, wait);
  return true;
}
