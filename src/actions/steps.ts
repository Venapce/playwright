// The scripted flow: a list of steps run in order against one page, so a login,
// a form submission or a paginated read is one node instead of a chain of them.
//
// Steps are JSON, each an object with a "do":
//
//   [ { "do": "goto",   "url": "https://example.com/login" },
//     { "do": "fill",   "selector": "#user", "value": "{{$.secrets.user}}" },
//     { "do": "fill",   "selector": "#pass", "value": "{{$.secrets.pass}}" },
//     { "do": "click",  "selector": "button[type=submit]" },
//     { "do": "waitForSelector", "selector": ".dashboard" },
//     { "do": "extract", "as": "account", "fields": { "name": ".account-name" } } ]
//
// Anything a step names with "as" lands in the result under that key; the step
// log is returned either way, so a flow that fails mid-way says which step and
// on what.

import type { Job } from "@inflowenger/node-plugin-sdk";
import type { Page } from "playwright";

import { bool, int, str } from "../browser/profile.js";
import { extractFields, parseFields } from "./extract.js";
import { namesElement, resolveLocator } from "./locators.js";

/** What a finished run reports back. */
export interface StepsResult {
  /** One entry per step attempted, in order. */
  log: StepLog[];
  /** Values collected by `extract` / `evaluate` steps, keyed by their "as". */
  data: Record<string, unknown>;
  /** Base64 images collected by `screenshot` steps, keyed by their "as". */
  screenshots: Record<string, string>;
  /** How many steps ran to completion. */
  completed: number;
}

interface StepLog {
  index: number;
  do: string;
  ok: boolean;
  detail?: string;
  ms: number;
  error?: string;
}

const WAIT_UNTIL = ["load", "domcontentloaded", "networkidle", "commit"] as const;
type WaitUntil = (typeof WAIT_UNTIL)[number];

const SELECTOR_STATES = ["attached", "detached", "visible", "hidden"] as const;
type SelectorState = (typeof SELECTOR_STATES)[number];

