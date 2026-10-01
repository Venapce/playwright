// Turns one call's settings profile into the shape the pool and the contexts
// need. The plugin stores none of this: the platform keeps it as a named
// settings profile and ships the values with every call as `body.settings`.

import type { BrowserContextOptions, LaunchOptions } from "playwright";

/** The browser engines Playwright ships. */
export type Engine = "chromium" | "firefox" | "webkit";

const ENGINES: readonly Engine[] = ["chromium", "firefox", "webkit"];

/**
 * A resolved browser profile — everything one call needs to reach a browser and
 * open a context in it. `key` is its identity for pooling: two calls with the
 * same key share a browser, and anything that can only be set at launch is part
 * of it.
 */
export interface Profile {
  engine: Engine;
  /**
   * Where to find the browser. Empty means launch one locally. A ws:// or wss://
   * endpoint is a Playwright server (`connect`); an http:// or https:// one is a
   * Chrome DevTools Protocol endpoint (`connectOverCDP`).
   */
  endpoint: string;
  headless: boolean;
  launchArgs: string[];
  proxy: LaunchOptions["proxy"];
  /** Per-context options, rebuilt for every job. */
  context: BrowserContextOptions;
  /** Default navigation deadline, in ms. */
  navigationTimeoutMs: number;
  /** Default deadline for a single action (click, fill, …), in ms. */
  actionTimeoutMs: number;
  /** Pooling identity — see Profile. */
  key: string;
  /** One short line naming the browser, for progress frames. */
  describe: string;
}

const DEFAULT_NAV_TIMEOUT_MS = 30_000;
const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

/**
 * Build a Profile from the settings values the platform shipped with the call.
 * Throws when a value is present but unusable — a bad profile is reported on the
 * node rather than silently falling back to a different browser.
 */
export function profileFrom(settings: Record<string, unknown> | undefined): Profile {
  const s = settings ?? {};

  const engine = engineFrom(str(s.engine));
  const endpoint = str(s.endpoint);
  if (endpoint !== "" && !/^(wss?|https?):\/\//i.test(endpoint)) {
    throw new Error(
      `remote endpoint must start with ws://, wss://, http:// or https://: ${JSON.stringify(endpoint)}`,
    );
  }

  const headless = bool(s.headless, true);
  const navigationTimeoutMs = millis(s.navigationTimeoutMs, DEFAULT_NAV_TIMEOUT_MS, "navigationTimeoutMs");
  const actionTimeoutMs = millis(s.actionTimeoutMs, DEFAULT_ACTION_TIMEOUT_MS, "actionTimeoutMs");
  const launchArgs = words(s.launchArgs);
  const proxy = proxyFrom(s);

  const context: BrowserContextOptions = {
    viewport: viewportFrom(s),
    ignoreHTTPSErrors: bool(s.ignoreHTTPSErrors, false),
    javaScriptEnabled: bool(s.javaScriptEnabled, true),
  };
  const userAgent = str(s.userAgent);
  if (userAgent !== "") context.userAgent = userAgent;
  const locale = str(s.locale);
  if (locale !== "") context.locale = locale;
  const timezoneId = str(s.timezoneId);
  if (timezoneId !== "") context.timezoneId = timezoneId;
  const headers = jsonObject(s.extraHTTPHeaders, "extraHTTPHeaders");
  if (headers) context.extraHTTPHeaders = stringMap(headers, "extraHTTPHeaders");
  const storageState = jsonObject(s.storageState, "storageState");
  if (storageState) context.storageState = storageState as BrowserContextOptions["storageState"];

  // Only what cannot change after the browser is up belongs in the key; context
  // options are applied per job and must not fragment the pool.
  const key = JSON.stringify([engine, endpoint, headless, launchArgs, proxy ?? null]);

  return {
    engine,
    endpoint,
    headless,
    launchArgs,
    proxy,
    context,
    navigationTimeoutMs,
    actionTimeoutMs,
    key,
    describe: describe(engine, endpoint, headless),
  };
}

function describe(engine: Engine, endpoint: string, headless: boolean): string {
  if (endpoint !== "") return `${engine} at ${endpoint}`;
  return `${engine} (${headless ? "headless" : "headed"})`;
}

function engineFrom(value: string): Engine {
  if (value === "") return "chromium";
  const lower = value.toLowerCase();
  if ((ENGINES as readonly string[]).includes(lower)) return lower as Engine;
  throw new Error(`unknown browser engine ${JSON.stringify(value)}: expected one of ${ENGINES.join(", ")}`);
}

function viewportFrom(s: Record<string, unknown>): BrowserContextOptions["viewport"] {
  const width = int(s.viewportWidth, 0, "viewportWidth");
  const height = int(s.viewportHeight, 0, "viewportHeight");
  if (width <= 0 && height <= 0) return DEFAULT_VIEWPORT;
  return {
    width: width > 0 ? width : DEFAULT_VIEWPORT.width,
    height: height > 0 ? height : DEFAULT_VIEWPORT.height,
  };
}

function proxyFrom(s: Record<string, unknown>): LaunchOptions["proxy"] {
  const server = str(s.proxyServer);
  if (server === "") return undefined;
  const proxy: NonNullable<LaunchOptions["proxy"]> = { server };
  const username = str(s.proxyUsername);
  if (username !== "") proxy.username = username;
  const password = str(s.proxyPassword);
  if (password !== "") proxy.password = password;
  const bypass = str(s.proxyBypass);
  if (bypass !== "") proxy.bypass = bypass;
  return proxy;
}

// ------------------------------------------------------------- scalars --

/** Trim a value to a string, treating anything non-string as absent. */
export function str(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

/** A boolean input, tolerating the "true"/"false" strings a form can send. */
export function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  const s = str(v).toLowerCase();
  if (s === "") return fallback;
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return fallback;
}

/** A whole number input. Throws when present but not a number. */
export function int(v: unknown, fallback: number, field: string): number {
  const s = str(v);
  if (s === "") return fallback;
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${field} must be a whole number: ${JSON.stringify(s)}`);
  }
  return n;
}

// millis reads a millisecond duration, refusing a negative one.
function millis(v: unknown, fallback: number, field: string): number {
  const n = int(v, fallback, field);
  if (n < 0) throw new Error(`${field} must not be negative: ${n}`);
  return n === 0 ? fallback : n;
}

// words splits a whitespace-separated flag list.
function words(v: unknown): string[] {
  const s = str(v);
  if (s === "") return [];
  return s.split(/\s+/).filter(Boolean);
}

/**
 * Parse a JSON object from a form field that may arrive as text or as an already
 * decoded object. Returns undefined when empty; throws when it is not an object.
 */
export function jsonObject(v: unknown, field: string): Record<string, unknown> | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "object" && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    return Object.keys(obj).length === 0 ? undefined : obj;
  }
  const s = str(v);
  if (s === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch (e) {
    throw new Error(`${field} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  return Object.keys(obj).length === 0 ? undefined : obj;
}

// stringMap flattens a parsed object into the string->string map headers need.
function stringMap(obj: Record<string, unknown>, field: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object") throw new Error(`${field}.${k} must be a scalar`);
    out[k] = String(v);
  }
  return out;
}
