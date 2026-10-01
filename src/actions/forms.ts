// Every form this plugin serves, declared with the SDK's formkit builder, which
// generates the JSON Schema and the JSON Forms UI Schema from one statement per
// field. A malformed form throws at start-up (build calls validate), where it is
// a programming mistake rather than a dialog that will not open.

import { formkit } from "@inflowenger/node-plugin-sdk";

const descUrl =
  "Page to open, e.g. https://example.com/pricing. Accepts {{$.path}} tokens, so the URL can come from upstream: https://api.example.com/users/{{$.trigger.userId}}.";

const descFields =
  'Optional JSON map of output name → CSS selector, turning the page into a structured result instead of raw HTML: {"heading":"h1","price":{"selector":".price","attr":"data-value"},"links":{"selector":"a","attr":"href","all":true}}. Use "attr" to read an attribute ("html", "text" and "value" are understood too), "all": true to collect every match, and "required": true to fail the node when a selector matches nothing.';

const descWaitUntil =
  "When navigation is considered finished. load waits for the load event, domcontentloaded is earlier and faster, networkidle waits for the network to go quiet (best for single-page apps), commit returns as soon as the response arrives.";

const descWaitForSelector =
  "Optional CSS selector to wait for after the page loads, before anything is read. The way to scrape content a script renders after navigation.";

const waitUntilChoices = [
  { value: "", label: "(default — load)" },
  { value: "load", label: "load" },
  { value: "domcontentloaded", label: "domcontentloaded (faster)" },
  { value: "networkidle", label: "networkidle (SPAs)" },
  { value: "commit", label: "commit (headers only)" },
];

// ---------------------------------------------------------------- settings --

/**
 * The browser profile the platform stores and ships with every call as
 * body.settings. The plugin keeps nothing: a proxy password lives in the
 * platform's profile store, not here.
 */
export const settingsForm = formkit
  .form("Browser profile")
  .describe(
    "Stored by the platform as a reusable settings profile and shipped with every call as body.settings. Leave it empty for a headless Chromium with sane defaults — every field below is optional.",
  )
  .submitTo("playwright.meta.browser.check")
  .add(
    formkit
      .choice(
        "engine",
        "Engine",
        { value: "", label: "(default — Chromium)" },
        { value: "chromium", label: "Chromium" },
        { value: "firefox", label: "Firefox" },
        { value: "webkit", label: "WebKit (Safari)" },
      )
      .describe(
        "Which browser to drive. The engine must be installed on the host running this plugin — npx playwright install chromium (or firefox / webkit).",
      ),
    formkit
      .bool("headless", "Headless")
      .describe("Run with no visible window. Leave on unless this plugin runs on a desktop you are watching.")
      .default(true),
    formkit
      .text("endpoint", "Remote browser endpoint")
      .describe(
        "Optional. Drive a browser that lives somewhere else instead of launching one here: a ws:// or wss:// Playwright server endpoint, or an http:// Chrome DevTools Protocol endpoint (Chromium only). Given, no browser is installed or launched on this host.",
      ),
  )
  .group(
    "Page defaults",
    formkit
      .integer("viewportWidth", "Viewport width")
      .describe("Window width in pixels. Defaults to 1280.")
      .default(1280),
    formkit
      .integer("viewportHeight", "Viewport height")
      .describe("Window height in pixels. Defaults to 800.")
      .default(800),
    formkit
      .text("userAgent", "User agent")
      .describe("Optional override for the browser's User-Agent header."),
    formkit.text("locale", "Locale").describe("Optional, e.g. en-GB or de-DE. Affects Accept-Language and formatting."),
    formkit
      .text("timezoneId", "Timezone")
      .describe("Optional IANA timezone, e.g. Europe/Berlin — what the page's Date sees."),
    formkit
      .bool("ignoreHTTPSErrors", "Ignore HTTPS errors")
      .describe("Accept self-signed and expired certificates. Needed for internal staging hosts.")
      .default(false),
    formkit
      .bool("javaScriptEnabled", "JavaScript enabled")
      .describe("Turn off to fetch server-rendered HTML only — faster, and enough for many scrapes.")
      .default(true),
  )
  .group(
    "Timeouts",
    formkit
      .integer("navigationTimeoutMs", "Navigation timeout (ms)")
      .describe("How long a page load may take before the node fails. Defaults to 30000.")
      .default(30000),
    formkit
      .integer("actionTimeoutMs", "Action timeout (ms)")
      .describe("How long one click, fill or wait may take. Defaults to 15000.")
      .default(15000),
  )
  .group(
    "Network",
    formkit
      .text("proxyServer", "Proxy server")
      .describe("Optional, e.g. http://proxy.internal:8080 or socks5://127.0.0.1:1080."),
    formkit.text("proxyUsername", "Proxy username"),
    formkit.secret("proxyPassword", "Proxy password"),
    formkit
      .text("proxyBypass", "Proxy bypass")
      .describe('Comma-separated hosts to reach directly, e.g. "localhost, .internal".'),
    formkit
      .textArea("extraHTTPHeaders", "Extra HTTP headers")
      .describe('Optional JSON object sent with every request, e.g. {"Authorization":"Bearer …"}.'),
    formkit
      .textArea("storageState", "Storage state")
      .describe(
        'Optional Playwright storage state JSON ({"cookies":[…],"origins":[…]}) — the way to start every page already signed in, instead of scripting a login each time. Produce it once with "npx playwright codegen --save-storage=state.json" and paste it here.',
      ),
    // The button hangs off the last field and its answer appears under it, so a
    // missing browser or an unreachable endpoint is reported while the profile
    // is being entered rather than by every node that later fails.
    formkit
      .text("test", "Test browser")
      .describe("Press ↻ to launch (or reach) this browser and report its version before saving.")
      .lookup("playwright.meta.browser.check", "Test browser"),
  );

