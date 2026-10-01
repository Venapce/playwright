// Wires Playwright onto the plugin's node actions — open a page, screenshot,
// print to PDF, evaluate a script, and run a scripted flow — plus the meta RPC
// behind the settings form's "Test browser" button.

import {
  castRequestTo,
  formkit,
  type Action,
  type Job,
  type Meta,
  type Request,
  type Settings,
} from "@inflowenger/node-plugin-sdk";
import type { Page, Response as PWResponse } from "playwright";

import { bool, int, profileFrom, str, type Profile } from "../browser/profile.js";
import { BrowserInstaller, normalizeEngines } from "../browser/install.js";
import { Pool, type Lease } from "../browser/pool.js";
import { convertRecording, renderSteps } from "../codegen/convert.js";
import { extractFields, parseFields } from "./extract.js";
import {
  evaluateForm,
  flowForm,
  pdfForm,
  scrapeForm,
  screenshotForm,
  settingsForm,
} from "./forms.js";
import { parseSteps, runSteps, StepError } from "./steps.js";
import { resolveInputVars, VarResolver } from "./vars.js";

/** Default ceiling on returned text/HTML, so one node cannot flood the flow. */
const DEFAULT_MAX_CHARS = 50_000;

/** One action's output. Returning it from a handler lets run() finish the job. */
type Output = Record<string, unknown>;

/**
 * A handler is the pure work of one action over a page that is already open on
 * the right browser. Finishing the job is left to run(); throwing fails the node
 * with the error's message.
 */
type Handler = (
  job: Job,
  lease: Lease,
  input: Record<string, unknown>,
  profile: Profile,
) => Promise<Output>;

/**
 * Registry owns what the actions share: the browser pool. The plugin holds no
 * browser configuration of its own — every call brings its profile.
 */
export class Registry {
  private readonly pool = new Pool();
  private readonly installer = new BrowserInstaller();

  /** Every action this plugin exposes, in the order the canvas shows them. */
  all(): Action[] {
    return [this.scrape(), this.screenshot(), this.pdf(), this.evaluate(), this.flow()];
  }

  /**
   * The meta RPCs: test a browser profile, convert a recording into steps, and
   * the two that report and perform a browser install.
   */
  metas(): Meta[] {
    return [
      { method: "playwright.meta.browser.check", requestHandler: (req) => this.metaBrowserCheck(req) },
      { method: "playwright.meta.steps.import", requestHandler: (req) => this.metaStepsImport(req) },
      { method: "playwright.meta.browsers.status", requestHandler: () => this.metaBrowsersStatus() },
      { method: "playwright.meta.browsers.install", requestHandler: (req) => this.metaBrowsersInstall(req, ["chromium"]) },
      { method: "playwright.meta.browsers.install.all", requestHandler: (req) => this.metaBrowsersInstall(req, []) },
      { method: "playwright.meta.browsers.install.progress", requestHandler: () => ({ data: { ...this.installer.snapshot() } }) },
    ];
  }

  /** The settings profile: the form plus the submit handler that validates it. */
  settings(): Settings {
    return settingsForm.settings(async (req) => {
      const values = profileValues(decodeMeta(req.data));
      let profile: Profile;
      try {
        profile = profileFrom(values);
      } catch (e) {
        return { error: errText(e) };
      }
      try {
        const browser = await this.pool.browser(profile);
        return { data: { ok: true, browser: profile.describe, version: browser.version() } };
      } catch (e) {
        return { error: errText(e) };
      }
    });
  }

  /** The same form for PluginIntro.settings — the plugin set-up dialog reads it. */
  settingsForm() {
    return settingsForm.build();
  }

  /** Close every pooled browser. Called on shutdown. */
  async shutdown(): Promise<void> {
    await this.pool.closeAll();
  }

  // ------------------------------------------------------------- actions --

