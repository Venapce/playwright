// Command playwright-plugin is an Inflowenger plugin node for Playwright.
//
// It exposes five actions on the workflow canvas — open and read a page,
// screenshot it, print it to PDF, evaluate JavaScript in it, and run a scripted
// browser flow — against a browser the platform ships with every call.
//
// The plugin holds no browser configuration. It declares what a browser profile
// needs (see the settings form); the platform stores that as a named settings
// profile and ships the values with every call as `body.settings`.
//
// Being a long-lived process is the point: the browser is launched once per
// distinct profile and kept warm, while every job gets its own BrowserContext,
// so jobs stay isolated without paying for a launch each time.

import { newPlugin, withDotEnv, withTimeout } from "@inflowenger/node-plugin-sdk";

import { Registry } from "./actions/registry.js";

const version = "v0.1.0";

// Browser work is slow — a cold launch plus a networkidle wait on a heavy page
// runs well past the SDK's 5s default reply deadline. Raise it so a slow page
// arrives as a real result or error rather than a bare NATS "TIMEOUT".
// REQ_TIMEOUT overrides it.
const SEND_TIMEOUT_SECONDS = 180;

async function main() {
  const envFile = process.env.INFLOW_ENV_FILE || ".env.inflow";

  // The dotenv carries the platform identity only — PLUGIN_ID, INFRA_CRED,
  // INFRA_URL. Proxy credentials and storage state never live here; they come
  // with each call in body.settings.
  const p = await newPlugin(withDotEnv(envFile), withTimeout(SEND_TIMEOUT_SECONDS));

  const registry = new Registry();

  p.intro({
    name: "PLAYWRIGHT",
    author: "FloMorphic",
    version,
    settings: registry.settingsForm(),
    manual: MANUAL,
  });
  p.requiredParams(registry.settings());

  const actions = registry.all();
  p.addAction(...actions);
  p.addMeta(...registry.metas());

  // Browsers are child processes, so they outlive a careless exit. Close them on
  // the way out rather than leaving orphaned Chromium processes on the host.
  //
  // This is NOT the SDK's onSignal (which is about a single job being stopped) —
  // it is ordinary process shutdown.
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      console.log(`playwright plugin: ${signal} received, closing browsers…`);
      registry
        .shutdown()
        .catch((e) => console.error("playwright plugin: browser shutdown failed:", e))
        .finally(() => process.exit(0));
    });
  }

  p.start();

  const methods = actions.map((a) => a.method).join(", ");
  console.log(`playwright plugin ${version} ready with ${actions.length} actions: ${methods}`);
  console.log(
    "playwright plugin: each call brings its own browser profile in body.settings — bind a settings profile to the node",
  );
  console.log(
    'playwright plugin: browsers must be installed on this host — run "npm run browsers" if a node reports a missing executable',
  );

  // start() only wires up subscriptions; the process has to stay alive to serve
  // them.
  await new Promise(() => {});
}

// MANUAL is the help panel the host renders on the plugin's page. The fenced
// inflow-meta block becomes a Run button that calls the meta method.
const MANUAL = `# Playwright

Drives a real browser — Chromium, Firefox or WebKit — from the workflow canvas.

## Actions

- **Open page** — navigate and read: title, status, visible text, HTML, links, or
  a structured result built from CSS selectors.
- **Screenshot** — base64 PNG/JPEG of the page, the viewport or one element.
- **Print to PDF** — base64 PDF (Chromium only).
- **Evaluate JavaScript** — run an expression in the page and return its value.
- **Run browser flow** — an ordered list of steps against one page, keeping the
  session throughout: sign in, fill a form, page through a table.

## 1. Is a browser installed?

A browser is a separate, several-hundred-megabyte download — it is not part of
this plugin. Check what this host has:

\`\`\`inflow-meta
playwright.meta.browsers.status
\`\`\`

## 2. Install one, if needed

This installs **Chromium**, which is enough for almost every flow and the
smallest download. Press it once; it returns straight away and keeps working in
the background.

\`\`\`inflow-meta
playwright.meta.browsers.install
\`\`\`

Watch it — press this as often as you like, it never starts a second install:

\`\`\`inflow-meta
playwright.meta.browsers.install.progress
\`\`\`

All three engines instead (a much larger download, only needed to test
cross-browser):

\`\`\`inflow-meta
playwright.meta.browsers.install.all
\`\`\`

If the install reports missing **system libraries**, those need root once on the
host — \`sudo npx playwright install --with-deps\` — which a plugin cannot do for
you. The alternative is to install nothing here at all: set the browser
profile's **Remote browser endpoint** to a \`ws://\` Playwright server or an
\`http://\` CDP endpoint.

## 3. Check the configured browser

Confirms the engine launches and reports its version:

\`\`\`inflow-meta
playwright.meta.browser.check
\`\`\`

## Recording a flow instead of writing one

You do not have to write steps by hand. Record them in a real browser:

    npx playwright codegen https://example.com

Perform the flow; Playwright writes the equivalent code as you click. Paste that
code into **Recorded script** on the *Run browser flow* node and press
**Convert to steps** — the Steps field fills itself in. Anything that has no
step equivalent is named rather than quietly dropped.
`;

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
