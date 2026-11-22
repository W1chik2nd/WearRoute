import { scrypt, randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import {
  PROFILE_COLUMNS,
  profileOptionsPayload,
  validateProfile,
  type ProfileValues,
} from "./profile.ts";
import type { AsyncValue } from "./async-value.ts";
import { LOGIN_PER_EMAIL, tooManyRequests, type RateLimiter } from "./rate-limit.ts";

export type UserRow = {
  id: string;
  email: string;
  name: string;
  pass_salt: string;
  pass_hash: string;
  gender: string | null;
  age: number | null;
  height_cm: number | null;
  weight_kg: number | null;
  bust_cm: number | null;
  waist_cm: number | null;
  hip_cm: number | null;
  body_type: string | null;
  season_color_type: string | null;
  style_prefs: string | null;
  wear_feel: string | null;
  wear_feel_other: string | null;
  travel_habits: string | null;
  travel_habits_other: string | null;
  style: string | null;
};

type Json = (res: ServerResponse, status: number, body: unknown) => void;
type ReadBody = (req: IncomingMessage, maxBytes?: number) => Promise<any>;
type Handle = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  json: Json,
  readBody: ReadBody,
  limiter: RateLimiter
) => Promise<boolean>;

export type AccountService = {
  handle: Handle;
  userForRequest: (req: IncomingMessage) => AsyncValue<UserRow | null>;
  userForToken: (token: string | undefined) => AsyncValue<UserRow | null>;
  /** Background jobs act for a user without a request (trip-jobs.ts). */
  userById: (id: string) => AsyncValue<UserRow | null>;
  updateProfile: (userId: string, values: ProfileValues) => AsyncValue<PublicUser>;
};

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number
) => Promise<Buffer>;

/**
 * scrypt is deliberately slow; the synchronous version blocked the event
 * loop, so every login attempt stalled every other request on the server.
 */
export const hashPassword = (password: string, salt: string) =>
  scryptAsync(password, salt, 64);

/** Sessions last 30 days and slide forward while in use. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Renew at most once a day, so reads do not turn into writes. */
export const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

/** Shared login throttle for both account stores; true when rejected. */
export function loginThrottled(
  limiter: RateLimiter,
  email: string,
  res: ServerResponse,
  json: Json
): boolean {
  const wait = limiter.hit(`login ${email.trim().toLowerCase()}`, LOGIN_PER_EMAIL);
  if (wait === 0) return false;
  tooManyRequests(res, json, wait);
  return true;
}

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    age: u.age,
    heightCm: u.height_cm,
    weightKg: u.weight_kg,
    style: u.style,
    gender: u.gender,
    bustCm: u.bust_cm,
    waistCm: u.waist_cm,
    hipCm: u.hip_cm,
    bodyType: u.body_type,
    seasonColorType: u.season_color_type,
    stylePrefs: u.style_prefs ? JSON.parse(u.style_prefs) : [],
    wearFeel: u.wear_feel ? JSON.parse(u.wear_feel) : [],
    wearFeelOther: u.wear_feel_other,
    travelHabits: u.travel_habits ? JSON.parse(u.travel_habits) : [],
    travelHabitsOther: u.travel_habits_other,
  };
}

export type PublicUser = ReturnType<typeof publicUser>;

