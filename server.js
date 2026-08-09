#!/usr/bin/env node
/**
 * Chat2App · 云端版
 * 手机 PWA 聊天 -> DeepSeek 流式生成单文件应用 -> 发布到 /apps/<id>/ 立即可访问
 *
 * 零 npm 依赖，Node 18+。配置：config.json 或环境变量（.env）
 * 生产部署见 README.md（Docker / systemd / Nginx）
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileP = promisify(execFile);

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const APPS_DIR = path.resolve(ROOT, process.env.APPS_DIR || "apps-data");
const PORT = Number(process.env.PORT || 8787);

/* ---------- 配置 ---------- */
function loadConfig() {
  const p = path.join(ROOT, "config.json");
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  return {};
}
const config = loadConfig();

function loadEnv() {
  const p = path.join(ROOT, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || config.deepseekApiKey || "";
const DEEPSEEK_URL = process.env.DEEPSEEK_URL || config.deepseekUrl || "https://api.deepseek.com/chat/completions";
const MODEL = config.model || "deepseek-chat";
const API_TOKEN = process.env.API_TOKEN || config.apiToken || "";
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_HOUR || config.rateLimitPerHour || 0);
const BASE_URL = (process.env.BASE_URL || config.baseUrl || "https://freexlib.com").replace(/\/+$/, "");

/* ---------- 系统提示词 ---------- */
const SYSTEM_PROMPT = `你是一个"极客小应用生成器"。用户会描述一个小应用需求，你要生成一个**完整、可直接运行、精致得像正经 App 的单个 HTML 文件**。

硬性要求：
1. 输出**只能**是一个完整的 HTML 文档（以 <!DOCTYPE html> 开头），不要输出任何解释文字，不要用 markdown 代码围栏。
2. 所有 CSS 和 JS 必须内联在同一个文件里，禁止引用任何外部文件/CDN/框架，用原生 HTML/CSS/JS。
3. 移动端优先：适配手机屏幕（viewport），桌面也能用。
4. **聚焦一个核心功能，做精做透**，不要堆砌功能；界面要现代精致（深色/渐变/圆角/阴影/动效），像正经 App 而不像演示页。
5. 所有用户数据用 localStorage 持久化；交互逻辑必须真实可用（按钮、输入、切换都要有效果）。
6. 必须完整可用，禁止占位符、TODO、假数据。
7. 界面文案用中文。
8. 页面要包含 <title>、<meta name="theme-color">、<meta name="apple-mobile-web-app-capable" content="yes"> 等 PWA 友好标签；不要包含 <link rel="manifest">（工具会自动添加）。
9. 写完自己检查一遍：逻辑能跑通、样式完整、无语法错误。`;

/* ---------- 迭代修改提示词 ---------- */
const ITERATE_SYSTEM_PROMPT = `你是一个"极客小应用修改器"。用户已经有一个小应用（完整 HTML 见下），他会继续提修改要求。

硬性要求：
1. 基于现有 HTML 修改，**保留所有已有功能和数据**（localStorage 的键名不要改）。
2. 输出**只能**是一个完整的 HTML 文档（以 <!DOCTYPE html> 开头），不要任何解释文字，不要 markdown 围栏。
3. 所有 CSS 和 JS 必须内联，禁止引用外部文件/CDN 框架。
4. 移动端优先，UI 精致现代，界面文案中文；改动要体现到界面上，不要只说不动。
5. 必须完整可用，禁止占位符、TODO、假数据。
6. 如果新要求与旧功能冲突，以新要求为准，但尽量保留有用的旧功能。
7. 页面保留 <title>、theme-color、apple-mobile-web-app-capable 等 PWA 标签；不要加 <link rel="manifest">（工具会自动添加）。
8. 写完自己检查一遍：新功能真的能用、样式完整、无语法错误。`;

/* ---------- 工具函数 ---------- */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
function sendText(res, code, text, type, extraHeaders) {
  res.writeHead(code, { "Content-Type": (type || "text/plain") + "; charset=utf-8", ...(extraHeaders || {}) });
  res.end(text);
}
const MIME = {
  ".html": "text/html", ".js": "application/javascript", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".css": "text/css", ".webmanifest": "application/manifest+json",
};

// 从 DeepSeek 的 SSE 流中逐条转发（text 为已解码字符串）
// 注意：不要用 Uint8Array.toString("utf8")，那会得到逗号分隔的字节数字。
function parseSSE(text, onData) {
  for (const block of text.split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const j = JSON.parse(data);
      onData(j);
    } catch { /* 忽略不完整块 */ }
  }
}

