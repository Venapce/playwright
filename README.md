# Inflowenger Playwright plugin

A **Playwright** node for the Inflowenger workflow canvas: drive a real browser —
Chromium, Firefox or WebKit — from a flow. Open and read pages that need
JavaScript to render, screenshot them, print them to PDF, evaluate scripts in
them, or run a whole scripted session (sign in, fill a form, page through a
table) as a single node.

Built on [`@inflowenger/node-plugin-sdk`](https://www.npmjs.com/package/@inflowenger/node-plugin-sdk)
(`inflowv1`).

The plugin holds no browser configuration. It declares what a browser profile
needs; the platform stores that as a named **settings profile** and ships the
values with every call as `body.settings`.

## Why Node and not Go

`playwright-go` is not a native port — it downloads the `playwright-core` npm
package plus a pinned Node.js binary and drives them over a stdio pipe. A Go
build of this plugin would therefore still require Node.js on the host, *plus* a
Go binary on top, and would lag upstream Playwright. Node is the first-party
path here.

## Actions

| Action | Method | Returns |
|---|---|---|
| Open page | `playwright.page.open` | title, status, text, HTML, links, selector fields |
| Screenshot | `playwright.page.screenshot` | base64 PNG/JPEG |
| Print to PDF | `playwright.page.pdf` | base64 PDF (Chromium only) |
| Evaluate JavaScript | `playwright.page.evaluate` | whatever the expression returns |
| Run browser flow | `playwright.flow.run` | per-step log + everything the steps named |

## Open page

Navigates in a fresh, isolated browser context and reads what loaded. **Wait for
selector** is the field that makes this work on a single-page app: it waits for
content a script renders after navigation, which a plain HTTP fetch never sees.

**Extract fields** is the one worth reaching for — it turns a page into a
structured result instead of a wall of HTML:

```json
{
  "heading": "h1",
  "price":   { "selector": ".price", "attr": "data-value" },
  "links":   { "selector": "a", "attr": "href", "all": true },
  "sku":     { "selector": "[data-sku]", "attr": "data-sku", "required": true }
}
```

- a bare string is the selector, read as text
- `attr` reads an attribute instead; `html`, `outerhtml`, `text`, `textcontent`
  and `value` are understood as well
- `all: true` collects every match into an array
- `required: true` fails the node when nothing matches, so an empty result cannot
  quietly pass for a successful one

Returned text and HTML are truncated at **Max characters** (50 000 by default) so
one heavy page cannot flood the flow.

## Run browser flow

An ordered list of steps against one page, keeping cookies and session
throughout:

```json
[
  { "do": "goto", "url": "https://example.com/login" },
  { "do": "fill", "selector": "#user", "value": "{{$.secrets.user}}" },
  { "do": "fill", "selector": "#pass", "value": "{{$.secrets.pass}}" },
  { "do": "click", "selector": "button[type=submit]" },
  { "do": "waitForSelector", "selector": ".dashboard", "state": "visible" },
  { "do": "extract", "as": "account", "fields": { "name": ".account-name" } },
  { "do": "screenshot", "as": "proof" }
]
```

Verbs: `goto`, `click`, `dblclick`, `fill`, `type`, `press`, `select`, `check`,
`uncheck`, `hover`, `waitForSelector`, `waitForURL`, `waitForLoadState`,
`waitForTimeout`, `scroll`, `screenshot`, `extract`, `evaluate`.

Each step takes an optional `timeout` (ms). A step given an `as` puts its result
under that name in the output; `screenshot` steps collect into `screenshots`.
Every run also returns `steps` — a log of what ran, how long it took and what
broke.

**A flow that fails mid-way still commits what it collected.** The node fails,
and the partial result (including the step log) is committed anyway, because a
flow that got halfway often holds something the rest of the graph needs. Set
**Continue on error** to push past a failing step instead of stopping.

**Return storage state** hands back the session's cookies and local storage —
paste that into a profile's *Storage state* and later runs start already signed
in, with no login steps at all.

## Recording a flow instead of writing one

You do not have to write steps by hand. Playwright ships a recorder — the
first-party successor to the old Selenium IDE extension — and this plugin can
convert what it produces.

```bash
npm run codegen -- https://example.com      # or: npx playwright codegen <url>
```

A browser and an Inspector window open. Perform the flow; Playwright writes the
equivalent code as you click:

```js
await page.goto('https://example.com/login');
await page.getByLabel('Email').fill('ada@example.com');
await page.getByRole('button', { name: 'Sign In' }).click();
```

Then either:

- **In the node** — paste that code into **Recorded script** on the *Run browser
  flow* node and press **Convert to steps**. The Steps field fills itself in.
- **In the terminal** — `npm run convert -- flow.spec.ts`, or pipe it:
  `npx playwright codegen -o flow.spec.ts <url> && npm run convert -- flow.spec.ts`.

Either way you get:

```json
[
  {"do":"goto","url":"https://example.com/login"},
  {"do":"fill","label":"Email","value":"ada@example.com"},
  {"do":"click","role":"button","name":"Sign In"}
]
```

The converter keeps the **semantic locators** the recorder produces rather than
flattening them to CSS, which is the whole reason they are worth recording:
`getByRole('button', { name: 'Sign In' })` keeps working when the markup around
the button changes, where `#login > div:nth-child(3) > button` does not.

What it cannot convert is **named, never dropped silently** — assertions
(`expect(...)`), `setInputFiles`, `goBack`, right-clicks, `mouse.*`. Each is
reported with its line number and the reason, so a half-converted recording
cannot pass for a complete one.

An alternative recorder, if you are already driving a session:

```bash
npx playwright cli recording-start    # act in the browser
npx playwright cli recording-stop     # prints the code
```

### Naming elements

Steps accept the recorder's whole vocabulary, not just CSS:

| Key | Matches |
|---|---|
| `role` + `name` | accessible role and name — the most durable |
| `label` | form control by its `<label>` |
| `placeholder` | input by placeholder text |
| `text` | element by visible text |
| `altText` / `title` | image alt, or `title` attribute |
| `testId` | `data-testid` |
| `selector` | CSS or XPath, for when nothing else fits |

Add `exact: true` for an exact name match, `nth` (0-based) or `last` to choose
among matches, `hasText` to narrow, and a regex as `{"regex":"Order #\\d+","flags":"i"}`.
To scope one element inside another, use a `locator` chain — what the recorder
writes as `page.locator('.card').getByRole('button')`:

```json
{ "do": "click", "locator": [ { "selector": ".card" }, { "role": "button", "name": "Buy" } ] }
```

## `{{$.path}}` — pull values from the flow

Every string input, at any depth, accepts `{{$.path}}` tokens resolved against
the flow scope before the browser is touched — a URL, a selector, a step's
`value`, a script. A path the scope cannot supply is left verbatim rather than
silently blanked.

```json
{ "do": "fill", "selector": "#user", "value": "{{$.trigger.username}}" }
```

## Browser profile (settings)

All optional — the default is a headless Chromium at 1280×800. Worth knowing:

- **Engine** — `chromium`, `firefox` or `webkit`. Must be installed on the host.
- **Remote browser endpoint** — drive a browser that lives elsewhere instead of
  launching one here: a `ws://`/`wss://` Playwright server endpoint, or an
  `http://` CDP endpoint (Chromium only). Set it and **nothing is installed or
  launched locally**, which is the deployment to prefer if this plugin runs in a
  slim container.
- **Storage state** — Playwright storage-state JSON, so every page starts signed
  in. Produce it with `npx playwright codegen --save-storage=state.json`.
- **JavaScript enabled** — turn it off to read server-rendered HTML only; faster,
  and enough for many scrapes.
- Proxy, extra HTTP headers, locale, timezone, viewport and the two timeouts.

Press **Test browser** in the dialog to launch or reach the browser and report
its version before saving, so a missing engine shows up there rather than in
every node that later fails.

## Running

Browsers are a separate, out-of-process dependency in every language — install
them once on the host:

```bash
npm install
npm run browsers          # chromium only (smallest)
# npm run browsers:all    # chromium + firefox + webkit
# npm run browsers:deps   # also apt-installs system libs (needs root; fresh containers)
```

**Or install them from the plugin's own page**, with no terminal at all — see
[Installing browsers without a terminal](#installing-browsers-without-a-terminal).

Then provide the platform identity and start it:

```bash
cp .env.inflow.example .env.inflow   # PLUGIN_ID, INFRA_CRED, INFRA_URL from Infra
npm run build && npm start
# or, during development, run the TypeScript directly:
npm run dev
```

The SDK logs every subject it subscribes to at start-up; that log is how you
confirm the plugin registered. Add the node to a flow and run it to verify.

A node that reports `Executable doesn't exist` means the engine is not installed
on **this** host — run `npm run browsers`, or point the profile at a remote
endpoint.

## Installing browsers without a terminal

Nobody who just wants a node on a canvas should have to be told to "run npx
playwright install". The plugin's page (FloMorphic → Extensions) carries Run
buttons for the whole job:

| Button | Meta method | Does |
|---|---|---|
| Check what's installed | `playwright.meta.browsers.status` | lists engines that can launch right now, and what is missing |
| Install Chromium | `playwright.meta.browsers.install` | starts the download (Chromium only — the smallest, enough for almost everything) |
| Watch progress | `playwright.meta.browsers.install.progress` | percentage, elapsed time and the log tail |
| Install all engines | `playwright.meta.browsers.install.all` | Chromium + Firefox + WebKit |
| Test the browser | `playwright.meta.browser.check` | launches the configured profile and reports its version |

A download takes minutes — far longer than any request/reply deadline — so
installing is a **job with state**: the first press starts it and returns at
once, and *Watch progress* reports how far it got. Pressing Install again while
one is running reports progress instead of starting a second download.

Only the four known engine names are ever accepted, since the value becomes a
process argument; anything else is refused rather than passed through.

The two failures a button cannot fix are reported in plain terms rather than as
an exit code:

- **System libraries missing** — needs root once on the host
  (`sudo npx playwright install --with-deps`), which a plugin cannot do for you.
- **No network / proxy** — set `HTTPS_PROXY` for the plugin process, or skip
  installing entirely by pointing the profile at a remote browser endpoint.

## How it uses the process

A plugin is a long-lived process, and this one leans on that: the browser is
launched **once per distinct profile** and kept warm, while every job gets its
own `BrowserContext` — its own cookies, storage and cache. Jobs stay isolated
without paying for a browser launch each time. A browser that dies (crash,
remote restart) is dropped from the pool and relaunched on the next job, and
`SIGINT`/`SIGTERM` closes them all so no orphaned Chromium is left behind.
(`SIGKILL` cannot be handled by any process, so `kill -9` of the plugin does
orphan its browsers — worth knowing if you run it on bare metal, where they
are not reaped along with a container.)

Only options that cannot change after launch (engine, headless, proxy, launch
args, endpoint) are part of the pool key — viewport, headers or locale never
fragment the pool.

## Layout

```
src/
  main.ts                entry point: intro, settings, actions, shutdown
  browser/
    profile.ts           settings payload -> validated browser profile
    pool.ts              one browser per profile, one context per job
    install.ts           browser status + the install job behind the Run buttons
  actions/
    registry.ts          the five actions, the meta RPCs, the job lifecycle
    forms.ts             every form, via the SDK's formkit builder
    steps.ts             the scripted-flow step runner
    locators.ts          role / label / testId / CSS -> a Playwright locator
    extract.ts           selector -> structured output
    vars.ts              {{$.path}} resolution against the flow scope
  codegen/
    convert.ts           recorded Playwright code -> steps JSON
    literal.ts           parser for the JS literals in generated code
  tools/
    convert-recording.ts the `npm run convert` CLI
```

## Requirements

- Node 20+
- A Playwright-supported browser installed on the host, **or** a reachable remote
  browser endpoint
- Infra-minted `PLUGIN_ID`, `INFRA_CRED`, `INFRA_URL`

## Notes

- **Evaluate JavaScript** and the `evaluate` step run arbitrary script *inside the
  page*. That is the point of the action, but it means the script is as trusted
  as whoever can edit the flow.
- PDF printing is Chromium-only; Playwright cannot print in Firefox or WebKit.
  The node refuses before launching a browser rather than after.
- Screenshots and PDFs come back inline as base64. Prefer JPEG for anything long,
  and remember the SDK reply deadline (180 s here, `REQ_TIMEOUT` overrides).
