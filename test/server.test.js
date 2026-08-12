const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractHtml,
  extractTitle,
  validateGeneratedHtml,
  genId,
  genManifest,
  genIcon,
  parseSSE,
  assessRequestComplexity,
  extractRelevantHtml,
  buildIterationUserContext,
} = require("../server.js");
const { validateInBrowser } = require("../dist/src/browser-validator.js");
const { bundleFromHtml, applySearchReplace, assertSafeBundlePath, summarizeBundleChanges } = require("../dist/src/app-bundle.js");

test("extractHtml removes an html code fence", () => {
  const html = extractHtml("说明\n```html\n<!DOCTYPE html><html><body>你好</body></html>\n```");
  assert.equal(html, "<!DOCTYPE html><html><body>你好</body></html>");
});

test("extractHtml keeps a complete document and trims prose before html", () => {
  assert.equal(extractHtml("<!DOCTYPE html>\n<html><body>ok</body></html>"), "<!DOCTYPE html>\n<html><body>ok</body></html>");
  assert.equal(extractHtml("这是说明\n<html><body>ok</body></html>"), "<html><body>ok</body></html>");
});

test("extractTitle handles normal and malformed closing title tags", () => {
  assert.equal(extractTitle("<title>  记账 · 小应用 </title>"), "记账 · 小应用");
  assert.equal(extractTitle("<title>计时器title>"), "计时器");
  assert.equal(extractTitle("<html></html>"), "未命名应用");
});

test("validateGeneratedHtml rejects incomplete documents and invalid scripts", () => {
  assert.equal(validateGeneratedHtml("<html><title>x</title></html>"), "生成结果缺少 <!DOCTYPE html>");
  assert.match(validateGeneratedHtml("<!DOCTYPE html><html><title>x</title><script>if (</script></html>"), /JavaScript 语法检查失败/);
  assert.equal(validateGeneratedHtml("<!DOCTYPE html><html><head><title>x</title></head><body><script>const ok = true;</script></body></html>"), null);
});

test("AppBundle applies one unique SEARCH/REPLACE patch and rejects unsafe paths", () => {
  const bundle = bundleFromHtml("<!DOCTYPE html><html><head><title>旧标题</title></head><body>旧内容</body></html>");
  const updated = applySearchReplace(bundle, [{ path: "index.html", search: "旧标题", replace: "新标题" }]);
  assert.match(updated.files["index.html"], /新标题/);
  assert.throws(() => assertSafeBundlePath("../secret"), /不安全/);
  assert.throws(() => applySearchReplace(bundle, [{ path: "index.html", search: "不存在", replace: "x" }]), /当前 0 次/);
});

test("summarizeBundleChanges reports only changed files", () => {
  const before = { entry: "index.html", files: { "index.html": "old", "styles.css": "same" } };
  const after = { entry: "index.html", files: { "index.html": "new-value", "styles.css": "same" } };
  assert.deepEqual(summarizeBundleChanges(before, after), [{
    path: "index.html",
    changed: true,
    addedChars: 6,
    removedChars: 0,
  }]);
});

test("genId creates a safe non-empty id", () => {
  const id = genId();
  assert.match(id, /^[a-z0-9]+$/i);
  assert.ok(id.length >= 6);
});

test("genManifest creates an installable relative PWA manifest", () => {
  const manifest = genManifest("记账本 · Chat2App", "#123456");
  assert.deepEqual(manifest, {
    name: "记账本 · Chat2App",
    short_name: "记账本",
    lang: "zh-CN",
    start_url: "./",
    scope: "./",
    display: "standalone",
    background_color: "#0f1420",
    theme_color: "#123456",
    icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
  });
});

test("genIcon returns an SVG icon with a derived letter", () => {
  const icon = genIcon("A 计账");
  assert.match(icon, /^<svg[\s\S]*<\/svg>$/);
  assert.match(icon, />A<\/text>/);
});

test("parseSSE parses data events and ignores DONE", () => {
  const events = [];
  parseSSE(
    'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"世界"}}]}\n\n' +
      "data: [DONE]\n\n",
    (event) => events.push(event),
  );
  assert.equal(events.length, 2);
  assert.equal(events[0].choices[0].delta.content + events[1].choices[0].delta.content, "你好世界");
});

test("parseSSE ignores malformed events without stopping the stream", () => {
  const events = [];
  parseSSE('data: {bad json}\n\ndata: {"ok":true}\n\n', (event) => events.push(event));
  assert.deepEqual(events, [{ ok: true }]);
});

test("assessRequestComplexity classifies requests from progressive signals", () => {
  assert.equal(assessRequestComplexity("把标题改成账本").level, "simple");
  assert.equal(assessRequestComplexity("增加分类筛选并保存到 localStorage", { history: ["a", "b"] }).level, "medium");
  const complex = assessRequestComplexity("点击按钮没反应，修复数据同步", {
    browserErrors: ["ReferenceError: sync is not defined"],
    patchFailures: 1,
    htmlLength: 24000,
    history: ["a", "b", "c", "d"],
  });
  assert.equal(complex.level, "complex");
  assert.ok(complex.score >= 4);
});

test("extractRelevantHtml keeps matching code instead of only the document prefix", () => {
  const html = "<html>" + "x".repeat(20000) + "targetFunction" + "<script>const targetFunction = () => 1;</script></html>";
  const relevant = extractRelevantHtml(html, "修复 targetFunction", [], 1000);
  assert.ok(relevant.length <= 1000);
  assert.match(relevant, /targetFunction/);
});