/* ---------- 访问控制 ---------- */
function checkAuth(req) {
  if (!API_TOKEN) return null;
  const h = req.headers.authorization || "";
  return h === "Bearer " + API_TOKEN ? null : "访问口令错误";
}
const rateMap = new Map();
function checkRate(ip) {
  if (!RATE_LIMIT) return null;
  const now = Date.now();
  const rec = rateMap.get(ip);
  if (!rec || now > rec.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + 3600e3 });
    return null;
  }
  rec.count++;
  if (rec.count > RATE_LIMIT) {
    const waitMin = Math.ceil((rec.resetAt - now) / 60000);
    return `请求太频繁了，请 ${waitMin} 分钟后再试。`;
  }
  return null;
}
function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  return fwd ? fwd.split(",")[0].trim() : req.socket.remoteAddress || "?";
}

/* ---------- 生成产物 ---------- */
function extractHtml(raw) {
  let s = raw.trim();
  const fence = s.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  if (!/^<!DOCTYPE html>/i.test(s) && /<html[\s>]/i.test(s)) {
    s = s.slice(s.toLowerCase().indexOf("<html"));
  }
  return s;
}
function extractTitle(html) {
  // 宽容匹配：模型偶尔会输出 </title> 缺斜杠（如 <title>x</title> 或 <title>xtitle>）
  const m = html.match(/<title[^>]*>([\s\S]*?)(?:<\/?title>|title>)/i);
  return m ? m[1].trim().replace(/\s+/g, " ") : "未命名应用";
}
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function genManifest(name, theme) {
  const short = name.replace(/\s*[·｜|].*$/, "").slice(0, 12) || "小应用";
  return {
    name, short_name: short, lang: "zh-CN",
    start_url: "./", scope: "./", display: "standalone",
    background_color: "#0f1420", theme_color: theme || "#4f8cff",
    icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
  };
}
const SW_JS = `/* Chat2App 生成的 Service Worker：离线可打开 */\nconst C="chat2app-v1";const SHELL=["./","./index.html","./manifest.json","./icon.svg"];\nself.addEventListener("install",e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});\nself.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});\nself.addEventListener("fetch",e=>{const r=e.request;if(r.method!=="GET")return;const u=new URL(r.url);if(u.origin!==self.location.origin)return;const nav=r.mode==="navigate"||u.pathname.endsWith("index.html")||u.pathname.endsWith("/");if(nav){e.respondWith(fetch(r).then(x=>{const c=x.clone();caches.open(C).then(c=>c.put(r,c));return x}).catch(()=>caches.match(r).then(m=>m||caches.match("./index.html"))));return}e.respondWith(caches.match(r).then(m=>m||fetch(r).then(x=>{const c=x.clone();caches.open(C).then(c=>c.put(r,c));return x})))});\n`;
function genIcon(name) {
  const letter = (name.replace(/[^A-Za-z0-9\u4e00-\u9fa5]/g, "")[0] || "A").toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f8cff"/><stop offset="1" stop-color="#7a5cff"/></linearGradient></defs><rect width="512" height="512" rx="112" fill="url(#g)"/><text x="256" y="332" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="240" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text></svg>`;
}