// ----------------------------------------------------------------- actions --

export const scrapeForm = formkit
  .form("Open page")
  .describe("Navigate to a URL in a fresh, isolated browser context and read what loaded.")
  .add(
    formkit.text("url", "URL").describe(descUrl).required(),
    formkit.choice("waitUntil", "Wait until", ...waitUntilChoices).describe(descWaitUntil),
    formkit.text("waitForSelector", "Wait for selector").describe(descWaitForSelector),
    formkit.textArea("fields", "Extract fields").describe(descFields),
  )
  .group(
    "What to return",
    formkit
      .bool("includeText", "Include page text")
      .describe("Return the page's visible text. Good input for an LLM node; large on a long page.")
      .default(true),
    formkit
      .bool("includeHtml", "Include page HTML")
      .describe("Return the full rendered HTML. Exact, but big — prefer Extract fields when you know what you want.")
      .default(false),
    formkit
      .bool("includeLinks", "Include links")
      .describe("Return every link on the page as {text, href}.")
      .default(false),
    formkit
      .integer("maxChars", "Max characters")
      .describe("Truncate the returned text and HTML to this many characters. 0 means no limit. Defaults to 50000.")
      .default(50000),
  )
  .build();

export const screenshotForm = formkit
  .form("Screenshot")
  .describe("Open a page and capture it as a base64 PNG or JPEG.")
  .add(
    formkit.text("url", "URL").describe(descUrl).required(),
    formkit.choice("waitUntil", "Wait until", ...waitUntilChoices).describe(descWaitUntil),
    formkit.text("waitForSelector", "Wait for selector").describe(descWaitForSelector),
    formkit
      .text("selector", "Element selector")
      .describe("Optional CSS selector — capture just this element instead of the page."),
    formkit
      .bool("fullPage", "Full page")
      .describe("Capture the whole scrollable page rather than the viewport. Ignored when an element selector is set.")
      .default(false),
    formkit
      .choice(
        "format",
        "Format",
        { value: "", label: "(default — PNG)" },
        { value: "png", label: "PNG (lossless)" },
        { value: "jpeg", label: "JPEG (smaller)" },
      )
      .describe("PNG is exact; JPEG is much smaller, which matters because the image is returned inline as base64."),
    formkit
      .integer("quality", "JPEG quality")
      .describe("1–100, JPEG only. Defaults to 80.")
      .between(1, 100)
      .showWhen("format", "jpeg"),
  )
  .build();

