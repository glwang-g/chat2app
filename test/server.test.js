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
} = require("../server.js");
const { bundleFromHtml, applySearchReplace, assertSafeBundlePath } = require("../dist/src/app-bundle.js");

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