/* ---------- 发布（云端默认 local：文件直接落到本机磁盘，由本服务对外提供） ---------- */
async function deploy(id, files) {
  const mode = (config.deploy && config.deploy.mode) || "local";
  if (mode === "local") return { mode, ok: true, detail: "已发布到 /apps/" + id + "/" };
  if (mode === "ftp") {
    const f = config.deploy.ftp || {};
    if (!f.host || !f.user) return { mode, ok: false, detail: "config.json 缺少 deploy.ftp.host/user" };
    const base = "ftp://" + f.host + (f.pathPrefix || "") + "/apps/" + id;
    const args = ["-sS", "--ftp-create-dirs", "-u", f.user + ":" + (f.pass || "")];
    const results = [];
    for (const file of files) {
      try {
        await execFileP("curl", [...args, "-T", path.join(APPS_DIR, id, file), base + "/" + file], { timeout: 30000 });
        results.push(file + " ✓");
      } catch (e) {
        return { mode, ok: false, detail: file + " 上传失败: " + (e.stderr || e.message) };
      }
    }
    return { mode, ok: true, detail: results.join("  ") };
  }
  if (mode === "command") {
    const tmpl = config.deploy.command || "";
    if (!tmpl) return { mode, ok: false, detail: "config.json 缺少 deploy.command" };
    const cmd = tmpl.replaceAll("{id}", id).replaceAll("{dir}", path.join(APPS_DIR, id));
    try {
      await execFileP("sh", ["-c", cmd], { timeout: 60000 });
      return { mode, ok: true, detail: "命令执行成功：" + cmd };
    } catch (e) {
      return { mode, ok: false, detail: "命令失败: " + (e.stderr || e.message) + "\n命令：" + cmd };
    }
  }
  return { mode, ok: false, detail: "未知发布模式: " + mode };
}

/* ---------- 应用列表 ---------- */
function listApps() {
  if (!fs.existsSync(APPS_DIR)) return [];
  const apps = [];
  for (const id of fs.readdirSync(APPS_DIR)) {
    if (!/^[a-z0-9]+$/i.test(id)) continue;
    const dir = path.join(APPS_DIR, id);
    if (!dir.startsWith(APPS_DIR) || !fs.statSync(dir).isDirectory()) continue;
    const indexHtml = path.join(dir, "index.html");
    if (!fs.existsSync(indexHtml)) continue;
    let title = "未命名应用", version = 1, updatedAt = null;
    const sp = path.join(dir, "session.json");
    if (fs.existsSync(sp)) {
      try {
        const s = JSON.parse(fs.readFileSync(sp, "utf8"));
        if (s.title) title = s.title;
        if (typeof s.version === "number") version = s.version;
        if (s.updatedAt) updatedAt = s.updatedAt;
      } catch {}
    }
    if (!title || title === "未命名应用") {
      try { title = extractTitle(fs.readFileSync(indexHtml, "utf8")); } catch {}
    }
    if (!updatedAt) {
      try { updatedAt = fs.statSync(indexHtml).mtime.toISOString(); } catch {}
    }
    let size = 0;
    for (const f of ["index.html", "manifest.json", "sw.js", "icon.svg"]) {
      try { size += fs.statSync(path.join(dir, f)).size; } catch {}
    }
    const vDir = path.join(dir, "versions");
    let versions = 0;
    if (fs.existsSync(vDir)) {
      try { versions = fs.readdirSync(vDir).filter((f) => /^v\d+\.html$/.test(f)).length; } catch {}
    }
    apps.push({ id, title, version, versions, updatedAt, size, url: BASE_URL + "/apps/" + id + "/" });
  }
  apps.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return apps;
}