  private scrape(): Action {
    return {
      method: "playwright.page.open",
      title: "Open page",
      description:
        "Navigate to a URL in a fresh browser context and read what loaded — title, status, text, HTML, links, or a structured result built from CSS selectors. The action to reach for when a page needs JavaScript to render.",
      icon: { icon: "mdi-web" },
      form: scrapeForm,
      requestHandler: this.run("open page", async (job, lease, input) => {
        const { page } = lease;
        const response = await this.openUrl(job, page, input);

        const maxChars = int(input.maxChars, DEFAULT_MAX_CHARS, "maxChars");
        const out: Output = {
          url: page.url(),
          title: await page.title(),
          status: response ? response.status() : null,
          ok: response ? response.ok() : null,
        };

        if (bool(input.includeText, true)) {
          out.text = clamp(await page.locator("body").innerText(), maxChars);
        }
        if (bool(input.includeHtml, false)) {
          out.html = clamp(await page.content(), maxChars);
        }
        if (bool(input.includeLinks, false)) {
          out.links = await page.evaluate(() =>
            Array.from(document.querySelectorAll("a[href]")).map((a) => ({
              text: (a.textContent ?? "").trim(),
              href: (a as HTMLAnchorElement).href,
            })),
          );
        }

        const fields = parseFields(input.fields);
        if (Object.keys(fields).length > 0) {
          await job.progress(70, { title: "extract", content: `${Object.keys(fields).length} fields` });
          out.fields = await extractFields(page, fields);
        }

        return out;
      }),
    };
  }

  private screenshot(): Action {
    return {
      method: "playwright.page.screenshot",
      title: "Screenshot",
      description:
        "Open a page and capture it as a base64 PNG or JPEG — the whole page, the viewport, or one element. Use JPEG for anything long, since the image travels inline.",
      icon: { icon: "mdi-camera" },
      form: screenshotForm,
      requestHandler: this.run("screenshot", async (job, lease, input) => {
        const { page } = lease;
        await this.openUrl(job, page, input);

        const format = str(input.format).toLowerCase() === "jpeg" ? "jpeg" : "png";
        const selector = str(input.selector);

        await job.progress(70, { title: "screenshot", content: selector === "" ? format : `${selector} (${format})` });

        const quality = format === "jpeg" ? int(input.quality, 80, "quality") : undefined;
        const buffer =
          selector === ""
            ? await page.screenshot({ fullPage: bool(input.fullPage, false), type: format, quality })
            : await page.locator(selector).first().screenshot({ type: format, quality });

        return {
          url: page.url(),
          title: await page.title(),
          format,
          mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
          bytes: buffer.length,
          base64: buffer.toString("base64"),
        };
      }),
    };
  }

  private pdf(): Action {
    return {
      method: "playwright.page.pdf",
      title: "Print to PDF",
      description:
        "Open a page and print it to a PDF, returned as base64. Chromium only — Playwright cannot print in Firefox or WebKit.",
      icon: { icon: "mdi-file-pdf-box" },
      form: pdfForm,
      requestHandler: this.run(
        "print to pdf",
        async (job, lease, input) => {
        const { page } = lease;
        await this.openUrl(job, page, input);

        await job.progress(70, { title: "pdf", content: str(input.format) || "A4" });

        const margin = str(input.margin);
        const scale = Number(str(input.scale) || "1");
        if (!Number.isFinite(scale) || scale < 0.1 || scale > 2) {
          throw new Error(`scale must be a number between 0.1 and 2: ${JSON.stringify(str(input.scale))}`);
        }

        const buffer = await page.pdf({
          format: str(input.format) || "A4",
          landscape: str(input.orientation).toLowerCase() === "landscape",
          printBackground: bool(input.printBackground, true),
          scale,
          margin: margin === "" ? undefined : { top: margin, bottom: margin, left: margin, right: margin },
        });

        return {
          url: page.url(),
          title: await page.title(),
          mimeType: "application/pdf",
          bytes: buffer.length,
          base64: buffer.toString("base64"),
        };
        },
        // Checked before a browser is opened: printing is a Chromium capability,
        // so a wrong profile should cost nothing rather than launch an engine
        // that cannot do the work.
        (profile) => {
          if (profile.engine !== "chromium") {
            throw new Error(
              `printing to PDF needs Chromium; this settings profile uses ${profile.engine}. Switch the profile's engine, or use the Screenshot action.`,
            );
          }
        },
      ),
    };
  }