export const pdfForm = formkit
  .form("Print to PDF")
  .describe("Open a page and print it to a PDF, returned as base64. Chromium only — Playwright cannot print in Firefox or WebKit.")
  .add(
    formkit.text("url", "URL").describe(descUrl).required(),
    formkit.choice("waitUntil", "Wait until", ...waitUntilChoices).describe(descWaitUntil),
    formkit.text("waitForSelector", "Wait for selector").describe(descWaitForSelector),
    formkit
      .choice(
        "format",
        "Paper size",
        { value: "", label: "(default — A4)" },
        { value: "A4", label: "A4" },
        { value: "A3", label: "A3" },
        { value: "A5", label: "A5" },
        { value: "Letter", label: "Letter" },
        { value: "Legal", label: "Legal" },
        { value: "Tabloid", label: "Tabloid" },
      ),
    formkit
      .choice(
        "orientation",
        "Orientation",
        { value: "", label: "(default — portrait)" },
        { value: "portrait", label: "Portrait" },
        { value: "landscape", label: "Landscape" },
      ),
    formkit
      .bool("printBackground", "Print backgrounds")
      .describe("Include background colours and images. Usually wanted, and off in Chromium by default.")
      .default(true),
    formkit
      .text("scale", "Scale")
      .describe("Render scale between 0.1 and 2 — 0.8 fits a wide page. Defaults to 1."),
    formkit.text("margin", "Margin").describe('Optional CSS length applied to all four sides, e.g. "1cm" or "0.5in".'),
  )
  .build();

export const evaluateForm = formkit
  .form("Evaluate JavaScript")
  .describe(
    "Open a page and run JavaScript inside it, returning whatever the expression evaluates to. The escape hatch for anything the other actions do not cover.",
  )
  .add(
    formkit.text("url", "URL").describe(descUrl).required(),
    formkit.choice("waitUntil", "Wait until", ...waitUntilChoices).describe(descWaitUntil),
    formkit.text("waitForSelector", "Wait for selector").describe(descWaitForSelector),
    formkit
      .textArea("script", "Script")
      .describe(
        'JavaScript evaluated in the page. The value of the last expression is returned and must be JSON-serializable, e.g. Array.from(document.querySelectorAll("h2")).map(h => h.innerText) or ({ count: document.images.length }). Accepts {{$.path}} tokens.',
      )
      .required(),
  )
  .build();

export const flowForm = formkit
  .form("Run browser flow")
  .describe(
    "Run an ordered list of browser steps against one page — sign in, fill a form, page through a table — as a single node, keeping the session across every step.",
  )
  .add(
    // The recorder writes Playwright code, not steps, so the conversion lives
    // here rather than in a README the author would have to go and find: paste,
    // press Convert, and the Steps field below is filled in.
    formkit
      .textArea("recording", "Recorded script")
      .describe(
        "Optional. Record the flow in a real browser with `npx playwright codegen <url>`, paste the generated code here, and press Convert — the Steps field below is filled in for you. Semantic locators (getByRole, getByLabel, getByTestId) are kept as they are, so the steps survive markup changes. Assertions and anything without a step equivalent are reported rather than silently dropped.",
      )
      .lookup("playwright.meta.steps.import", "Convert to steps")
      .into("steps"),
    formkit
      .textArea("steps", "Steps")
      .describe(
        'JSON array of steps, each with a "do". Example: [{"do":"goto","url":"https://example.com/login"},{"do":"fill","label":"Email","value":"{{$.secrets.user}}"},{"do":"fill","label":"Password","value":"{{$.secrets.pass}}"},{"do":"click","role":"button","name":"Sign in"},{"do":"waitForSelector","text":"Dashboard"},{"do":"extract","as":"account","fields":{"name":".account-name"}}]. Verbs: goto, click, dblclick, fill, type, press, select, check, uncheck, hover, waitForSelector, waitForURL, waitForLoadState, waitForTimeout, scroll, screenshot, extract, evaluate. Name the element with "role" (+ "name"), "label", "placeholder", "text", "altText", "title", "testId" or a CSS "selector" — prefer the semantic ones, which is what the recorder produces. Add "nth"/"last" to pick among matches, "hasText" to narrow, and a "locator" array to scope one inside another. Give a step an "as" and its result is returned under that name. Every string accepts {{$.path}} tokens.',
      )
      .required(),
    formkit
      .bool("continueOnError", "Continue on error")
      .describe("Keep going when a step fails instead of failing the node. The step log records what broke either way.")
      .default(false),
    formkit
      .bool("returnStorageState", "Return storage state")
      .describe(
        "Return the context's cookies and local storage when the flow finishes — paste it into a Browser profile's Storage state to skip the login next time.",
      )
      .default(false),
  )
  .build();
