export interface BrowserValidationResult {
  ok: boolean;
  skipped?: boolean;
  errors: string[];
  screenshot?: string;
  interactions?: Array<{ name: string; ok: boolean; error?: string }>;
}

export interface BrowserInteraction {
  name: string;
  selector: string;
  action: "click" | "fill" | "press" | "assert";
  value?: string;
  expectSelector?: string;
}

export interface BrowserPageLike {
  on(event: string, handler: (...args: any[]) => void): void;
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<{ ok(): boolean; status(): number } | null>;
  screenshot(options: { path: string }): Promise<void>;
  locator(selector: string): {
    click(): Promise<void>;
    fill(value: string): Promise<void>;
    press(value: string): Promise<void>;
    waitFor(options: { state: "visible"; timeout: number }): Promise<void>;
  };
}

export interface BrowserLike {
  newPage(): Promise<BrowserPageLike>;
  close(): Promise<void>;
}

export interface BrowserRuntimeLike {
  launch(options: { headless: boolean; executablePath: string }): Promise<BrowserLike>;
}

/**
 * Runs only when playwright-core and a browser executable are available.
 * Keeping this optional preserves the lightweight Node-only deployment.
 */
export async function validateInBrowser(
  url: string,
  executablePath?: string,
  interactions: BrowserInteraction[] = [],
  runtime?: BrowserRuntimeLike,
): Promise<BrowserValidationResult> {
  let browserRuntime = runtime;
  if (!browserRuntime) {
    let playwright: any;
    try {
      playwright = await import("playwright-core");
    } catch {
      return { ok: true, skipped: true, errors: [] };
    }
    browserRuntime = { launch: (options) => playwright.chromium.launch(options) };
  }
  if (!executablePath) return { ok: true, skipped: true, errors: [] };
  const errors: string[] = [];
  const browser = await browserRuntime.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("console", (message: any) => {
      if (message.type() === "error" && message.text() !== "Failed to load resource: the server responded with a status of 404 (Not Found)") {
        errors.push(message.text());
      }
    });
    page.on("response", (response: any) => {
      if (response.status() >= 400) errors.push(`资源请求失败 ${response.status()}: ${response.url()}`);
    });
    const response = await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
    if (!response || !response.ok()) errors.push(`页面返回 HTTP ${response?.status() || 0}`);
    await page.screenshot({ path: `/tmp/chat2app-${Date.now()}.png` });
    const interactionResults: Array<{ name: string; ok: boolean; error?: string }> = [];
    for (const interaction of interactions) {
      try {
        if (interaction.action === "click") await page.locator(interaction.selector).click();
        else if (interaction.action === "fill") await page.locator(interaction.selector).fill(interaction.value || "");
        else if (interaction.action === "press") await page.locator(interaction.selector).press(interaction.value || "Enter");
        else await page.locator(interaction.selector).waitFor({ state: "visible", timeout: 3000 });
        if (interaction.expectSelector) await page.locator(interaction.expectSelector).waitFor({ state: "visible", timeout: 3000 });
        interactionResults.push({ name: interaction.name, ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`交互验收失败 ${interaction.name}: ${message}`);
        interactionResults.push({ name: interaction.name, ok: false, error: message });
      }
    }
    return { ok: errors.length === 0, errors, interactions: interactionResults };
  } finally {
    await browser.close();
  }
}