  private evaluate(): Action {
    return {
      method: "playwright.page.evaluate",
      title: "Evaluate JavaScript",
      description:
        "Open a page and run JavaScript inside it, returning what the expression evaluates to. The escape hatch for anything the other actions do not cover.",
      icon: { icon: "mdi-language-javascript" },
      form: evaluateForm,
      requestHandler: this.run("evaluate", async (job, lease, input) => {
        const script = str(input.script);
        if (script === "") throw new Error("missing required input: script");

        const { page } = lease;
        await this.openUrl(job, page, input);

        await job.progress(70, { title: "evaluate", content: preview(script) });

        let value: unknown;
        try {
          value = await page.evaluate(script);
        } catch (e) {
          throw new Error(`script failed in the page: ${errText(e)}`);
        }

        return { url: page.url(), title: await page.title(), result: value ?? null };
      }),
    };
  }

  private flow(): Action {
    return {
      method: "playwright.flow.run",
      title: "Run browser flow",
      description:
        "Run an ordered list of steps against one page — sign in, fill a form, page through a table — keeping cookies and session across every step. Returns a per-step log plus whatever the steps named with \"as\".",
      icon: { icon: "mdi-script-text-play" },
      form: flowForm,
      requestHandler: this.run("browser flow", async (job, lease, input) => {
        const steps = parseSteps(input.steps);
        const continueOnError = bool(input.continueOnError, false);
        const { page } = lease;

        let result;
        try {
          result = await runSteps(job, page, steps, { continueOnError });
        } catch (e) {
          // A flow that got halfway often still holds something the rest of the
          // graph needs, so the partial result is committed alongside the
          // failure rather than thrown away.
          if (e instanceof StepError) {
            await job.doneWithErrorData(e.message, {
              ...flowOutput(e.partial, steps.length),
              url: page.url(),
            });
            return FINISHED;
          }
          throw e;
        }

        const out: Output = { ...flowOutput(result, steps.length), url: page.url(), title: await page.title() };
        if (bool(input.returnStorageState, false)) {
          out.storageState = await page.context().storageState();
        }
        return out;
      }),
    };
  }

  // --------------------------------------------------------------- shared --

  // openUrl navigates to the action's url and honours its wait options. Every
  // page-opening action shares it, so they wait the same way.
  private async openUrl(
    job: Job,
    page: Page,
    input: Record<string, unknown>,
  ): Promise<PWResponse | null> {
    const url = str(input.url);
    if (url === "") throw new Error("missing required input: url");
    if (!/^https?:\/\//i.test(url) && !url.startsWith("file://") && !url.startsWith("about:")) {
      throw new Error(`url must start with http:// or https://: ${JSON.stringify(url)}`);
    }

    await job.progress(40, { title: "navigate", content: url });

    const waitUntil = str(input.waitUntil).toLowerCase();
    let response: PWResponse | null;
    try {
      response = await page.goto(url, {
        waitUntil: waitUntil === "" ? undefined : (waitUntil as "load" | "domcontentloaded" | "networkidle" | "commit"),
      });
    } catch (e) {
      throw new Error(`could not open ${url}: ${errText(e)}`);
    }

    const waitFor = str(input.waitForSelector);
    if (waitFor !== "") {
      await job.progress(55, { title: "wait", content: waitFor });
      try {
        await page.locator(waitFor).first().waitFor({ state: "visible" });
      } catch (e) {
        throw new Error(`selector never appeared: ${waitFor} (${errText(e)})`);
      }
    }

    return response;
  }

