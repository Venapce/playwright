// Turn a recording into steps.
//
// Playwright's recorders — `npx playwright codegen` and
// `npx playwright cli recording-start/recording-stop` — emit Playwright code:
//
//   await page.goto('https://example.com/login');
//   await page.getByRole('textbox', { name: 'Email' }).fill('user@example.com');
//   await page.getByRole('button', { name: 'Sign In' }).click();
//
// This converts that into the plugin's steps array, keeping the semantic
// locators intact rather than degrading them to CSS:
//
//   [ { "do": "goto", "url": "https://example.com/login" },
//     { "do": "fill", "role": "textbox", "name": "Email", "value": "user@example.com" },
//     { "do": "click", "role": "button", "name": "Sign In" } ]
//
// Anything it cannot convert is reported, never dropped silently — a recording
// that half-converted without saying so would be worse than one that refused.

import { LiteralParseError, parseArgs } from "./literal.js";

/** One line the converter could not turn into a step. */
export interface SkippedLine {
  line: number;
  source: string;
  reason: string;
}

/** The result of converting a recording. */
export interface Conversion {
  steps: Record<string, unknown>[];
  skipped: SkippedLine[];
  /** Assertions found in the recording — steps cannot express them. */
  assertions: number;
  /** A one-line summary for the form or the terminal. */
  summary: string;
}

/** Locator-producing calls, mapped to the step key they set. */
const BY_CALLS: Record<string, string> = {
  getByRole: "role",
  getByLabel: "label",
  getByPlaceholder: "placeholder",
  getByText: "text",
  getByAltText: "altText",
  getByTitle: "title",
  getByTestId: "testId",
};

