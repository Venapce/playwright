// The browser pool. A plugin is a long-lived process, so the expensive thing —
// the browser itself — is launched once per distinct profile and kept, while
// every job gets a fresh BrowserContext for isolation (its own cookies, storage
// and cache) at a fraction of the cost of a launch.

import { chromium, firefox, webkit } from "playwright";
import type { Browser, BrowserType, Page } from "playwright";

import type { Engine, Profile } from "./profile.js";

const ENGINES: Record<Engine, BrowserType> = { chromium, firefox, webkit };

/** What a handler is handed: a ready page, plus the browser behind it. */
export interface Lease {
  page: Page;
  browser: Browser;
  /** Playwright's version string for the connected browser. */
  browserVersion: string;
}

/**
 * Pool keeps one browser per distinct profile key and hands out a context per
 * job. It is safe to call from concurrent jobs: a launch in flight is shared as
 * a promise, so two simultaneous jobs on the same profile wait on one launch
 * rather than starting two browsers.
 */
export class Pool {
  private readonly browsers = new Map<string, Promise<Browser>>();

  /**
   * Run `fn` against a fresh page on this profile's browser, then tear the page
   * and its context down — whatever `fn` did or threw.
   */
  async withPage<T>(profile: Profile, fn: (lease: Lease) => Promise<T>): Promise<T> {
    const browser = await this.browser(profile);
    const context = await browser.newContext(profile.context);
    context.setDefaultNavigationTimeout(profile.navigationTimeoutMs);
    context.setDefaultTimeout(profile.actionTimeoutMs);
    try {
      const page = await context.newPage();
      return await fn({ page, browser, browserVersion: browser.version() });
    } finally {
      // Closing the context drops its pages, cookies and storage; the browser
      // stays up for the next job.
      await context.close().catch(() => {});
    }
  }

  /** The browser for this profile, launched or connected on first use. */
  async browser(profile: Profile): Promise<Browser> {
    const existing = this.browsers.get(profile.key);
    if (existing) {
      try {
        const browser = await existing;
        if (browser.isConnected()) return browser;
      } catch {
        // A failed launch must not be cached — fall through and retry below.
      }
      this.browsers.delete(profile.key);
    }

    const pending = this.open(profile);
    this.browsers.set(profile.key, pending);

    let browser: Browser;
    try {
      browser = await pending;
    } catch (e) {
      this.browsers.delete(profile.key);
      throw e;
    }

    // A browser that dies (crash, remote server restart, someone closing a
    // headed window) must not be handed to the next job.
    browser.on("disconnected", () => {
      if (this.browsers.get(profile.key) === pending) this.browsers.delete(profile.key);
    });
    return browser;
  }

  // open launches a local browser or attaches to a remote one.
  private async open(profile: Profile): Promise<Browser> {
    const engine = ENGINES[profile.engine];
    try {
      if (profile.endpoint === "") {
        return await engine.launch({
          headless: profile.headless,
          args: profile.launchArgs.length > 0 ? profile.launchArgs : undefined,
          proxy: profile.proxy,
        });
      }
      if (/^wss?:\/\//i.test(profile.endpoint)) {
        return await engine.connect(profile.endpoint);
      }
      // An http(s) endpoint is a CDP target, which is Chromium-only.
      if (profile.engine !== "chromium") {
        throw new Error(
          `a CDP endpoint (${profile.endpoint}) works only with chromium; use a ws:// Playwright server endpoint for ${profile.engine}`,
        );
      }
      return await engine.connectOverCDP(profile.endpoint);
    } catch (e) {
      throw new Error(`could not reach ${profile.describe}: ${hint(e)}`);
    }
  }

  /** Close every pooled browser. Called on shutdown. */
  async closeAll(): Promise<void> {
    const pending = [...this.browsers.values()];
    this.browsers.clear();
    await Promise.all(
      pending.map(async (p) => {
        try {
          const browser = await p;
          await browser.close();
        } catch {
          // Already gone, or never came up — nothing to close.
        }
      }),
    );
  }
}

// hint turns Playwright's "executable doesn't exist" wall of text into the one
// instruction that fixes it, and leaves anything else alone.
function hint(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/Executable doesn't exist|browserType\.launch.*install/is.test(msg)) {
    return `the browser is not installed on this host — run "npx playwright install" (or "npm run browsers"). Original error: ${firstLine(msg)}`;
  }
  return firstLine(msg);
}

function firstLine(msg: string): string {
  const line = msg.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? msg;
  return line.length > 400 ? line.slice(0, 397) + "…" : line;
}