/* ---------- 生成主流程 ---------- */
async function handleGenerate(req, res, bodyText, ip) {
  let body;
  try { body = JSON.parse(bodyText); } catch { return sendJson(res, 400, { error: "请求体不是合法 JSON" }); }
  const prompt = (body.prompt || "").trim();
  if (!prompt) return sendJson(res, 400, { error: "prompt 不能为空" });
  if (!DEEPSEEK_KEY) return sendJson(res, 400, { error: "服务端未配置 DEEPSEEK_API_KEY" });

  const authErr = checkAuth(req);
  if (authErr) return sendJson(res, 401, { error: authErr });
  const rateErr = checkRate(ip);
  if (rateErr) return sendJson(res, 429, { error: rateErr });

  // 会话：传了有效 sessionId -> 在已有应用上迭代修改；否则新建应用
  const sessionId = (body.sessionId || "").trim();
  let isIteration = false;
  let existingHtml = null;
  if (sessionId) {
    if (!/^[a-z0-9]+$/i.test(sessionId)) return sendJson(res, 400, { error: "无效的会话" });
    const existingPath = path.join(APPS_DIR, sessionId, "index.html");
    if (existingPath.startsWith(APPS_DIR) && fs.existsSync(existingPath)) {
      isIteration = true;
      existingHtml = fs.readFileSync(existingPath, "utf8");
    } else {
      return sendJson(res, 400, { error: "会话不存在，请重新开始" });
    }
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  });
  const sse = (obj) => res.write("data: " + JSON.stringify(obj) + "\n\n");

  sse({ type: "status", text: isIteration ? "正在根据你的要求修改应用…" : "正在创建应用…" });
  const messages = isIteration
    ? [
        { role: "system", content: ITERATE_SYSTEM_PROMPT },
        { role: "user", content: "现有应用的完整 HTML：\n```html\n" + existingHtml + "\n```\n\n用户的修改要求：\n" + prompt },
      ]
    : [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: "需求：\n" + prompt },
      ];
  let upstream;
  try {
    upstream = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + DEEPSEEK_KEY },
      body: JSON.stringify({ model: MODEL, messages, stream: true, temperature: 0.7 }),
    });
  } catch (e) {
    sse({ type: "error", message: "请求 DeepSeek 失败（网络错误）：" + e.message });
    res.end();
    return;
  }
  if (!upstream.ok) {
    let detail = "";
    try { detail = (await upstream.text()).slice(0, 300); } catch {}
    sse({ type: "error", message: "DeepSeek 返回 " + upstream.status + "：" + detail });
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  let raw = "";
  const decoder = new TextDecoder();
  let lastFlush = Date.now();
  // 关键：SSE 事件可能被 TCP 拆分到多次 read()，必须跨读取缓冲，
  // 攒够完整的 "\n\n" 分隔事件再解析，否则半个 JSON 会整块丢失。
  let sseBuf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuf += decoder.decode(value, { stream: true });
      const parts = sseBuf.split("\n\n");
      sseBuf = parts.pop();
      for (const part of parts) {
        parseSSE(part, (j) => {
          const delta = j.choices && j.choices[0] && j.choices[0].delta;
          if (delta && delta.content) {
            raw += delta.content;
            sse({ type: "token", text: delta.content });
            lastFlush = Date.now();
          }
        });
      }
      if (Date.now() - lastFlush > 15000) {
        sse({ type: "ping" });
        lastFlush = Date.now();
      }
    }
  } catch (e) {
    sse({ type: "error", message: "读取流中断：" + e.message });
    res.end();
    return;
  }
  if (raw.length < 200) {
    if (process.env.DEBUG) console.error("[debug] raw.length =", raw.length);
    sse({ type: "error", message: "生成内容过短，可能被模型拒绝或网络异常，请重试。" });
    res.end();
    return;
  }

  sse({ type: "status", text: isIteration ? "正在更新应用…" : "正在打包并发布…" });
  const html = extractHtml(raw);
  const title = extractTitle(html);
  const id = isIteration ? sessionId : genId();
  const appDir = path.join(APPS_DIR, id);
  fs.mkdirSync(appDir, { recursive: true });

  // 版本管理：迭代前把当前版本备份到 versions/
  const sessionPath = path.join(appDir, "session.json");
  let curVersion = 0;
  if (fs.existsSync(sessionPath)) {
    try { curVersion = JSON.parse(fs.readFileSync(sessionPath, "utf8")).version || 0; } catch {}
  }
  const newVersion = curVersion + 1;
  if (isIteration && curVersion > 0) {
    const vDir = path.join(appDir, "versions");
    fs.mkdirSync(vDir, { recursive: true });
    fs.copyFileSync(path.join(appDir, "index.html"), path.join(vDir, "v" + curVersion + ".html"));
  }
  const files = ["index.html", "manifest.json", "sw.js", "icon.svg"];
  fs.writeFileSync(path.join(appDir, "index.html"), html);
  fs.writeFileSync(path.join(appDir, "manifest.json"), JSON.stringify(genManifest(title, "#4f8cff"), null, 2));
  fs.writeFileSync(path.join(appDir, "sw.js"), SW_JS);
  fs.writeFileSync(path.join(appDir, "icon.svg"), genIcon(title));
  fs.writeFileSync(sessionPath, JSON.stringify({ version: newVersion, title, updatedAt: new Date().toISOString() }));
  console.log("[" + new Date().toISOString() + "] " + (isIteration ? "迭代" : "生成") + " " + id + " · " + title + " · v" + newVersion + " · ip=" + ip);

  const result = await deploy(id, files);
  sse({
    type: "done",
    result: {
      id, sessionId: id, title, version: newVersion, isIteration,
      url: BASE_URL + "/apps/" + id + "/",
      files, deploy: result,
    },
  });
  res.end();
}

