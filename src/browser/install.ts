// Installing browsers from inside the plugin.
//
// A browser is an out-of-process, several-hundred-megabyte dependency, and
// "run npx playwright install" is not a useful instruction to someone who only
// wanted a node on a canvas. So the plugin reports what is installed and can
// install it, driven from the Run buttons on its manual page.
//
// A download takes minutes, which is far longer than a request/reply deadline,
// so installing is a *job with state*: the first call starts it and returns at
// once, and each later call reports progress. Nothing here blocks the reply.

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** The engines a caller may ask for. Anything else is refused. */
const INSTALLABLE = new Set(["chromium", "chromium-headless-shell", "firefox", "webkit"]);

/** How much of the install log is kept for the progress reply. */
const LOG_LINES = 40;

/** One component Playwright knows how to install, and whether it is here. */
export interface ComponentStatus {
  component: string;
  name: string;
  directory: string;
  installed: boolean;
}

/** What `status()` reports. */
export interface StatusReport {
  browsersPath: string;
  components: ComponentStatus[];
  /** Engines that can be launched right now. */
  ready: string[];
  /** Engines that would have to be downloaded first. */
  missing: string[];
  hint: string;
}

export type InstallPhase = "idle" | "running" | "done" | "failed";

/** A point-in-time view of the install job. */
export interface InstallSnapshot {
  phase: InstallPhase;
  engines: string[];
  /** Last seen download percentage, when the output carried one. */
  percent?: number;
  /** Tail of the install log. */
  log: string[];
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number;
  error?: string;
  message: string;
}

/**
 * BrowserInstaller owns the one install job a plugin process may have running,
 * and can report what is currently installed.
 */
export class BrowserInstaller {
  private job?: {
    engines: string[];
    phase: InstallPhase;
    log: string[];
    percent?: number;
    startedAt: number;
    finishedAt?: number;
    exitCode?: number;
    error?: string;
  };

  /** Which browsers are installed on this host. */
  async status(): Promise<StatusReport> {
    const components = await this.components();
    const installedComponents = new Set(components.filter((c) => c.installed).map((c) => c.component));

    const ready: string[] = [];
    const missing: string[] = [];
    for (const engine of ["chromium", "firefox", "webkit"]) {
      // Headless Chromium runs from the headless shell, so either build counts.
      const ok =
        engine === "chromium"
          ? installedComponents.has("chromium") || installedComponents.has("chromium-headless-shell")
          : installedComponents.has(engine);
      (ok ? ready : missing).push(engine);
    }

    return {
      browsersPath: browsersPath(),
      components,
      ready,
      missing,
      hint:
        missing.length === 0
          ? "Every engine is installed; nothing to do."
          : `Not installed: ${missing.join(", ")}. Run the install below (chromium is enough for most flows), or point the browser profile at a remote endpoint so nothing is installed here.`,
    };
  }

  /**
   * Start an install, or report the one already running. Returns immediately —
   * the caller presses the button again to see progress.
   */
  start(engines: string[], withDeps: boolean): InstallSnapshot {
    if (this.job?.phase === "running") {
      return { ...this.snapshot(), message: "An install is already running. Press again for progress." };
    }

    const requested = normalizeEngines(engines);

    const cli = cliPath();
    const args = ["install", ...requested];
    if (withDeps) args.push("--with-deps");

    const job: NonNullable<typeof this.job> = {
      engines: requested,
      phase: "running",
      log: [],
      startedAt: Date.now(),
    };
    this.job = job;

    const child = spawn(process.execPath, [cli, ...args], {
      // No shell, no interactive prompt: --with-deps shells out to the system
      // package manager, which must never sit waiting for a tty that is not
      // there.
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DEBIAN_FRONTEND: "noninteractive", PW_TEST_HTML_REPORT_OPEN: "never" },
    });