  /**
   * run adapts a handler into an SDK job handler: decode the typed body and the
   * browser profile that came with it, resolve {{$...}} tokens in every string
   * input, open a page, report progress, and terminate the job exactly once on
   * every path.
   */
  private run(
    title: string,
    handler: Handler,
    guard?: (profile: Profile) => void,
  ): (job: Job) => Promise<void> {
    return async (job: Job) => {
      let input: Record<string, unknown>;
      let settings: Record<string, unknown> | undefined;
      try {
        const req = castRequestTo<Record<string, unknown> & { settings?: Record<string, unknown> }>(
          job.req.data,
        );
        input = { ...(req.body ?? {}) };
        settings = (input.settings as Record<string, unknown>) ?? undefined;
        delete input.settings; // the profile travels separately, not as action input
      } catch (e) {
        await job.doneWithError("invalid request body: " + errText(e));
        return;
      }

      let profile: Profile;
      try {
        profile = profileFrom(settings);
        guard?.(profile);
      } catch (e) {
        await job.doneWithError(errText(e));
        return;
      }

      try {
        // Resolve {{$...}} tokens in every string input against the flow scope,
        // so a URL, a selector or a step's value can reference upstream data.
        await resolveInputVars(job, input, new VarResolver(job));

        await job.progress(20, { title, content: "on " + profile.describe });

        const out = await this.pool.withPage(profile, (lease) => handler(job, lease, input, profile));

        // A handler that already finished the job (a partially failed flow) says
        // so by returning FINISHED; anything else is committed here.
        if (out === FINISHED) return;

        await job.progress(90, { title, content: "committing result" });
        await job.done(out ?? {});
      } catch (e) {
        await job.doneWithError(errText(e));
      }
    };
  }

  // ----------------------------------------------------------------- meta --

  // metaBrowserCheck backs the settings form's "Test browser" button and its
  // submit validation. It launches or reaches the browser being configured and
  // reports its version, so a missing engine or an unreachable endpoint shows up
  // in the dialog instead of failing every node later.
  private async metaBrowserCheck(req: Request): Promise<unknown> {
    const values = profileValues(decodeMeta(req.data));
    let profile: Profile;
    try {
      profile = profileFrom(values);
    } catch (e) {
      return { error: errText(e) };
    }
    try {
      const browser = await this.pool.browser(profile);
      return {
        data: {
          ok: true,
          browser: profile.describe,
          version: browser.version(),
          mode: profile.endpoint === "" ? "launched locally" : "connected remotely",
        },
      };
    } catch (e) {
      return { error: errText(e) };
    }
  }

  // metaStepsImport backs the flow form's "Convert to steps" button: it turns a
  // script from `playwright codegen` into the steps array and patches it into
  // the open form, so recording a flow needs no hand-translation.
  private metaStepsImport(req: Request): unknown {
    const call = decodeMeta(req.data);
    const recording = str(call.recording);
    if (recording === "") {
      return formkit
        .failure(
          "Paste a recorded script first — run `npx playwright codegen <url>`, perform the flow, then copy the generated code here.",
        )
        .patch(null);
    }

    let conversion;
    try {
      conversion = convertRecording(recording);
    } catch (e) {
      return formkit.failure("Could not read that recording: %s", errText(e)).patch(null);
    }

    if (conversion.steps.length === 0) {
      return formkit
        .failure(
          "No steps found in that recording (%s). Paste the generated code itself — the `await page.…` lines — not the terminal output around it.",
          conversion.summary,
        )
        .patch(null);
    }

    // Whatever could not be converted is named, so a half-converted recording
    // cannot pass for a complete one.
    const detail = conversion.skipped
      .slice(0, 5)
      .map((s) => `line ${s.line}: ${s.reason}`)
      .join("; ");
    const parts = [`Converted ${conversion.summary}.`];
    if (detail !== "") {
      parts.push(`Not converted — ${detail}${conversion.skipped.length > 5 ? "; …" : ""}.`);
    }
    if (conversion.assertions > 0) {
      parts.push("Assertions have no step equivalent; add an extract step to check a value instead.");
    }
    const message = parts.join(" ");

    return formkit.success("%s", message).patch({ steps: renderSteps(conversion.steps) });
  }