/* ---------- 静态文件 ---------- */
function servePublic(res, rel) {
  const p = path.join(PUBLIC, rel);
  if (!p.startsWith(PUBLIC) || !fs.existsSync(p) || !fs.statSync(p).isFile()) return sendText(res, 404, "not found", "text/plain");
  sendText(res, 200, fs.readFileSync(p), MIME[path.extname(p)] || "application/octet-stream");
}
function serveApp(res, id, rel) {
  if (!/^[a-z0-9]+$/i.test(id)) return sendText(res, 404, "not found", "text/plain");
  const base = path.join(APPS_DIR, id);
  if (!base.startsWith(APPS_DIR)) return sendText(res, 404, "not found", "text/plain");
  const relSafe = rel.split("/").filter((s) => s && s !== "..").join("/");
  const p = path.join(base, relSafe || "index.html");
  if (!p.startsWith(base) || !fs.existsSync(p) || !fs.statSync(p).isFile()) return sendText(res, 404, "not found", "text/plain");
  sendText(res, 200, fs.readFileSync(p), MIME[path.extname(p)] || "application/octet-stream", { "Cache-Control": "no-cache" });
}

/* ---------- HTTP 路由 ---------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:" + PORT);
  const p = url.pathname;

  if (req.method === "GET" && p === "/api/health") {
    return sendJson(res, 200, { ok: true, time: new Date().toISOString(), apps: fs.existsSync(APPS_DIR) ? fs.readdirSync(APPS_DIR).length : 0 });
  }
  if (req.method === "GET" && p === "/api/config") {
    return sendJson(res, 200, {
      baseUrl: BASE_URL, model: MODEL,
      hasKey: !!DEEPSEEK_KEY, authRequired: !!API_TOKEN, rateLimitPerHour: RATE_LIMIT,
    });
  }
  // 应用列表（需口令）
  if (req.method === "GET" && p === "/api/apps") {
    const authErr = checkAuth(req);
    if (authErr) return sendJson(res, 401, { error: authErr });
    return sendJson(res, 200, { apps: listApps() });
  }
  // 删除应用（需口令）
  const delMatch = p.match(/^\/api\/apps\/([a-z0-9]+)$/i);
  if (req.method === "DELETE" && delMatch) {
    const authErr = checkAuth(req);
    if (authErr) return sendJson(res, 401, { error: authErr });
    const id = delMatch[1];
    const dir = path.join(APPS_DIR, id);
    if (!dir.startsWith(APPS_DIR) || !fs.existsSync(dir)) return sendJson(res, 404, { error: "应用不存在" });
    fs.rmSync(dir, { recursive: true, force: true });
    console.log("[" + new Date().toISOString() + "] 删除 " + id + " · ip=" + clientIp(req));
    return sendJson(res, 200, { ok: true });
  }
  // 回退到上一版（需口令）
  const rbMatch = p.match(/^\/api\/apps\/([a-z0-9]+)\/rollback$/i);
  if (req.method === "POST" && rbMatch) {
    const authErr = checkAuth(req);
    if (authErr) return sendJson(res, 401, { error: authErr });
    const id = rbMatch[1];
    const dir = path.join(APPS_DIR, id);
    if (!dir.startsWith(APPS_DIR) || !fs.existsSync(dir)) return sendJson(res, 404, { error: "应用不存在" });
    const sessionPath = path.join(dir, "session.json");
    let version = 1;
    if (fs.existsSync(sessionPath)) {
      try { version = JSON.parse(fs.readFileSync(sessionPath, "utf8")).version || 1; } catch {}
    }
    if (version <= 1) return sendJson(res, 400, { error: "没有可回退的版本" });
    const prevPath = path.join(dir, "versions", "v" + (version - 1) + ".html");
    if (!prevPath.startsWith(dir) || !fs.existsSync(prevPath)) return sendJson(res, 400, { error: "找不到上一版" });
    // 当前版也存档（回退可逆）
    fs.copyFileSync(path.join(dir, "index.html"), path.join(dir, "versions", "v" + version + ".html"));
    fs.copyFileSync(prevPath, path.join(dir, "index.html"));
    const newVersion = version - 1;
    const title = extractTitle(fs.readFileSync(path.join(dir, "index.html"), "utf8"));
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(genManifest(title, "#4f8cff"), null, 2));
    fs.writeFileSync(path.join(dir, "icon.svg"), genIcon(title));
    fs.writeFileSync(sessionPath, JSON.stringify({ version: newVersion, title, updatedAt: new Date().toISOString() }));
    console.log("[" + new Date().toISOString() + "] 回退 " + id + " · " + title + " · v" + newVersion + " · ip=" + clientIp(req));
    return sendJson(res, 200, { ok: true, id, version: newVersion, title, url: BASE_URL + "/apps/" + id + "/" });
  }
  if (req.method === "POST" && p === "/api/generate") {
    let bodyText = "";
    req.on("data", (c) => { bodyText += c; if (bodyText.length > 2e6) req.destroy(); });
    req.on("end", () => handleGenerate(req, res, bodyText, clientIp(req)));
    return;
  }

  // 聊天界面本身（PWA）
  if (req.method === "GET" && (p === "/" || p === "/index.html")) return servePublic(res, "index.html");
  if (req.method === "GET" && ["/manifest.json", "/sw.js", "/icon.svg", "/icon.png"].includes(p)) {
    return servePublic(res, p.slice(1));
  }

  // 生成的子应用：/apps/<id>/...   （公开访问，无需口令）
  const appMatch = p.match(/^\/apps\/([a-z0-9]+)(\/.*)?$/i);
  if (req.method === "GET" && appMatch) {
    if (!appMatch[2] || appMatch[2] === "/") {
      // /apps/<id> 或 /apps/<id>/ -> 补上尾部斜杠，保证相对路径正确
      if (p.endsWith("/")) return serveApp(res, appMatch[1], "index.html");
      return sendText(res, 302, "", "text/plain", { Location: "/apps/" + appMatch[1] + "/" });
    }
    return serveApp(res, appMatch[1], appMatch[2].replace(/^\//, ""));
  }

  sendText(res, 404, "not found", "text/plain");
});

if (require.main === module) {
  fs.mkdirSync(APPS_DIR, { recursive: true });
  server.listen(PORT, "0.0.0.0", () => {
    console.log("Chat2App（云端版）已启动：http://0.0.0.0:" + PORT);
    console.log("公开域名：" + BASE_URL);
    console.log("应用存储：" + APPS_DIR);
    console.log("DeepSeek Key：" + (DEEPSEEK_KEY ? "已配置" : "未配置"));
    console.log("访问口令：" + (API_TOKEN ? "已开启" : "未开启（公开可生成，建议开启）"));
    console.log("限流：" + (RATE_LIMIT ? "每小时 " + RATE_LIMIT + " 次/IP" : "未开启"));
  });
}

module.exports = { extractHtml, extractTitle, genId, genManifest, genIcon, deploy, parseSSE, SW_JS };
