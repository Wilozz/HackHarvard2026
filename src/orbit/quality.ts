import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import puppeteer from "puppeteer-core";
import { config } from "../config";
import { log } from "../log";

export interface QualityReport {
  /** False when the check couldn't run (no Chrome, page didn't load); the app may still be fine. */
  ran: boolean;
  errors: string[];
  screenshotPath?: string;
}

/**
 * Open the app like a phone would, tap to start it, and collect console errors
 * and uncaught exceptions. Takes a screenshot along the way.
 */
export async function checkApp(url: string, screenshotPath?: string): Promise<QualityReport> {
  if (!config.CHROME_PATH || !existsSync(config.CHROME_PATH)) return { ran: false, errors: [] };
  const browser = await puppeteer.launch({ executablePath: config.CHROME_PATH, headless: true, args: ["--no-first-run", "--mute-audio"] });
  const errors: string[] = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      // The browser's own favicon request isn't the app's fault.
      if (/favicon\.ico/i.test(msg.location().url ?? "")) return;
      errors.push(`console.error: ${msg.text().slice(0, 300)}`);
    });
    page.on("pageerror", (err) => errors.push(`uncaught: ${String((err as Error).message ?? err).slice(0, 300)}`));
    const res = await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    if (!res || !res.ok()) return { ran: false, errors: [`page returned ${res?.status() ?? "nothing"}`] };
    await new Promise((r) => setTimeout(r, 1500));
    // Start it the way a person would, then let it run a moment so game-loop errors show up.
    await page.touchscreen.tap(195, 560).catch(() => undefined);
    await page.keyboard.press("Space").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 700));
    if (screenshotPath) {
      mkdirSync(dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath as `${string}.png` });
    }
    await new Promise((r) => setTimeout(r, 2000));
    return { ran: true, errors, screenshotPath };
  } catch (err) {
    log.error("quality_check_failed", err);
    return { ran: false, errors };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