/** Read the steps input into a list of plain step objects. */
export function parseSteps(value: unknown): Record<string, unknown>[] {
  let raw: unknown = value;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (text === "") throw new Error("missing required input: steps");
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new Error(`steps is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!Array.isArray(raw)) throw new Error("steps must be a JSON array of step objects");
  if (raw.length === 0) throw new Error("steps is empty");

  return raw.map((s, i) => {
    if (typeof s !== "object" || s === null || Array.isArray(s)) {
      throw new Error(`step ${i + 1} must be an object`);
    }
    const step = s as Record<string, unknown>;
    if (str(step.do) === "") throw new Error(`step ${i + 1} is missing "do"`);
    return step;
  });
}

/**
 * Run every step in order. The first failure stops the run and throws, with the
 * log so far attached to the error as `partial` — the caller decides whether to
 * commit it, because a flow that got halfway often still has something the rest
 * of the graph needs.
 */
export async function runSteps(
  job: Job,
  page: Page,
  steps: Record<string, unknown>[],
  opts: { continueOnError: boolean },
): Promise<StepsResult> {
  const result: StepsResult = { log: [], data: {}, screenshots: {}, completed: 0 };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const verb = str(step.do);
    const started = Date.now();

    // 10..90 across the run, so the canvas shows a flow moving rather than one
    // long silence.
    const pct = Math.min(90, 10 + Math.round(((i + 1) / steps.length) * 80));
    await job.progress(pct, { title: `step ${i + 1}/${steps.length}`, content: describeStep(verb, step) });

    try {
      const detail = await runStep(page, verb, step, result);
      result.log.push({ index: i + 1, do: verb, ok: true, detail, ms: Date.now() - started });
      result.completed++;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      result.log.push({
        index: i + 1,
        do: verb,
        ok: false,
        ms: Date.now() - started,
        error: firstLine(error),
      });
      if (!opts.continueOnError) {
        const failure = new StepError(`step ${i + 1} (${verb}) failed: ${firstLine(error)}`, result);
        throw failure;
      }
    }
  }

  return result;
}

/** A step failure that carries everything the run had collected before it. */
export class StepError extends Error {
  constructor(
    message: string,
    readonly partial: StepsResult,
  ) {
    super(message);
    this.name = "StepError";
  }
}

// runStep performs one step and returns a short line for the log.
async function runStep(
  page: Page,
  verb: string,
  step: Record<string, unknown>,
  result: StepsResult,
): Promise<string | undefined> {
  const timeout = optionalTimeout(step);

  switch (verb.toLowerCase()) {
    case "goto": {
      const url = requireStr(step.url, "url", verb);
      const res = await page.goto(url, { waitUntil: waitUntilOf(step), timeout });
      return `${url} -> ${res ? res.status() : "no response"}`;
    }

    case "click": {
      await resolveLocator(page, step, verb).click({ timeout });
      return describeTarget(step);
    }

    case "dblclick": {
      await resolveLocator(page, step, verb).dblclick({ timeout });
      return describeTarget(step);
    }

    case "fill": {
      await resolveLocator(page, step, verb).fill(str(step.value), { timeout });
      return describeTarget(step);
    }

    case "type": {
      await resolveLocator(page, step, verb).pressSequentially(str(step.value), {
        delay: int(step.delay, 0, "delay") || undefined,
        timeout,
      });
      return describeTarget(step);
    }

    case "press": {
      const key = requireStr(step.key, "key", verb);
      // Without an element the key goes to the page, which is what the
      // recorder emits for page.keyboard.press().
      if (!namesElement(step)) {
        await page.keyboard.press(key);
        return key;
      }
      await resolveLocator(page, step, verb).press(key, { timeout });
      return `${key} on ${describeTarget(step)}`;
    }

    case "select": {
      const values = Array.isArray(step.value)
        ? (step.value as unknown[]).map((v) => str(v))
        : [requireStr(step.value, "value", verb)];
      const picked = await resolveLocator(page, step, verb).selectOption(values, { timeout });
      return `${describeTarget(step)} -> ${picked.join(", ")}`;
    }

    case "check":
    case "uncheck": {
      const locator = resolveLocator(page, step, verb);
      if (verb.toLowerCase() === "check") await locator.check({ timeout });
      else await locator.uncheck({ timeout });
      return describeTarget(step);
    }

    case "hover": {
      await resolveLocator(page, step, verb).hover({ timeout });
      return describeTarget(step);
    }

    case "waitforselector": {
      await resolveLocator(page, step, verb).waitFor({ state: selectorStateOf(step), timeout });
      return describeTarget(step);
    }

    case "waitforurl": {
      const url = requireStr(step.url, "url", verb);
      await page.waitForURL(url, { waitUntil: waitUntilOf(step), timeout });
      return url;
    }

    case "waitforloadstate": {
      await page.waitForLoadState(loadStateOf(step), { timeout });
      return str(step.state) || "load";
    }

    case "waittimeout":
    case "waitfortimeout": {
      const ms = int(step.ms, 0, "ms");
      if (ms <= 0) throw new Error(`${verb} needs a positive "ms"`);
      await page.waitForTimeout(ms);
      return `${ms}ms`;
    }

    case "scroll": {
      const to = str(step.to) || "bottom";
      const pixels = int(step.pixels, 0, "pixels");
      await page.evaluate(
        ({ to, pixels }) => {
          if (to === "top") window.scrollTo(0, 0);
          else if (to === "bottom") window.scrollTo(0, document.body.scrollHeight);
          else window.scrollBy(0, pixels);
        },
        { to, pixels },
      );
      return to === "top" || to === "bottom" ? to : `${pixels}px`;
    }

    case "screenshot": {
      const as = str(step.as) || `step${result.log.length + 1}`;
      const buffer = !namesElement(step)
        ? await page.screenshot({ fullPage: bool(step.fullPage, false), timeout })
        : await resolveLocator(page, step, verb).screenshot({ timeout });
      result.screenshots[as] = buffer.toString("base64");
      return `${as} (${buffer.length} bytes)`;
    }

    case "extract": {
      const as = str(step.as) || "extracted";
      const fields = parseFields(step.fields, `step.fields`);
      if (Object.keys(fields).length === 0) throw new Error('extract needs a "fields" map');
      result.data[as] = await extractFields(page, fields);
      return `${as} (${Object.keys(fields).length} fields)`;
    }

    case "evaluate": {
      const script = requireStr(step.script, "script", verb);
      const as = str(step.as);
      const value = await page.evaluate(script);
      if (as !== "") result.data[as] = value ?? null;
      return as === "" ? "ok" : as;
    }

    default:
      throw new Error(
        `unknown step "${verb}": expected goto, click, dblclick, fill, type, press, select, check, uncheck, hover, waitForSelector, waitForURL, waitForLoadState, waitForTimeout, scroll, screenshot, extract or evaluate`,
      );
  }
}

// --------------------------------------------------------------- helpers --

function requireStr(v: unknown, field: string, verb: string): string {
  const s = str(v);
  if (s === "") throw new Error(`${verb} needs "${field}"`);
  return s;
}

function optionalTimeout(step: Record<string, unknown>): number | undefined {
  const ms = int(step.timeout, 0, "timeout");
  return ms > 0 ? ms : undefined;
}

function waitUntilOf(step: Record<string, unknown>): WaitUntil | undefined {
  const value = str(step.waitUntil).toLowerCase();
  if (value === "") return undefined;
  if ((WAIT_UNTIL as readonly string[]).includes(value)) return value as WaitUntil;
  throw new Error(`unknown waitUntil ${JSON.stringify(value)}: expected ${WAIT_UNTIL.join(", ")}`);
}

function selectorStateOf(step: Record<string, unknown>): SelectorState | undefined {
  const value = str(step.state).toLowerCase();
  if (value === "") return undefined;
  if ((SELECTOR_STATES as readonly string[]).includes(value)) return value as SelectorState;
  throw new Error(`unknown state ${JSON.stringify(value)}: expected ${SELECTOR_STATES.join(", ")}`);
}

function loadStateOf(step: Record<string, unknown>): "load" | "domcontentloaded" | "networkidle" {
  const value = str(step.state).toLowerCase();
  if (value === "") return "load";
  if (value === "load" || value === "domcontentloaded" || value === "networkidle") return value;
  throw new Error(`unknown load state ${JSON.stringify(value)}: expected load, domcontentloaded or networkidle`);
}

function describeStep(verb: string, step: Record<string, unknown>): string {
  const target = str(step.url) || describeTarget(step) || str(step.key) || str(step.as);
  return target === "" ? verb : `${verb} ${truncate(target, 90)}`;
}

/**
 * Name a step's element the way the step wrote it, so the log and the progress
 * frame read like the recording did — "button \"Sign in\"", not a CSS path the
 * author never typed.
 */
function describeTarget(step: Record<string, unknown>): string {
  if (Array.isArray(step.locator)) {
    return step.locator
      .map((segment) =>
        typeof segment === "string" ? segment : describeTarget(segment as Record<string, unknown>),
      )
      .filter(Boolean)
      .join(" » ");
  }
  const selector = str(step.selector);
  if (selector !== "") return selector;
  if (str(step.role) !== "") {
    const name = matcherText(step.name);
    return name === "" ? `role=${str(step.role)}` : `${str(step.role)} "${name}"`;
  }
  for (const key of ["label", "placeholder", "text", "altText", "title", "testId"] as const) {
    const value = matcherText(step[key]);
    if (value !== "") return `${key}="${value}"`;
  }
  return "";
}

// matcherText renders a locator value that may be a { regex } object.
function matcherText(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const source = str((value as Record<string, unknown>).regex);
    return source === "" ? "" : `/${source}/`;
  }
  return str(value);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function firstLine(msg: string): string {
  const line = msg.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? msg;
  return truncate(line, 300);
}
