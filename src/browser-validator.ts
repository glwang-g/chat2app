export interface BrowserValidationResult {
  ok: boolean;
  skipped?: boolean;
  errors: string[];
  screenshot?: string;
}

/**
 * Runs only when playwright-core and a browser executable are available.
 * Keeping this optional preserves the lightweight Node-only deployment.
 */
export async function validateInBrowser(url: string, executablePath?: string): Promise<BrowserValidationResult> {
  let playwright: any;
  try {
    playwright = await import("playwright-core");
  } catch {
    return { ok: true, skipped: true, errors: [] };
  }
  if (!executablePath) return { ok: true, skipped: true, errors: [] };
  const errors: string[] = [];
  const browser = await playwright.chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("console", (message: any) => { if (message.type() === "error") errors.push(message.text()); });
    const response = await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
    if (!response || !response.ok()) errors.push(`页面返回 HTTP ${response?.status() || 0}`);
    await page.screenshot({ path: `/tmp/chat2app-${Date.now()}.png` });
    return { ok: errors.length === 0, errors };
  } finally {
    await browser.close();
  }
}