test("buildIterationUserContext scales history and code context by complexity", () => {
  const html = "<!DOCTYPE html><html><body><button id=\"save\">保存</button></body></html>";
  const simple = buildIterationUserContext("改按钮文字", html, ["第一次需求"], { level: "simple" });
  assert.match(simple, /历史需求：\n无/);
  assert.match(simple, /当前应用代码/);
  const complex = buildIterationUserContext("修复保存按钮没反应", html, ["第一次需求", "第二次需求"], { level: "complex" });
  assert.match(complex, /这是复杂修改/);
  assert.match(complex, /第一次需求/);
});

test("validateInBrowser can execute a realistic fill-click-expect flow with injected runtime", async () => {
  const state = { value: "", saved: false };
  const runtime = {
    launch: async () => ({
      newPage: async () => ({
        on() {},
        async goto() {
          return { ok: () => true, status: () => 200 };
        },
        async screenshot() {},
        locator(selector) {
          return {
            async click() {
              if (selector === "#save") state.saved = state.value.trim().length > 0;
            },
            async fill(value) {
              if (selector === "#input") state.value = value;
            },
            async press(value) {
              if (selector === "#input" && value === "Enter") state.saved = state.value.trim().length > 0;
            },
            async waitFor() {
              if (selector === ".saved" && !state.saved) throw new Error("saved indicator missing");
            },
          };
        },
      }),
      async close() {},
    }),
  };
  const result = await validateInBrowser(
    "http://example.test/",
    "/fake/chrome",
    [
      { name: "输入内容", selector: "#input", action: "fill", value: "记一笔" },
      { name: "点击保存", selector: "#save", action: "click", expectSelector: ".saved" },
    ],
    runtime,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.interactions, [
    { name: "输入内容", ok: true },
    { name: "点击保存", ok: true },
  ]);
});

test("validateInBrowser can verify persisted state on a second visit", async () => {
  const localStorage = { saved: "", value: "" };
  let visitCount = 0;
  const runtime = {
    launch: async () => ({
      newPage: async () => {
        visitCount += 1;
        const state = { value: "", saved: false };
        return {
          on() {},
          async goto() {
            if (visitCount > 1) {
              state.saved = localStorage.saved === "1";
              state.value = localStorage.value;
            }
            return { ok: () => true, status: () => 200 };
          },
          async screenshot() {},
          locator(selector) {
            return {
              async click() {
                if (selector === "#save") {
                  state.saved = state.value.trim().length > 0;
                  if (state.saved) {
                    localStorage.saved = "1";
                    localStorage.value = state.value;
                  }
                }
              },
              async fill(value) {
                if (selector === "#input") state.value = value;
              },
              async press(value) {
                if (selector === "#input" && value === "Enter") {
                  state.saved = state.value.trim().length > 0;
                  if (state.saved) {
                    localStorage.saved = "1";
                    localStorage.value = state.value;
                  }
                }
              },
              async waitFor() {
                if (selector === ".saved" && !state.saved) throw new Error("saved indicator missing");
                if (selector === ".restored" && !state.saved) throw new Error("restored indicator missing");
              },
            };
          },
        };
      },
      async close() {},
    }),
  };

  const first = await validateInBrowser(
    "http://example.test/",
    "/fake/chrome",
    [
      { name: "输入内容", selector: "#input", action: "fill", value: "保存到本地" },
      { name: "点击保存", selector: "#save", action: "click", expectSelector: ".saved" },
    ],
    runtime,
  );
  assert.equal(first.ok, true);

  const second = await validateInBrowser(
    "http://example.test/",
    "/fake/chrome",
    [{ name: "确认恢复", selector: ".restored", action: "assert" }],
    runtime,
  );
  assert.equal(second.ok, true);
  assert.deepEqual(second.interactions, [{ name: "确认恢复", ok: true }]);
});

test("validateInBrowser can model a counter app with increment and persistence", async () => {
  const storage = { count: "0" };
  let visitCount = 0;
  const runtime = {
    launch: async () => ({
      newPage: async () => {
        visitCount += 1;
        const state = { count: 0 };
        return {
          on() {},
          async goto() {
            if (visitCount > 1) state.count = Number(storage.count || "0");
            return { ok: () => true, status: () => 200 };
          },
          async screenshot() {},
          locator(selector) {
            return {
              async click() {
                if (selector === "#inc") {
                  state.count += 1;
                  storage.count = String(state.count);
                }
              },
              async fill(value) {
                if (selector === "#seed") {
                  state.count = Number(value || 0);
                  storage.count = String(state.count);
                }
              },
              async press(value) {
                if (selector === "#seed" && value === "Enter") {
                  storage.count = String(state.count);
                }
              },
              async waitFor() {
                if (selector === ".count" && Number(storage.count || "0") < 1) throw new Error("counter not updated");
                if (selector === ".persisted" && visitCount < 2) throw new Error("not restored yet");
              },
            };
          },
        };
      },
      async close() {},
    }),
  };

  const first = await validateInBrowser(
    "http://example.test/",
    "/fake/chrome",
    [
      { name: "设置初值", selector: "#seed", action: "fill", value: "0" },
      { name: "点击加一", selector: "#inc", action: "click", expectSelector: ".count" },
    ],
    runtime,
  );
  assert.equal(first.ok, true);

  const second = await validateInBrowser(
    "http://example.test/",
    "/fake/chrome",
    [{ name: "确认计数恢复", selector: ".persisted", action: "assert" }],
    runtime,
  );
  assert.equal(second.ok, true);
  assert.deepEqual(second.interactions, [{ name: "确认计数恢复", ok: true }]);
});

test("model adapter parses streamed deltas", () => {
  const { parseSSE: parseModelSSE } = require("../dist/src/model-adapter.js");
  const chunks = [];
  parseModelSSE('data: {"choices":[{"delta":{"content":"a"}}]}\n\n', (event) => chunks.push(event.choices[0].delta.content));
  assert.deepEqual(chunks, ["a"]);
});