    const absorb = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n|\r/)) {
        const text = line.trim();
        if (text === "") continue;
        const pct = text.match(/(\d{1,3})%\s+of\s+/);
        if (pct) {
          job.percent = Number(pct[1]);
          continue; // progress bars are noise in a log tail
        }
        job.log.push(text);
        if (job.log.length > LOG_LINES) job.log.shift();
      }
    };
    child.stdout.on("data", absorb);
    child.stderr.on("data", absorb);

    child.on("error", (e) => {
      job.phase = "failed";
      job.error = e.message;
      job.finishedAt = Date.now();
    });

    child.on("close", (code) => {
      job.exitCode = code ?? -1;
      job.finishedAt = Date.now();
      if (code === 0) {
        job.phase = "done";
        job.percent = 100;
      } else {
        job.phase = "failed";
        job.error = job.error ?? installFailureHint(code ?? -1, job.log, withDeps);
      }
    });

    return {
      ...this.snapshot(),
      message: `Installing ${requested.length === 0 ? "every engine" : requested.join(", ")}. This downloads hundreds of megabytes and takes a few minutes — press again for progress.`,
    };
  }

  /** The current state of the install job. */
  snapshot(): InstallSnapshot {
    const job = this.job;
    if (!job) {
      return { phase: "idle", engines: [], log: [], message: "No install has been started in this plugin process." };
    }
    const finished = job.finishedAt ?? Date.now();
    const base: InstallSnapshot = {
      phase: job.phase,
      engines: job.engines,
      percent: job.percent,
      log: [...job.log],
      startedAt: new Date(job.startedAt).toISOString(),
      durationMs: finished - job.startedAt,
      message: "",
    };
    if (job.finishedAt) base.finishedAt = new Date(job.finishedAt).toISOString();
    if (job.exitCode !== undefined) base.exitCode = job.exitCode;
    if (job.error) base.error = job.error;

    switch (job.phase) {
      case "running":
        base.message = `Still installing${job.percent === undefined ? "" : ` — ${job.percent}%`} (${Math.round(base.durationMs! / 1000)}s so far). Press again for progress.`;
        break;
      case "done":
        base.message = `Installed ${job.engines.length === 0 ? "every engine" : job.engines.join(", ")} in ${Math.round(base.durationMs! / 1000)}s. Test the browser profile to confirm.`;
        break;
      case "failed":
        base.message = `Install failed: ${job.error ?? `exit code ${job.exitCode}`}`;
        break;
      default:
        base.message = "No install has been started in this plugin process.";
    }
    return base;
  }

  // components asks Playwright itself what it would install and where, then
  // checks each location. Parsing --dry-run beats guessing paths, because the
  // revision numbers change with every Playwright release.
  private async components(): Promise<ComponentStatus[]> {
    let output: string;
    try {
      output = await runCli(["install", "--dry-run"]);
    } catch (e) {
      throw new Error(`could not ask Playwright what it would install: ${e instanceof Error ? e.message : String(e)}`);
    }

    const components: ComponentStatus[] = [];
    let pending: { component: string; name: string } | undefined;
    for (const raw of output.split(/\r?\n/)) {
      const line = raw.trim();
      const header = line.match(/^(.*?)\s*\(playwright (\S+) v[\w.]+\)$/);
      if (header) {
        pending = { name: header[1], component: header[2] };
        continue;
      }
      const location = line.match(/^Install location:\s*(.+)$/);
      if (location && pending) {
        const directory = location[1].trim();
        components.push({
          component: pending.component,
          name: pending.name,
          directory,
          installed: isPopulated(directory),
        });
        pending = undefined;
      }
    }
    if (components.length === 0) throw new Error("Playwright reported no installable components");
    return components;
  }
}

// --------------------------------------------------------------- helpers --

/**
 * Validate the engine list. An empty list means "everything", which is what the
 * bare CLI command does. Anything not a known engine is refused rather than
 * passed through — this list becomes process arguments.
 */
export function normalizeEngines(engines: string[]): string[] {
  const out: string[] = [];
  for (const raw of engines) {
    const engine = String(raw).trim().toLowerCase();
    if (engine === "" || engine === "all") continue;
    if (!INSTALLABLE.has(engine)) {
      throw new Error(
        `cannot install ${JSON.stringify(raw)}: expected one of ${[...INSTALLABLE].join(", ")}, or "all"`,
      );
    }
    if (!out.includes(engine)) out.push(engine);
  }
  return out;
}

// browsersPath is where Playwright keeps its browsers.
function browsersPath(): string {
  const override = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (override && override !== "0") return override;
  const home = process.env.HOME ?? "~";
  switch (process.platform) {
    case "win32":
      return join(process.env.LOCALAPPDATA ?? home, "ms-playwright");
    case "darwin":
      return join(home, "Library", "Caches", "ms-playwright");
    default:
      return join(home, ".cache", "ms-playwright");
  }
}

// cliPath locates playwright's own CLI next to the installed package, so the
// install runs the exact version this plugin depends on and does not need npx.
function cliPath(): string {
  const require_ = createRequire(import.meta.url);
  for (const spec of ["playwright", "playwright-core"]) {
    try {
      const candidate = join(dirname(require_.resolve(spec)), "cli.js");
      if (existsSync(candidate)) return candidate;
    } catch {
      // try the next one
    }
  }
  throw new Error("could not find playwright's cli.js — is the playwright package installed?");
}

// runCli runs a short playwright CLI command and returns its output.
function runCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath(), ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`playwright ${args.join(" ")} exited ${code}: ${err.trim().split("\n")[0] ?? ""}`));
    });
    setTimeout(() => {
      child.kill();
      reject(new Error(`playwright ${args.join(" ")} timed out`));
    }, 60_000).unref();
  });
}

// isPopulated treats a directory that exists and has contents as installed; a
// half-deleted empty directory is not.
function isPopulated(directory: string): boolean {
  try {
    return existsSync(directory) && readdirSync(directory).length > 0;
  } catch {
    return false;
  }
}

// installFailureHint turns the common failures into the sentence that fixes
// them, since whoever presses the button is the least likely to know.
function installFailureHint(code: number, log: string[], withDeps: boolean): string {
  const text = log.join("\n");
  if (withDeps && /permission denied|must be run as root|sudo|apt-get/i.test(text)) {
    return `installing system dependencies needs root, and this plugin is not running as root (exit ${code}). Install them once on the host with "sudo npx playwright install --with-deps", then install the browser from here without system dependencies.`;
  }
  if (/ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network|ENETUNREACH|certificate/i.test(text)) {
    return `the download could not reach Playwright's CDN (exit ${code}). If this host goes through a proxy, set HTTPS_PROXY for the plugin process, or point the browser profile at a remote endpoint instead.`;
  }
  if (/ENOSPC|no space left/i.test(text)) {
    return `not enough disk space to unpack the browser (exit ${code}). Each engine needs several hundred megabytes under ${browsersPath()}.`;
  }
  return `playwright install exited ${code}. Last output: ${log.slice(-3).join(" | ") || "(none)"}`;
}
