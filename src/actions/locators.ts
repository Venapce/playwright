// How a step names an element.
//
// The recorder (`playwright codegen`, `playwright-cli recording-start`) emits
// semantic locators — getByRole, getByLabel, getByPlaceholder — not CSS, because
// they survive markup churn that a CSS path does not. A step therefore accepts
// the same vocabulary:
//
//   { "do": "click", "role": "button", "name": "Sign in" }
//   { "do": "fill",  "label": "Password", "value": "…" }
//   { "do": "click", "testId": "submit" }
//   { "do": "click", "selector": "#still-works" }
//
// Nesting (codegen's `page.locator('.card').getByRole('button')`) is expressed as
// a chain, each segment scoped inside the previous one:
//
//   { "do": "click", "locator": [ { "selector": ".card" },
//                                 { "role": "button", "name": "Buy" } ] }

import type { Locator, Page } from "playwright";

import { bool, int, str } from "../browser/profile.js";

/** A value that may have been recorded as a regular expression. */
type Matcher = string | RegExp;

/** The keys that name an element, in the order they are tried. */
const BY_KEYS = ["selector", "role", "label", "placeholder", "text", "altText", "title", "testId"] as const;

/**
 * Resolve a step's locator. `spec` is either one segment (the flat, common case)
 * or `{ locator: [segment, …] }` for a scoped chain. Throws when the step names
 * no element, so a typo fails the step instead of silently acting on the body.
 */
export function resolveLocator(page: Page, spec: Record<string, unknown>, verb: string): Locator {
  const segments = segmentsOf(spec, verb);

  let current: Locator | undefined;
  for (const segment of segments) {
    current = applySegment(page, current, segment, verb);
  }
  if (!current) throw new Error(`${verb} needs an element: give "selector", "role", "label", "text", "testId" or "locator"`);
  return current;
}

/** Whether a step names an element at all — used to tell page-level verbs apart. */
export function namesElement(spec: Record<string, unknown>): boolean {
  if (Array.isArray(spec.locator) && spec.locator.length > 0) return true;
  return BY_KEYS.some((k) => spec[k] !== undefined && spec[k] !== null && spec[k] !== "");
}

// segmentsOf normalises either shape into a list of segments.
function segmentsOf(spec: Record<string, unknown>, verb: string): Record<string, unknown>[] {
  if (Array.isArray(spec.locator)) {
    if (spec.locator.length === 0) throw new Error(`${verb} has an empty "locator" chain`);
    return spec.locator.map((segment, i) => {
      if (typeof segment === "string") return { selector: segment };
      if (typeof segment !== "object" || segment === null || Array.isArray(segment)) {
        throw new Error(`${verb}: locator segment ${i + 1} must be an object or a selector string`);
      }
      return segment as Record<string, unknown>;
    });
  }
  return [spec];
}

// applySegment narrows `parent` (or the page) by one segment, then applies the
// segment's filters and index.
function applySegment(
  page: Page,
  parent: Locator | undefined,
  segment: Record<string, unknown>,
  verb: string,
): Locator {
  const root: Pick<Page, "locator" | "getByRole" | "getByLabel" | "getByPlaceholder" | "getByText" | "getByAltText" | "getByTitle" | "getByTestId"> =
    parent ?? page;

  const exact = segment.exact === undefined ? undefined : bool(segment.exact, false);
  let locator: Locator | undefined;

  const selector = str(segment.selector);
  if (selector !== "") {
    locator = root.locator(selector);
  } else if (segment.role !== undefined && str(segment.role) !== "") {
    const name = matcherOf(segment.name);
    // The role string is handed to Playwright as-is; an unknown role is its
    // error to report, with the full list of valid roles.
    locator = root.getByRole(str(segment.role) as Parameters<Page["getByRole"]>[0], {
      ...(name === undefined ? {} : { name }),
      ...(exact === undefined ? {} : { exact }),
    });
  } else if (has(segment, "label")) {
    locator = root.getByLabel(must(matcherOf(segment.label), "label", verb), opts(exact));
  } else if (has(segment, "placeholder")) {
    locator = root.getByPlaceholder(must(matcherOf(segment.placeholder), "placeholder", verb), opts(exact));
  } else if (has(segment, "text")) {
    locator = root.getByText(must(matcherOf(segment.text), "text", verb), opts(exact));
  } else if (has(segment, "altText")) {
    locator = root.getByAltText(must(matcherOf(segment.altText), "altText", verb), opts(exact));
  } else if (has(segment, "title")) {
    locator = root.getByTitle(must(matcherOf(segment.title), "title", verb), opts(exact));
  } else if (has(segment, "testId")) {
    locator = root.getByTestId(must(matcherOf(segment.testId), "testId", verb));
  }

  if (!locator) {
    throw new Error(
      `${verb} needs an element: give "selector", "role", "label", "placeholder", "text", "altText", "title", "testId" or "locator"`,
    );
  }

  locator = filtered(locator, segment);
  return indexed(locator, segment, verb);
}

// filtered applies codegen's .filter({ hasText }) / .filter({ hasNotText }).
function filtered(locator: Locator, segment: Record<string, unknown>): Locator {
  const hasText = matcherOf(segment.hasText);
  if (hasText !== undefined) locator = locator.filter({ hasText });
  const hasNotText = matcherOf(segment.hasNotText);
  if (hasNotText !== undefined) locator = locator.filter({ hasNotText });
  return locator;
}

// indexed applies first / last / nth. Without one, a step that matches several
// elements takes the first, which is what the recorder's code does too.
function indexed(locator: Locator, segment: Record<string, unknown>, verb: string): Locator {
  if (bool(segment.last, false)) return locator.last();
  if (segment.nth !== undefined && str(segment.nth) !== "") {
    const n = int(segment.nth, 0, "nth");
    if (n < 0) throw new Error(`${verb}: nth must not be negative`);
    return locator.nth(n);
  }
  return locator.first();
}

/**
 * Read a value the recorder may have written as a regular expression. In JSON a
 * regex is `{ "regex": "Sign in", "flags": "i" }`, since JSON has no literal for
 * one.
 */
export function matcherOf(value: unknown): Matcher | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const source = str(obj.regex);
    if (source === "") return undefined;
    try {
      return new RegExp(source, str(obj.flags) || undefined);
    } catch (e) {
      throw new Error(`invalid regex ${JSON.stringify(source)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const s = typeof value === "string" ? value : str(value);
  return s === "" ? undefined : s;
}

function has(segment: Record<string, unknown>, key: string): boolean {
  const v = segment[key];
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  return true;
}

function must(m: Matcher | undefined, key: string, verb: string): Matcher {
  if (m === undefined) throw new Error(`${verb} has an empty "${key}"`);
  return m;
}

function opts(exact: boolean | undefined): { exact?: boolean } {
  return exact === undefined ? {} : { exact };
}
