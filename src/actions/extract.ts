// Selector-based extraction: the declaration that turns a loaded page into the
// structured object a flow can actually branch on, instead of a wall of HTML.
//
// A field map is JSON, one entry per output key:
//
//   { "heading": "h1",
//     "price":   { "selector": ".price", "attr": "data-value" },
//     "links":   { "selector": "a", "attr": "href", "all": true } }
//
// A bare string is the selector with defaults. `attr` reads an attribute instead
// of the text ("html" and "text" are understood too); `all` collects every match
// into an array rather than taking the first.

import type { Page } from "playwright";

import { bool, str } from "../browser/profile.js";

/** One output key's extraction rule. */
interface FieldSpec {
  selector: string;
  attr: string;
  all: boolean;
  required: boolean;
}

/** Read a field map into rules, rejecting a malformed one. */
export function parseFields(value: unknown, field = "fields"): Record<string, FieldSpec> {
  if (value === null || value === undefined) return {};

  let raw: unknown = value;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (text === "") return {};
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new Error(`${field} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${field} must be a JSON object of name -> selector`);
  }

  const out: Record<string, FieldSpec> = {};
  for (const [name, spec] of Object.entries(raw as Record<string, unknown>)) {
    out[name] = parseFieldSpec(name, spec, field);
  }
  return out;
}

function parseFieldSpec(name: string, spec: unknown, field: string): FieldSpec {
  if (typeof spec === "string") {
    const selector = spec.trim();
    if (selector === "") throw new Error(`${field}.${name} has an empty selector`);
    return { selector, attr: "text", all: false, required: false };
  }
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    throw new Error(`${field}.${name} must be a selector string or an object`);
  }
  const obj = spec as Record<string, unknown>;
  const selector = str(obj.selector);
  if (selector === "") throw new Error(`${field}.${name} is missing "selector"`);
  return {
    selector,
    attr: str(obj.attr) || "text",
    all: bool(obj.all, false),
    required: bool(obj.required, false),
  };
}

/**
 * Run every rule against the page. A field that matches nothing is `null` (or an
 * empty array when `all`), unless it was marked required — then the whole
 * extraction fails, so a silently empty result cannot pass for a successful one.
 */
export async function extractFields(
  page: Page,
  fields: Record<string, FieldSpec>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(fields)) {
    const locator = page.locator(spec.selector);
    const count = await locator.count();

    if (count === 0) {
      if (spec.required) throw new Error(`no element matched ${name} (${spec.selector})`);
      out[name] = spec.all ? [] : null;
      continue;
    }

    if (spec.all) {
      const values: unknown[] = [];
      for (let i = 0; i < count; i++) values.push(await readOne(locator.nth(i), spec.attr));
      out[name] = values;
    } else {
      out[name] = await readOne(locator.first(), spec.attr);
    }
  }
  return out;
}

// readOne pulls one element's text, inner HTML, or a named attribute.
async function readOne(
  locator: ReturnType<Page["locator"]>,
  attr: string,
): Promise<string | null> {
  switch (attr.toLowerCase()) {
    case "":
    case "text":
    case "innertext":
      return (await locator.innerText()).trim();
    case "textcontent":
      return ((await locator.textContent()) ?? "").trim();
    case "html":
    case "innerhtml":
      return await locator.innerHTML();
    case "outerhtml":
      return await locator.evaluate((el) => (el as Element).outerHTML);
    case "value":
      return await locator.inputValue();
    default:
      return await locator.getAttribute(attr);
  }
}