  // metaBrowsersStatus reports which engines this host can actually launch.
  private async metaBrowsersStatus(): Promise<unknown> {
    try {
      const status = await this.installer.status();
      return {
        data: {
          browsersPath: status.browsersPath,
          ready: status.ready,
          missing: status.missing,
          installed: status.components.filter((c) => c.installed).map((c) => `${c.name} (${c.component})`),
          hint: status.hint,
        },
      };
    } catch (e) {
      return { error: errText(e) };
    }
  }

  // metaBrowsersInstall starts (or reports) a browser download. A download runs
  // for minutes, far longer than a reply deadline, so the first call starts it
  // and returns at once and each later call reports progress — pressing the
  // button again is how you watch it.
  private metaBrowsersInstall(req: Request, fallback: string[]): unknown {
    const call = decodeMeta(req.data);
    let engines = fallback;
    if (Array.isArray(call.engines)) {
      try {
        engines = normalizeEngines(call.engines.map((e) => str(e)));
      } catch (e) {
        return { error: errText(e) };
      }
    } else if (str(call.engine) !== "") {
      try {
        engines = normalizeEngines([str(call.engine)]);
      } catch (e) {
        return { error: errText(e) };
      }
    }

    try {
      const snapshot = this.installer.start(engines, bool(call.withDeps, false));
      return { data: { ...snapshot } };
    } catch (e) {
      return { error: errText(e) };
    }
  }
}

// FINISHED is the sentinel a handler returns when it has already terminated the
// job itself, so run() knows not to finish it a second time.
const FINISHED: Output = Object.freeze({ __finished: true });

// flowOutput shapes a step run's result for the node's scope.
function flowOutput(
  result: { log: unknown[]; data: Record<string, unknown>; screenshots: Record<string, string>; completed: number },
  total: number,
): Output {
  const out: Output = {
    steps: result.log,
    completed: result.completed,
    total,
    ...result.data,
  };
  if (Object.keys(result.screenshots).length > 0) out.screenshots = result.screenshots;
  return out;
}

// profileValues pulls the profile values out of a meta/submit call. On an
// action's drawer the bound profile is under "settings"; the set-up dialog has no
// bound profile and sends the edited values at the top level, alongside host keys.
function profileValues(body: Record<string, unknown>): Record<string, unknown> {
  const nested = body.settings;
  if (nested && typeof nested === "object" && Object.keys(nested as object).length > 0) {
    return nested as Record<string, unknown>;
  }
  const values = { ...body };
  for (const hostKey of ["settings", "value", "targetField", "form"]) delete values[hostKey];
  return values;
}

// decodeMeta reads a meta RPC's arguments, tolerating the {_registry, body}
// envelope or a bare object, and treating anything unreadable as "no arguments".
function decodeMeta(data: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder().decode(data).trim();
  if (text === "") return {};
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed && typeof parsed.body === "object" && parsed.body !== null) {
      return parsed.body as Record<string, unknown>;
    }
    return parsed;
  } catch {
    return {};
  }
}

// clamp truncates a long string, saying so, so a 2MB page cannot silently become
// the flow's payload.
function clamp(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n…[truncated ${text.length - maxChars} characters]`;
}

// preview trims a script to one short line for a progress frame.
function preview(script: string): string {
  const one = script.split(/\s+/).filter(Boolean).join(" ");
  return one.length > 120 ? one.slice(0, 117) + "…" : one;
}

function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const line = msg.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? msg;
  return line.length > 400 ? line.slice(0, 397) + "…" : line;
}