export function createAccountService(db: DatabaseSync): AccountService {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL, pass_salt TEXT NOT NULL, pass_hash TEXT NOT NULL,
      age INTEGER, height_cm REAL, weight_kg REAL, style TEXT, gender TEXT,
      bust_cm REAL, waist_cm REAL, hip_cm REAL, body_type TEXT,
      season_color_type TEXT, style_prefs TEXT, wear_feel TEXT,
      wear_feel_other TEXT, travel_habits TEXT, travel_habits_other TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const sessionColumns = new Set(
    (db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]).map(
      (column) => column.name
    )
  );
  if (!sessionColumns.has("expires_at")) {
    // Sessions used to live forever; existing ones get a normal lifetime.
    db.exec(`ALTER TABLE sessions ADD COLUMN expires_at INTEGER`);
    db.prepare(`UPDATE sessions SET expires_at = ? WHERE expires_at IS NULL`).run(
      Date.now() + SESSION_TTL_MS
    );
  }
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).map(
      (column) => column.name
    )
  );
  for (const [column, type] of PROFILE_COLUMNS) {
    if (!existing.has(column)) db.exec(`ALTER TABLE users ADD COLUMN ${column} ${type}`);
  }

  function bearerToken(req: IncomingMessage): string | undefined {
    const auth = req.headers.authorization;
    return auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  }

  function userForToken(token: string | undefined): UserRow | null {
    if (!token) return null;
    const now = Date.now();
    const session = db
      .prepare(`SELECT user_id, expires_at FROM sessions WHERE token = ? AND expires_at > ?`)
      .get(token, now) as { user_id: string; expires_at: number } | undefined;
    if (!session) return null;
    if (session.expires_at - now < SESSION_TTL_MS - SESSION_RENEW_AFTER_MS) {
      db.prepare(`UPDATE sessions SET expires_at = ? WHERE token = ?`).run(
        now + SESSION_TTL_MS,
        token
      );
    }
    return (
      (db.prepare(`SELECT * FROM users WHERE id = ?`).get(session.user_id) as
        | UserRow
        | undefined) ?? null
    );
  }

  function createSession(userId: string): string {
    const token = randomBytes(32).toString("hex");
    const now = Date.now();
    db.prepare(`DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?`).run(userId, now);
    db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`).run(
      token,
      userId,
      now + SESSION_TTL_MS
    );
    return token;
  }

  function updateProfile(userId: string, values: ProfileValues): PublicUser {
    const columns = Object.keys(values);
    db.prepare(
      `UPDATE users SET ${columns.map((column) => `${column} = ?`).join(", ")}
        WHERE id = ?`
    ).run(...columns.map((column) => values[column]), userId);
    const updated = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as UserRow;
    return publicUser(updated);
  }

  const handle: Handle = async (req, res, url, json, readBody, limiter) => {
    if (req.method === "POST" && url.pathname === "/api/check-email") {
      const { email } = await readBody(req);
      if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
        json(res, 400, { error: "Please enter a valid email address." });
        return true;
      }
      if (db.prepare(`SELECT 1 FROM users WHERE email = ?`).get(email.trim())) {
        json(res, 409, { error: "An account with this email already exists." });
        return true;
      }
      json(res, 200, { ok: true });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/profile-options") {
      json(res, 200, profileOptionsPayload());
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/register") {
      const body = await readBody(req);
      const { email, password } = body;
      if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
        json(res, 400, { error: "Please enter a valid email address." });
        return true;
      }
      if (typeof password !== "string" || password.length < 8) {
        json(res, 400, { error: "Password must be at least 8 characters." });
        return true;
      }
      const profile = validateProfile(body);
      if (profile.ok === false) {
        json(res, 400, { error: profile.error });
        return true;
      }
      if (db.prepare(`SELECT 1 FROM users WHERE email = ?`).get(email.trim())) {
        json(res, 409, { error: "An account with this email already exists." });
        return true;
      }
      const id = randomUUID();
      const salt = randomBytes(16).toString("hex");
      const hash = (await hashPassword(password, salt)).toString("hex");
      const columns = Object.keys(profile.values);
      db.prepare(
        `INSERT INTO users (id, email, pass_salt, pass_hash, ${columns.join(", ")})
         VALUES (?, ?, ?, ?, ${columns.map(() => "?").join(", ")})`
      ).run(
        id,
        email.trim(),
        salt,
        hash,
        ...columns.map((column) => profile.values[column])
      );
      const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow;
      json(res, 201, { token: createSession(id), user: publicUser(user) });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      const { email, password } = await readBody(req);
      if (typeof email !== "string" || typeof password !== "string") {
        json(res, 400, { error: "Email and password are required." });
        return true;
      }
      if (loginThrottled(limiter, email, res, json)) return true;
      const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email.trim()) as
        | UserRow
        | undefined;
      if (!user) {
        json(res, 401, { error: "Incorrect email or password." });
        return true;
      }
      const expected = Buffer.from(user.pass_hash, "hex");
      const actual = await hashPassword(password, user.pass_salt);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        json(res, 401, { error: "Incorrect email or password." });
        return true;
      }
      json(res, 200, { token: createSession(user.id), user: publicUser(user) });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
      const user = userForToken(bearerToken(req));
      if (!user) {
        json(res, 401, { error: "Not signed in." });
        return true;
      }
      json(res, 200, { user: publicUser(user) });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      const token = bearerToken(req);
      if (token) db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
      json(res, 200, { ok: true });
      return true;
    }

    if (req.method === "PUT" && url.pathname === "/api/profile") {
      const user = userForToken(bearerToken(req));
      if (!user) {
        json(res, 401, { error: "Not signed in." });
        return true;
      }
      const profile = validateProfile(await readBody(req));
      if (profile.ok === false) {
        json(res, 400, { error: profile.error });
        return true;
      }
      json(res, 200, { user: updateProfile(user.id, profile.values) });
      return true;
    }

    return false;
  };

  return {
    handle,
    userForRequest: (req) => userForToken(bearerToken(req)),
    userForToken,
    userById: (id) =>
      (db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined) ?? null,
    updateProfile,
  };
}