/** Lines that are scaffolding rather than actions. */
const IGNORED = [
  /^import\s/,
  /^(const|let|var)\s/,
  /^export\s/,
  /^test(\.\w+)*\s*\(/,
  /^(async\s+)?function\s/,
  /^\}/,
  /^\{/,
  /^\)/,
  /^;+$/,
  /^(await\s+)?(browser|context)\d*\.(close|newPage|newContext)\s*\(/,
  /^(await\s+)?page\d*\.(close|pause)\s*\(/,
  /^\/\//,
  /^\/\*/,
  /^\*/,
];

/** Convert a recorded script into steps. */
export function convertRecording(source: string): Conversion {
  const steps: Record<string, unknown>[] = [];
  const skipped: SkippedLine[] = [];
  let assertions = 0;

  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    let line = raw.trim();
    if (line === "") continue;

    // Strip a trailing comment, then the statement's own punctuation. The "//"
    // has to be found outside quotes, or every URL in the recording loses its
    // scheme.
    line = stripTrailingComment(line).trim();
    if (line === "") continue;
    if (IGNORED.some((re) => re.test(line))) continue;

    line = line.replace(/;+$/, "").trim();
    line = line.replace(/^await\s+/, "").trim();

    if (/^expect\s*\(/.test(line) || /^await\s*expect\s*\(/.test(line)) {
      assertions++;
      continue;
    }

    const match = line.match(/^(page\d*)\.(.+)$/);
    if (!match) {
      skipped.push({ line: i + 1, source: raw.trim(), reason: "not a page action" });
      continue;
    }

    try {
      const step = convertChain(match[2]);
      if (step) steps.push(step);
      else skipped.push({ line: i + 1, source: raw.trim(), reason: "no equivalent step" });
    } catch (e) {
      skipped.push({
        line: i + 1,
        source: raw.trim(),
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { steps, skipped, assertions, summary: summarize(steps, skipped, assertions) };
}

/**
 * Remove a trailing `//` line comment, ignoring any `//` that sits inside a
 * string — `page.goto('https://example.com')` is not a comment.
 */
function stripTrailingComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote !== "") {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      continue;
    }
    if (c === "/" && line[i + 1] === "/") return line.slice(0, i);
  }
  return line;
}

/** One call in a method chain: `getByRole('button', {…})` or a bare `keyboard`. */
interface Segment {
  name: string;
  args: unknown[];
  /** True for a property access with no call, e.g. `page.keyboard.press(…)`. */
  property: boolean;
}

// convertChain parses everything after `page.` and builds one step.
function convertChain(rest: string): Record<string, unknown> | null {
  const segments = scanChain(rest);
  if (segments.length === 0) return null;

  const action = segments[segments.length - 1];
  const locatorSegments = segments.slice(0, -1);

  // page.keyboard.press('Enter') — a page-level action behind a property.
  if (locatorSegments.length === 1 && locatorSegments[0].property) {
    return pageLevelAction(locatorSegments[0].name, action);
  }
  if (locatorSegments.some((s) => s.property)) {
    throw new Error(`unsupported chain "${locatorSegments.map((s) => s.name).join(".")}"`);
  }

  if (locatorSegments.length === 0) return pageAction(action);

  const locator = buildLocator(locatorSegments);
  return elementAction(action, locator);
}

// scanChain walks `getByRole('button', { name: 'x' }).click()` into segments,
// respecting strings and nested parens so a label containing ")" cannot split it.
function scanChain(input: string): Segment[] {
  const segments: Segment[] = [];
  let i = 0;

  while (i < input.length) {
    const start = i;
    while (i < input.length && /[\w$]/.test(input[i])) i++;
    const name = input.slice(start, i);
    if (name === "") throw new Error(`could not read a method name at ${start} in ${JSON.stringify(input)}`);

    if (input[i] === "(") {
      const argsSource = readBalanced(input, i);
      i += argsSource.length + 2; // the parens
      segments.push({ name, args: parseArgsSafely(argsSource, name), property: false });
    } else {
      segments.push({ name, args: [], property: true });
    }

    if (input[i] === ".") {
      i++;
      continue;
    }
    if (i >= input.length) break;
    throw new Error(`unexpected ${JSON.stringify(input.slice(i, i + 12))} after ${name}()`);
  }
  return segments;
}

// readBalanced returns the text inside the parens starting at `open`.
function readBalanced(input: string, open: number): string {
  let depth = 0;
  let quote = "";
  for (let i = open; i < input.length; i++) {
    const c = input[i];
    if (quote !== "") {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return input.slice(open + 1, i);
    }
  }
  throw new Error("unbalanced parentheses");
}

function parseArgsSafely(source: string, name: string): unknown[] {
  try {
    return parseArgs(source);
  } catch (e) {
    if (e instanceof LiteralParseError) throw new Error(`could not read the arguments of ${name}(): ${e.message}`);
    throw e;
  }
}

// buildLocator turns the locator part of a chain into a step's locator fields.
// A single segment becomes flat keys (the common case); a scoped chain becomes
// the "locator" array.
function buildLocator(segments: Segment[]): Record<string, unknown> {
  const specs: Record<string, unknown>[] = [];

  for (const segment of segments) {
    const { name, args } = segment;

    if (name === "filter") {
      const spec = specs[specs.length - 1];
      if (!spec) throw new Error("filter() with nothing to filter");
      const opts = asObject(args[0]);
      if (opts.hasText !== undefined) spec.hasText = opts.hasText;
      if (opts.hasNotText !== undefined) spec.hasNotText = opts.hasNotText;
      if (opts.has !== undefined || opts.hasNot !== undefined) {
        throw new Error('filter({ has: … }) has no step equivalent — use a "locator" chain');
      }
      continue;
    }
    if (name === "first") {
      continue; // the default
    }
    if (name === "last") {
      requireLast(specs, "last()").last = true;
      continue;
    }
    if (name === "nth") {
      requireLast(specs, "nth()").nth = args[0];
      continue;
    }
    if (name === "locator") {
      const spec: Record<string, unknown> = { selector: args[0] };
      const opts = asObject(args[1]);
      if (opts.hasText !== undefined) spec.hasText = opts.hasText;
      specs.push(spec);
      continue;
    }
    const key = BY_CALLS[name];
    if (!key) throw new Error(`unsupported locator ${name}()`);

    const spec: Record<string, unknown> = {};
    if (key === "role") {
      spec.role = args[0];
      const opts = asObject(args[1]);
      if (opts.name !== undefined) spec.name = opts.name;
      if (opts.exact !== undefined) spec.exact = opts.exact;
      if (opts.checked !== undefined || opts.pressed !== undefined || opts.expanded !== undefined) {
        throw new Error("getByRole state options (checked/pressed/expanded) have no step equivalent");
      }
    } else {
      spec[key] = args[0];
      const opts = asObject(args[1]);
      if (opts.exact !== undefined) spec.exact = opts.exact;
    }
    specs.push(spec);
  }

  if (specs.length === 0) throw new Error("no locator in the chain");
  return specs.length === 1 ? specs[0] : { locator: specs };
}

function requireLast(specs: Record<string, unknown>[], what: string): Record<string, unknown> {
  const spec = specs[specs.length - 1];
  if (!spec) throw new Error(`${what} with no locator before it`);
  return spec;
}

// elementAction maps a locator action onto a step.
function elementAction(action: Segment, locator: Record<string, unknown>): Record<string, unknown> | null {
  const { name, args } = action;
  const opts = asObject(args[args.length - 1]);
  const timeout = opts.timeout === undefined ? {} : { timeout: opts.timeout };

  switch (name) {
    case "click":
      if (opts.button !== undefined && opts.button !== "left") {
        throw new Error(`click({ button: '${String(opts.button)}' }) has no step equivalent`);
      }
      return { do: "click", ...locator, ...timeout };
    case "dblclick":
      return { do: "dblclick", ...locator, ...timeout };
    case "fill":
      return { do: "fill", ...locator, value: args[0], ...timeout };
    case "clear":
      return { do: "fill", ...locator, value: "", ...timeout };
    case "type":
    case "pressSequentially":
      return { do: "type", ...locator, value: args[0], ...timeout };
    case "press":
      return { do: "press", ...locator, key: args[0], ...timeout };
    case "check":
      return { do: "check", ...locator, ...timeout };
    case "uncheck":
      return { do: "uncheck", ...locator, ...timeout };
    case "setChecked":
      return { do: args[0] === false ? "uncheck" : "check", ...locator, ...timeout };
    case "hover":
      return { do: "hover", ...locator, ...timeout };
    case "selectOption":
      return { do: "select", ...locator, value: selectValue(args[0]), ...timeout };
    case "screenshot":
      return { do: "screenshot", ...locator, ...(opts.fullPage === undefined ? {} : { fullPage: opts.fullPage }) };
    case "waitFor":
      return { do: "waitForSelector", ...locator, ...(opts.state === undefined ? {} : { state: opts.state }), ...timeout };
    case "setInputFiles":
      throw new Error("setInputFiles() has no step equivalent — file upload is not a step verb");
    case "scrollIntoViewIfNeeded":
      throw new Error('scrollIntoViewIfNeeded() has no step equivalent — use { "do": "scroll" }');
    case "dragTo":
      throw new Error("dragTo() has no step equivalent");
    case "focus":
    case "blur":
    case "tap":
    case "evaluate":
      throw new Error(`${name}() has no step equivalent`);
    default:
      return null;
  }
}

// pageAction maps a page-level call onto a step.
function pageAction(action: Segment): Record<string, unknown> | null {
  const { name, args } = action;
  const opts = asObject(args[args.length - 1]);

  switch (name) {
    case "goto":
      return {
        do: "goto",
        url: args[0],
        ...(opts.waitUntil === undefined ? {} : { waitUntil: opts.waitUntil }),
      };
    case "waitForURL":
      return { do: "waitForURL", url: args[0], ...(opts.waitUntil === undefined ? {} : { waitUntil: opts.waitUntil }) };
    case "waitForLoadState":
      return { do: "waitForLoadState", ...(args[0] === undefined ? {} : { state: args[0] }) };
    case "waitForTimeout":
      return { do: "waitForTimeout", ms: args[0] };
    case "screenshot":
      return { do: "screenshot", ...(opts.fullPage === undefined ? {} : { fullPage: opts.fullPage }) };
    case "goBack":
    case "goForward":
    case "reload":
      throw new Error(`page.${name}() has no step equivalent`);
    case "setViewportSize":
      throw new Error("setViewportSize() belongs in the browser profile, not a step");
    case "evaluate":
      throw new Error('page.evaluate() needs a script string — add it as { "do": "evaluate", "script": "…" } by hand');
    default:
      return null;
  }
}

// pageLevelAction handles the property-then-call shapes: page.keyboard.press().
function pageLevelAction(property: string, action: Segment): Record<string, unknown> | null {
  if (property === "keyboard") {
    if (action.name === "press") return { do: "press", key: action.args[0] };
    if (action.name === "type" || action.name === "insertText") {
      throw new Error(`keyboard.${action.name}() has no step equivalent — type into an element instead`);
    }
    throw new Error(`keyboard.${action.name}() has no step equivalent`);
  }
  if (property === "mouse") throw new Error(`mouse.${action.name}() has no step equivalent`);
  throw new Error(`page.${property}.${action.name}() has no step equivalent`);
}

// selectValue normalises selectOption's many argument shapes to a value or list.
function selectValue(arg: unknown): unknown {
  if (Array.isArray(arg)) return arg.map((a) => selectValue(a));
  if (arg !== null && typeof arg === "object") {
    const obj = arg as Record<string, unknown>;
    if (obj.value !== undefined) return obj.value;
    if (obj.label !== undefined) {
      throw new Error("selectOption({ label }) has no step equivalent — use the option's value");
    }
    if (obj.index !== undefined) {
      throw new Error("selectOption({ index }) has no step equivalent — use the option's value");
    }
  }
  return arg;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function summarize(steps: unknown[], skipped: SkippedLine[], assertions: number): string {
  const parts = [`${steps.length} step${steps.length === 1 ? "" : "s"}`];
  if (skipped.length > 0) parts.push(`${skipped.length} line${skipped.length === 1 ? "" : "s"} not converted`);
  if (assertions > 0) parts.push(`${assertions} assertion${assertions === 1 ? "" : "s"} dropped`);
  return parts.join(", ");
}

/**
 * Render steps as the JSON to paste into the Steps field: one step per line, so
 * a recorded flow stays readable and reviewable.
 */
export function renderSteps(steps: Record<string, unknown>[]): string {
  if (steps.length === 0) return "[]";
  return "[\n" + steps.map((s) => "  " + JSON.stringify(s)).join(",\n") + "\n]";
}
