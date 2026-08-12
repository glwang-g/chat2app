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
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileP = promisify(execFile);
const { bundleFromHtml, applySearchReplace, assertSafeBundlePath, summarizeBundleChanges } = require("./src/app-bundle");
const { validateInBrowser } = require("./src/browser-validator");
const { streamChat, completeChat } = require("./src/model-adapter");

/** @typedef {import("./src/contracts").AppManifest} AppManifest */
/** @typedef {import("./src/contracts").AppSession} AppSession */
/** @typedef {import("./src/contracts").AppSummary} AppSummary */
/** @typedef {import("./src/contracts").DeployResult} DeployResult */
/** @typedef {import("./src/contracts").SseEvent} SseEvent */
/** @typedef {import("./src/contracts").GenerateResult} GenerateResult */

const ROOT = path.basename(__dirname) === "dist" ? path.resolve(__dirname, "..") : __dirname;
const PUBLIC = path.join(ROOT, "public");
const APPS_DIR = path.resolve(ROOT, process.env.APPS_DIR || "apps-data");
const TASKS_DIR = path.resolve(ROOT, process.env.TASKS_DIR || "tasks-data");
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
// DeepSeek V4 思考模式默认开启（又慢又贵）；默认显式关闭，保持旧 deepseek-chat 的非思考行为
const THINKING = (process.env.THINKING || config.thinking) ? "enabled" : "disabled";
const BROWSER_VALIDATION = process.env.BROWSER_VALIDATION === "true" || config.browserValidation === true;
const BROWSER_EXECUTABLE = process.env.BROWSER_EXECUTABLE || config.browserExecutable || "";
const BROWSER_INTERACTIONS = Array.isArray(config.browserInteractions) ? config.browserInteractions : [];
const MODEL_OPTIONS = { url: DEEPSEEK_URL, apiKey: DEEPSEEK_KEY, model: MODEL };

/* ---------- 系统提示词 ---------- */
const SYSTEM_PROMPT = `你是一个"极客小应用生成器"。用户会描述一个小应用需求，你要生成一个**完整、可直接运行、精致得像正经 App 的单个 HTML 文件**。

**输出格式（必须严格遵守）**：
第一步：先输出【实现计划】——用 2-4 条短句说明准备实现的核心功能和验证重点。
第二步：输出【改动说明】——用 2-4 句中文说明实际完成了什么。
第三步：单独一行输出【完整代码】。
第四步：用 \`\`\`html 代码块包裹完整的 HTML。

其他硬性要求：
1. HTML 必须是完整文档（<!DOCTYPE html> 开头），所有 CSS/JS 内联，禁止外部文件/CDN/框架。
2. 移动端优先，桌面也能用；界面精致现代（深色/渐变/圆角/阴影/动效）。
3. **聚焦一个核心功能，做精做透**；交互逻辑必须真实可用；数据用 localStorage。
4. 禁止占位符、TODO、假数据；界面文案中文。
5. 页面包含 <title>、theme-color、apple-mobile-web-app-capable 等 PWA 标签；不要加 <link rel="manifest">。
6. 写完自己检查一遍：逻辑能跑通、样式完整、无语法错误。`;

/* ---------- 迭代修改提示词 ---------- */
const ITERATE_SYSTEM_PROMPT = `你是一个"极客小应用修改器"。用户已经有一个小应用（完整 HTML 见下），他会继续提修改要求。

**输出格式（必须严格遵守）**：
第一步：先输出【实现计划】——用 2-4 条短句说明修改范围、保留的功能和验证重点。
第二步：优先输出 SEARCH/REPLACE 增量补丁，格式为：
【增量补丁】
\`\`\`json
[{"path":"index.html","search":"唯一的旧代码","replace":"修改后的代码"}]
\`\`\`
只有无法安全用补丁表达时，才输出【完整代码】及完整 HTML。
最后输出【改动说明】——用 2-4 句中文说明实际改动。

其他硬性要求：
1. 基于现有 HTML 修改，**保留所有已有功能和数据**（localStorage 键名不要改）。
2. HTML 必须完整（<!DOCTYPE html> 开头），所有 CSS/JS 内联，禁止外部文件/CDN。
3. 移动端优先，界面精致现代，文案中文；改动必须真实体现在代码里。
4. 禁止占位符、TODO、假数据。
5. 页面保留 <title>、theme-color、apple-mobile-web-app-capable 等 PWA 标签；不要加 <link rel="manifest">。
6. 写完自己检查一遍：新功能真的能用、样式完整、无语法错误。`;

/* ---------- 工具函数 ---------- */
/** @param {import("node:http").ServerResponse} res @param {number} code @param {unknown} obj */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
/** @param {import("node:http").ServerResponse} res @param {number} code @param {string|Buffer} text @param {string} [type] @param {import("node:http").OutgoingHttpHeaders} [extraHeaders] */
function sendText(res, code, text, type = undefined, extraHeaders = undefined) {
  res.writeHead(code, { "Content-Type": (type || "text/plain") + "; charset=utf-8", ...(extraHeaders || {}) });
  res.end(text);
}
const MIME = {
  ".html": "text/html", ".js": "application/javascript", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".css": "text/css", ".webmanifest": "application/manifest+json",
};

// 从 DeepSeek 的 SSE 流中逐条转发（text 为已解码字符串）
// 注意：不要用 Uint8Array.toString("utf8")，那会得到逗号分隔的字节数字。
/** @param {string} text @param {(event: SseEvent) => void} onData */
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

function parseGeneratedOutput(raw, baseHtml = null) {
  const patchBlock = raw.match(/【增量补丁】\s*```(?:json)?\s*([\s\S]*?)```/i);
  if (baseHtml && patchBlock) {
    try {
      const patches = JSON.parse(patchBlock[1]);
      if (Array.isArray(patches) && patches.length) {
        const patched = applySearchReplace(bundleFromHtml(baseHtml), patches);
        const html = patched.files["index.html"];
        return { html, feedback: raw.replace(patchBlock[0], "").replace(/【实现计划】|【改动说明】/g, "").trim(), mode: "patch" };
      }
    } catch {}
  }
  let html = raw.trim();
  let feedback = "";
  const fenceM = raw.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fenceM) {
    html = fenceM[1].trim();
    feedback = raw.slice(0, fenceM.index).replace(/【实现计划】|【改动说明】|【完整代码】/g, "").trim();
  }
  return { html: extractHtml(html), feedback, mode: "full" };
}

const COMPLEXITY_KEYWORDS = /修复|报错|错误|异常|白屏|没反应|无响应|丢数据|数据丢失|崩溃|不工作|登录|同步|统计图|图表|异步|接口|请求|持久化|localStorage|跨模块|重构/i;

function assessRequestComplexity(prompt: string, options: {
  browserErrors?: string[];
  history?: string[];
  htmlLength?: number;
  patchFailures?: number;
  patchCount?: number;
} = {}) {
  const errors = Array.isArray(options.browserErrors) ? options.browserErrors : [];
  const history = Array.isArray(options.history) ? options.history : [];
  const htmlLength = Number(options.htmlLength || 0);
  const patchFailures = Number(options.patchFailures || 0);
  const patchCount = Number(options.patchCount || 0);
  let score = 0;
  const reasons = [];
  if (COMPLEXITY_KEYWORDS.test(prompt)) { score++; reasons.push("需求包含修复或复杂功能信号"); }
  if (errors.length) { score++; reasons.push("存在浏览器错误"); }
  if (patchFailures > 0) { score++; reasons.push("Patch 曾失败"); }
  if (patchCount > 2) { score++; reasons.push("一次修改涉及多个位置"); }
  if (/并|同时|以及|另外/.test(prompt)) { score++; reasons.push("需求同时涉及多个修改点"); }
  if (htmlLength > 18000) { score++; reasons.push("当前 HTML 较大"); }
  if (history.length > 3) { score++; reasons.push("需要较多历史上下文"); }
  const level = score >= 4 ? "complex" : score >= 2 ? "medium" : "simple";
  return { level, score, reasons };
}

function compactHistory(history, limit = 3) {
  return history.slice(-limit).map((item, index) => `${index + 1}. ${item}`).join("\n");
}

function extractRelevantHtml(html, prompt, errors = [], maxChars = 14000) {
  if (!html || html.length <= maxChars) return html;
  const terms = [...String(prompt).matchAll(/[A-Za-z_$][\w$-]{2,}|[\u4e00-\u9fff]{2,8}/g)].map((m) => m[0]);
  for (const error of errors) terms.push(...String(error).match(/[A-Za-z_$][\w$]*/g) || []);
  const uniqueTerms = [...new Set(terms)].filter((term) => term.length >= 2).slice(0, 24);
  const chunks = [];
  for (const term of uniqueTerms) {
    let index = html.indexOf(term);
    if (index < 0) continue;
    const start = Math.max(0, index - Math.floor(maxChars / 2));
    const end = Math.min(html.length, start + maxChars);
    chunks.push(html.slice(start, end));
  }
  const selected = [...new Set(chunks)].join("\n\n<!-- 相关代码片段 -->\n\n");
  return selected ? selected.slice(0, maxChars) : html.slice(0, maxChars);
}

function buildIterationUserContext(prompt, html, history, complexity) {
  const historyText = complexity.level === "simple" ? "无" : compactHistory(history);
  const htmlText = complexity.level === "complex"
    ? extractRelevantHtml(html, prompt, [], 14000)
    : html;
  const scope = complexity.level === "complex"
    ? "这是复杂修改。以下是与需求相关的代码片段；请优先返回精确的 SEARCH/REPLACE Patch，无法安全定位时再返回完整 HTML。"
    : "请优先返回精确的 SEARCH/REPLACE Patch；每个 SEARCH 必须在对应文件中恰好匹配一次。";
  return `${scope}\n\n历史需求：\n${historyText}\n\n当前应用代码：\n\`\`\`html\n${htmlText}\n\`\`\`\n\n用户的修改要求：\n${prompt}`;
}

function buildContextPlan(prompt, html, history, complexity, errors = []) {
  const fullHtmlChars = html.length;
  const selectedHtml = complexity.level === "complex" ? extractRelevantHtml(html, prompt, errors, 14000) : html;
  return {
    strategy: complexity.level === "simple" ? "current-document" : "focused-context",
    complexity: complexity.level,
    historyEntries: history.length,
    fullHtmlChars,
    selectedHtmlChars: selectedHtml.length,
    selectedHtmlRatio: fullHtmlChars ? Number((selectedHtml.length / fullHtmlChars).toFixed(3)) : 0,
    reasons: complexity.reasons,
  };
}

function buildRepairPrompt(html, errors, prompt = "", history = []) {
  const complexity = assessRequestComplexity(prompt || "修复浏览器错误", { browserErrors: errors, htmlLength: html.length, history });
  const relevant = complexity.level === "complex" ? extractRelevantHtml(html, prompt, errors) : html;
  const contextNote = complexity.level === "complex"
    ? "问题较复杂，下面先给出相关代码片段；请结合错误定位并返回修复后的完整 HTML。"
    : "请基于完整 HTML 修复问题。";
  return { complexity, prompt: `请修复下面这个单文件 HTML 应用的运行问题，只返回修复后的完整 HTML 代码块，不要解释。
${contextNote}
浏览器验证错误：${errors.join("；")}
原始 HTML：
\`\`\`html
${relevant}
\`\`\`` };
}

async function requestRepairHtml(html, errors, signal, prompt = "", history = []) {
  const repairContext = buildRepairPrompt(html, errors, prompt, history);
  const content = await completeChat(MODEL_OPTIONS, [{ role: "system", content: ITERATE_SYSTEM_PROMPT }, { role: "user", content: repairContext.prompt }], signal, 0.2);
  const parsed = parseGeneratedOutput(content);
  return parsed.html;
}

/* ---------- 访问控制 ---------- */
function checkAuth(req) {
  if (!API_TOKEN) return null;
  const h = req.headers.authorization || "";
  return h === "Bearer " + API_TOKEN ? null : "访问口令错误";
}
const rateMap = new Map();
const generationJobs = new Map();
const generationQueue = [];
let activeGenerations = 0;
const GENERATION_TTL = 30 * 60 * 1000;
const GENERATION_CONCURRENCY = Math.max(1, Number(process.env.GENERATION_CONCURRENCY || config.generationConcurrency || 2));
const GENERATION_MAX_RETRIES = Math.max(0, Number(process.env.GENERATION_MAX_RETRIES || config.generationMaxRetries || 2));

function taskFile(id) { return path.join(TASKS_DIR, id + ".json"); }
function persistGenerationJob(job) {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  const saved = { ...job, listeners: undefined, controller: undefined };
  const tmp = taskFile(job.id) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(saved));
  fs.renameSync(tmp, taskFile(job.id));
}

function loadGenerationJobs() {
  if (!fs.existsSync(TASKS_DIR)) return;
  for (const name of fs.readdirSync(TASKS_DIR)) {
    if (!/^([a-z0-9]+)\.json$/i.test(name)) continue;
    try {
      const job = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, name), "utf8"));
      job.listeners = new Set();
      if (job.status === "running" || job.status === "queued") {
        job.status = "interrupted";
        job.error = "服务在任务执行期间重启，请点击重试。";
        job.updatedAt = new Date().toISOString();
      }
      generationJobs.set(job.id, job);
      persistGenerationJob(job);
    } catch (error) {
      if (process.env.DEBUG) console.error("[debug] 无法读取任务：", name, error);
    }
  }
}

function emitGeneration(job, event) {
  if (job.status === "cancelled") return;
  job.events.push(event);
  job.updatedAt = new Date().toISOString();
  if (event.type === "done") {
    job.status = "completed";
    job.result = event.result;
  } else if (event.type === "error") {
    job.status = "failed";
    job.error = event.message || "生成失败";
    job.failure = { message: job.error, events: job.events.slice(-40), attempt: job.attempts, updatedAt: job.updatedAt };
  }
  persistGenerationJob(job);
  for (const listener of job.listeners || []) listener(event);
}

function readSession(dir) {
  const sessionPath = path.join(dir, "session.json");
  if (!fs.existsSync(sessionPath)) return {};
  try {
    const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    return session && typeof session === "object" ? session : {};
  } catch { return {}; }
}

function conversationFromEvents(events, prompt) {
  const entries = [{ role: "user", content: prompt, kind: "message", icon: undefined, createdAt: new Date().toISOString() }];
  let feedback = "";
  let hasProcess = false;
  const flushFeedback = () => {
    if (!feedback.trim()) return;
    entries.push({ role: "assistant", content: feedback.replace(/【改动说明】|【完整代码】/g, "").trim(), kind: "feedback", icon: undefined, createdAt: new Date().toISOString() });
    feedback = "";
  };
  for (const event of events) {
    if (event.type === "feedback") feedback += event.text || "";
    else if ((event.type === "status" || event.type === "step") && event.text) { flushFeedback(); hasProcess = true; }
  }
  flushFeedback();
  if (hasProcess) entries.push({ role: "assistant", content: "✅ 已完成：代码生成、PWA 打包、验证并发布", kind: "step", icon: "✅", createdAt: new Date().toISOString() });
  return entries;
}

function appendSessionConversation(dir, entries) {
  if (!dir || !fs.existsSync(dir)) return;
  const sessionPath = path.join(dir, "session.json");
  const session = readSession(dir);
  const conversation = Array.isArray(session.conversation) ? session.conversation : [];
  fs.writeFileSync(sessionPath, JSON.stringify({ ...session, conversation: [...conversation, ...entries].slice(-160), updatedAt: new Date().toISOString() }));
}

function failureConversation(prompt, events, message) {
  return [
    ...conversationFromEvents(events, prompt),
    { role: "assistant", content: "❌ " + message, kind: "error", icon: "❌", createdAt: new Date().toISOString() },
  ];
}

function createGenerationJob(bodyText, ip) {
  const id = genId();
  const now = new Date().toISOString();
  const job = { id, status: "queued", createdAt: now, updatedAt: now, events: [], result: null, error: null, failure: null, attempts: 0, requestBody: bodyText, ip, listeners: new Set() };
  generationJobs.set(id, job);
  persistGenerationJob(job);
  setTimeout(() => {
    const current = generationJobs.get(id);
    if (current && Date.now() - Date.parse(current.updatedAt) > GENERATION_TTL) generationJobs.delete(id);
  }, GENERATION_TTL + 1000).unref?.();
  return job;
}

function enqueueGenerationJob(job, req) {
  generationQueue.push({ job, req });
  job.status = "queued";
  job.updatedAt = new Date().toISOString();
  persistGenerationJob(job);
  pumpGenerationQueue();
}

function pumpGenerationQueue() {
  while (activeGenerations < GENERATION_CONCURRENCY && generationQueue.length) {
    const item = generationQueue.shift();
    if (item.job.status === "cancelled") continue;
    activeGenerations++;
    void runGenerationJob(item.job, item.req).finally(() => {
      activeGenerations--;
      pumpGenerationQueue();
    });
  }
}

async function runGenerationJob(job, req) {
  const bodyText = job.requestBody;
  const ip = job.ip || "?";
  for (let attempt = job.attempts + 1; attempt <= GENERATION_MAX_RETRIES + 1; attempt++) {
    if (job.status === "cancelled") return;
    job.status = "running";
    job.attempts = attempt;
    job.error = null;
    job.failure = null;
    job.updatedAt = new Date().toISOString();
    persistGenerationJob(job);
    if (attempt > 1) emitGeneration(job, { type: "status", text: `正在进行第 ${attempt} 次重试…` });
    job.controller = new AbortController();
  const sink = {
    statusCode: 200,
    writeHead(code) { this.statusCode = code; },
    write(chunk) {
      const text = String(chunk);
      for (const part of text.split("\n\n")) {
        const line = part.split("\n").find((item) => item.startsWith("data:"));
        if (!line) continue;
        try {
          const event = JSON.parse(line.slice(5).trim());
          if (event.type === "error") event.retryable = job.attempts <= GENERATION_MAX_RETRIES;
          emitGeneration(job, event);
        } catch {}
      }
    },
    end(body) {
      if (this.statusCode >= 400 && body) {
        try { emitGeneration(job, { type: "error", message: JSON.parse(String(body)).error || "生成请求失败" }); } catch {}
      }
    },
  };
  try {
    await handleGenerate(req, sink, bodyText, ip, true, job.controller.signal);
    if (job.status === "running") emitGeneration(job, { type: "error", message: "生成任务意外结束" });
  } catch (error) {
    if (job.status !== "cancelled") emitGeneration(job, { type: "error", message: error instanceof Error ? error.message : String(error), retryable: attempt <= GENERATION_MAX_RETRIES });
  }
    job.controller = undefined;
    if (job.status === "completed" || job.status === "cancelled") return;
    if (attempt <= GENERATION_MAX_RETRIES) {
      emitGeneration(job, { type: "status", text: "本次生成失败，准备自动重试…" });
      continue;
    }
    return;
  }
}

function cancelGenerationJob(job) {
  if (["completed", "failed", "cancelled"].includes(job.status)) return false;
  job.status = "cancelled";
  job.error = "任务已取消";
  job.updatedAt = new Date().toISOString();
  if (job.controller) job.controller.abort();
  const event = { type: "cancelled", message: job.error };
  job.events.push(event);
  persistGenerationJob(job);
  for (const listener of job.listeners || []) listener(event);
  return true;
}

function generationSummary(job) {
  return {
    generationId: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: job.result,
    error: job.error,
    failure: job.failure || null,
    attempts: job.attempts,
  };
}

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
/** @param {string} raw @returns {string} */
function extractHtml(raw) {
  let s = raw.trim();
  const fence = s.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  if (!/^<!DOCTYPE html>/i.test(s) && /<html[\s>]/i.test(s)) {
    s = s.slice(s.toLowerCase().indexOf("<html"));
  }
  return s;
}
/** @param {string} html @returns {string} */
function extractTitle(html) {
  // 宽容匹配：模型偶尔会输出 </title> 缺斜杠（如 <title>x</title> 或 <title>xtitle>）
  const m = html.match(/<title[^>]*>([\s\S]*?)(?:<\/?title>|title>)/i);
  return m ? m[1].trim().replace(/\s+/g, " ") : "未命名应用";
}
// 提取模型写在 HTML 里的改动说明注释
/** @param {string} html @returns {string} */
function extractChanges(html) {
  const m = html.match(/<!--\s*CHANGES:([\s\S]*?)-->/i);
  return m ? m[1].trim().replace(/\s+/g, " ") : "";
}
function validateGeneratedHtml(html) {
  if (!/^<!DOCTYPE html>/i.test(html.trim())) return "生成结果缺少 <!DOCTYPE html>";
  if (!/<html[\s>]/i.test(html) || !/<\/html>/i.test(html)) return "生成结果不是完整 HTML 文档";
  if (!/<title[^>]*>[\s\S]*?<\/?title>|<title[^>]*>[\s\S]*?title>/i.test(html)) return "生成结果缺少 title";
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  try {
    for (const script of scripts) new Function(script[1]);
  } catch (error) {
    return "JavaScript 语法检查失败：" + (error instanceof Error ? error.message : String(error));
  }
  return null;
}
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
/** @param {string} name @param {string} [theme] @returns {AppManifest} */
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
async function handleGenerate(req, res, bodyText, ip, skipAccess = false, signal = undefined) {
  let body;
  try { body = JSON.parse(bodyText); } catch { return sendJson(res, 400, { error: "请求体不是合法 JSON" }); }
  const prompt = (body.prompt || "").trim();
  if (!prompt) return sendJson(res, 400, { error: "prompt 不能为空" });
  if (!DEEPSEEK_KEY) return sendJson(res, 400, { error: "服务端未配置 DEEPSEEK_API_KEY" });

  if (!skipAccess) {
    const authErr = checkAuth(req);
    if (authErr) return sendJson(res, 401, { error: authErr });
    const rateErr = checkRate(ip);
    if (rateErr) return sendJson(res, 429, { error: rateErr });
  }

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
  const timeline = [];
  const sse = (obj) => { timeline.push(obj); res.write("data: " + JSON.stringify(obj) + "\n\n"); };

  const shortPrompt = prompt.length > 24 ? prompt.slice(0, 24) + "…" : prompt;
  sse({ type: "status", text: isIteration ? "正在修改：「" + shortPrompt + "」" : "正在创建应用…" });
  // 加载该会话的历史需求，让模型记住之前聊过什么
  let history = [];
  if (isIteration) {
    try {
      const sj = JSON.parse(fs.readFileSync(path.join(APPS_DIR, sessionId, "session.json"), "utf8"));
      if (Array.isArray(sj.history)) history = sj.history.slice(-10);
    } catch {}
  }
  const complexity = isIteration
    ? assessRequestComplexity(prompt, { history, htmlLength: existingHtml.length })
    : { level: "simple", score: 0, reasons: [] };
  const contextPlan = isIteration ? buildContextPlan(prompt, existingHtml, history, complexity) : null;
  if (isIteration && complexity.level !== "simple") {
    sse({ type: "status", text: complexity.level === "complex" ? "正在分析相关代码和历史…" : "正在准备应用上下文…" });
  }
  if (contextPlan) sse({ type: "context", plan: contextPlan });
  const messages = isIteration
    ? [
        { role: "system", content: ITERATE_SYSTEM_PROMPT },
        { role: "user", content: buildIterationUserContext(prompt, existingHtml, history, complexity) },
      ]
    : [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: "需求：\n" + prompt },
      ];
  let raw = "";
  try {
    let inCode = false;
    await streamChat({ ...MODEL_OPTIONS, thinking: THINKING }, messages, signal, (c) => {
      raw += c;
      if (!inCode) {
        const fenceIdx = raw.indexOf("```");
        if (fenceIdx === -1) sse({ type: "feedback", text: c });
        else {
          inCode = true;
          const consumedBefore = raw.length - c.length;
          const fenceLocal = fenceIdx - consumedBefore;
          if (fenceLocal > 0) sse({ type: "feedback", text: c.slice(0, fenceLocal) });
          sse({ type: "status", text: "正在生成代码…" });
        }
      }
    });
  } catch (e) {
    sse({ type: "error", message: "请求 DeepSeek 失败：" + e.message });
    res.end();
    return;
  }
  const hasPatchPayload = isIteration && /【增量补丁】/.test(raw);
  if (raw.length < 200 && !hasPatchPayload) {
    if (process.env.DEBUG) console.error("[debug] raw.length =", raw.length);
    sse({ type: "error", message: "生成内容过短，可能被模型拒绝或网络异常，请重试。" });
    res.end();
    return;
  }

  // 优先应用迭代 Patch；模型不遵守 Patch 格式时兼容完整 HTML。
  let parsedOutput = parseGeneratedOutput(raw, isIteration ? existingHtml : null);
  let feedback = parsedOutput.feedback;
  let html = parsedOutput.html;
  sse({ type: "edit", mode: parsedOutput.mode, text: parsedOutput.mode === "patch" ? "已应用增量 Patch" : "使用完整 HTML 结果" });
  let validationError = validateGeneratedHtml(html);
  if (validationError) {
    sse({ type: "failure", phase: "generated-output", message: validationError });
    sse({ type: "error", message: validationError });
    res.end();
    return;
  }
  let title = extractTitle(html);
  let bundle = bundleFromHtml(html);
  sse({ type: "step", icon: "✅", text: "已生成应用代码（" + title + "）" });
  sse({ type: "status", text: "正在打包并发布…" });
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
  fs.writeFileSync(path.join(appDir, "index.html"), bundle.files["index.html"]);
  fs.writeFileSync(path.join(appDir, "manifest.json"), JSON.stringify(genManifest(title, "#4f8cff"), null, 2));
  fs.writeFileSync(path.join(appDir, "sw.js"), SW_JS);
  fs.writeFileSync(path.join(appDir, "icon.svg"), genIcon(title));
  const savedHistory = isIteration ? [...history, prompt].slice(-20) : [prompt];
  // 会话文件在全部发布步骤完成后写入，确保恢复时能看到完整过程。
  console.log("[" + new Date().toISOString() + "] " + (isIteration ? "迭代" : "生成") + " " + id + " · " + title + " · v" + newVersion + " · ip=" + ip);

  sse({ type: "step", icon: "📦", text: "已打包 PWA（页面 / manifest / 图标 / 离线缓存）" });
  if (BROWSER_VALIDATION) {
    sse({ type: "status", text: "正在用无头浏览器验证…" });
    let validation = await validateInBrowser(BASE_URL + "/apps/" + id + "/?validation=" + Date.now(), BROWSER_EXECUTABLE, BROWSER_INTERACTIONS);
    if (!validation.ok) {
      sse({ type: "validation", status: "failed", errors: validation.errors, interactions: validation.interactions || [] });
      sse({ type: "status", text: "验证发现问题，正在自动修复…" });
      try {
        sse({ type: "repair", status: "started", errors: validation.errors });
        const repairedHtml = await requestRepairHtml(html, validation.errors, signal, prompt, history);
        const repairError = validateGeneratedHtml(repairedHtml);
        if (repairError) throw new Error(repairError);
        html = repairedHtml;
        title = extractTitle(html);
        bundle = bundleFromHtml(html);
        fs.writeFileSync(path.join(appDir, "index.html"), bundle.files["index.html"]);
        fs.writeFileSync(path.join(appDir, "manifest.json"), JSON.stringify(genManifest(title, "#4f8cff"), null, 2));
        fs.writeFileSync(path.join(appDir, "icon.svg"), genIcon(title));
        sse({ type: "step", icon: "🔧", text: "已根据浏览器错误自动修复" });
        validation = await validateInBrowser(BASE_URL + "/apps/" + id + "/?validation=" + Date.now(), BROWSER_EXECUTABLE, BROWSER_INTERACTIONS);
        sse({ type: "repair", status: validation.ok ? "passed" : "failed", errors: validation.errors, interactions: validation.interactions || [] });
      } catch (repairError) {
        const repairMessage = repairError instanceof Error ? repairError.message : String(repairError);
        sse({ type: "repair", status: "failed", errors: [repairMessage] });
        appendSessionConversation(appDir, failureConversation(prompt, timeline, "浏览器验证失败，自动修复也未通过：" + repairMessage));
        sse({ type: "error", message: "浏览器验证失败，自动修复也未通过：" + (repairError instanceof Error ? repairError.message : String(repairError)) });
        res.end();
        return;
      }
      if (!validation.ok) {
        appendSessionConversation(appDir, failureConversation(prompt, timeline, "自动修复后浏览器验证仍失败：" + validation.errors.join("；")));
        sse({ type: "failure", phase: "browser-validation", errors: validation.errors, interactions: validation.interactions || [] });
        sse({ type: "error", message: "自动修复后浏览器验证仍失败：" + validation.errors.join("；") });
        res.end();
        return;
      }
    }
    if (validation.skipped) sse({ type: "step", icon: "ℹ️", text: "未配置浏览器，跳过无头验证" });
    else sse({ type: "step", icon: "🧪", text: "浏览器验证通过" });
  }
  const result = await deploy(id, files);
  sse({ type: "step", icon: "⬆️", text: "已发布：" + BASE_URL + "/apps/" + id + "/" });
  sse({
    type: "done",
    result: {
      id, sessionId: id, title, version: newVersion, isIteration,
      feedback,
      changes: feedback || extractChanges(html) || (isIteration ? "按你的要求更新：「" + shortPrompt + "」" : "创建了「" + title + "」应用"),
      url: BASE_URL + "/apps/" + id + "/",
      files, deploy: result,
      },
  });
  const previousSession = readSession(appDir);
  const previousConversation = Array.isArray(previousSession.conversation) ? previousSession.conversation : [];
  const conversation = [...previousConversation, ...conversationFromEvents(timeline, prompt)].slice(-120);
  const commit = recordVersion(appDir, {
    version: newVersion,
    action: isIteration ? "iterate" : "create",
    message: isIteration ? "迭代应用：" + shortPrompt : "创建应用：" + title,
    prompt,
    changes: [{ path: "index.html", changed: true, addedChars: html.length, removedChars: isIteration && existingHtml ? existingHtml.length : 0 }],
    validation: BROWSER_VALIDATION ? { status: "passed", browser: BROWSER_EXECUTABLE } : { status: "skipped" },
  });
  fs.writeFileSync(sessionPath, JSON.stringify({ version: newVersion, title, updatedAt: new Date().toISOString(), history: savedHistory, conversation, head: commit.commitId, workflow: { context: contextPlan, editMode: parsedOutput.mode, validation: commit.validation } }));
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
  // Chrome may request a conventional favicon even when the PWA only ships an SVG icon.
  if (relSafe === "favicon.ico" && fs.existsSync(path.join(base, "icon.svg"))) {
    return sendText(res, 200, fs.readFileSync(path.join(base, "icon.svg")), "image/svg+xml", { "Cache-Control": "no-cache" });
  }
  const p = path.join(base, relSafe || "index.html");
  if (!p.startsWith(base) || !fs.existsSync(p) || !fs.statSync(p).isFile()) return sendText(res, 404, "not found", "text/plain");
  sendText(res, 200, fs.readFileSync(p), MIME[path.extname(p)] || "application/octet-stream", { "Cache-Control": "no-cache" });
}

function atomicWriteFiles(dir, files) {
  const tempDir = fs.mkdtempSync(path.join(dir, ".patch-"));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const safePath = assertSafeBundlePath(relativePath);
      const tempPath = path.join(tempDir, safePath);
      fs.mkdirSync(path.dirname(tempPath), { recursive: true });
      fs.writeFileSync(tempPath, content);
    }
    for (const relativePath of Object.keys(files)) {
      const safePath = assertSafeBundlePath(relativePath);
      const targetPath = path.join(dir, safePath);
      const tempPath = path.join(tempDir, safePath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.renameSync(tempPath, targetPath);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function backupBundleFiles(dir, files, version) {
  const versionDir = path.join(dir, "versions", "v" + version);
  fs.mkdirSync(versionDir, { recursive: true });
  for (const relativePath of files) {
    const safePath = assertSafeBundlePath(relativePath);
    const sourcePath = path.join(dir, safePath);
    if (!fs.existsSync(sourcePath)) continue;
    // Keep the legacy index backup name used by rollback; store auxiliary files below vN/.
    const targetPath = safePath === "index.html"
      ? path.join(dir, "versions", "v" + version + ".html")
      : path.join(versionDir, safePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
  return versionDir;
}

function versionHistoryPath(dir) { return path.join(dir, "version-history.json"); }

function readVersionHistory(dir) {
  const filePath = versionHistoryPath(dir);
  if (!fs.existsSync(filePath)) return [];
  try {
    const history = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(history) ? history : [];
  } catch { return []; }
}

function writeVersionHistory(dir, history) {
  fs.writeFileSync(versionHistoryPath(dir), JSON.stringify(history, null, 2));
}

function bundleDigest(files) {
  const hash = crypto.createHash("sha256");
  for (const filePath of Object.keys(files).sort()) hash.update(filePath + "\0" + files[filePath] + "\0");
  return hash.digest("hex").slice(0, 12);
}

function recordVersion(dir, { version, action, message, prompt = null, changes = [], validation = null }) {
  const history = readVersionHistory(dir);
  const previous = history[history.length - 1] || null;
  const files = {};
  for (const filePath of ["index.html", "manifest.json", "sw.js", "icon.svg"]) {
    const fullPath = path.join(dir, filePath);
    if (fs.existsSync(fullPath)) files[filePath] = fs.readFileSync(fullPath, "utf8");
  }
  const entry = {
    commitId: "c" + String(history.length + 1).padStart(6, "0"),
    parent: previous ? previous.commitId : null,
    version,
    action,
    message,
    prompt,
    changes,
    validation,
    digest: bundleDigest(files),
    createdAt: new Date().toISOString(),
  };
  history.push(entry);
  writeVersionHistory(dir, history);
  return entry;
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
  const generationMatch = p.match(/^\/api\/generations\/([a-z0-9]+)(\/events)?$/i);
  if (generationMatch && (req.method === "GET" || req.method === "POST")) {
    const authErr = checkAuth(req);
    if (authErr) return sendJson(res, 401, { error: authErr });
    const job = generationJobs.get(generationMatch[1]);
    if (!job) return sendJson(res, 404, { error: "生成任务不存在或已过期" });
    if (req.method === "GET" && generationMatch[2] === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no", Connection: "keep-alive" });
      for (const event of job.events) res.write("data: " + JSON.stringify(event) + "\n\n");
      if (job.status === "completed" || job.status === "failed") return res.end();
      const listener = (event) => {
        res.write("data: " + JSON.stringify(event) + "\n\n");
        if (event.type === "done" || event.type === "cancelled" || (event.type === "error" && !event.retryable)) {
          clearInterval(heartbeat);
          job.listeners.delete(listener);
          res.end();
        }
      };
      job.listeners.add(listener);
      const heartbeat = setInterval(() => res.write("data: {\"type\":\"ping\"}\n\n"), 15000);
      req.on("close", () => { clearInterval(heartbeat); job.listeners.delete(listener); });
      return;
    }
    return sendJson(res, 200, generationSummary(job));
  }
  const cancelMatch = p.match(/^\/api\/generations\/([a-z0-9]+)\/cancel$/i);
  if (req.method === "POST" && cancelMatch) {
    const authErr = checkAuth(req);
    if (authErr) return sendJson(res, 401, { error: authErr });
    const job = generationJobs.get(cancelMatch[1]);
    if (!job) return sendJson(res, 404, { error: "生成任务不存在或已过期" });
    if (!cancelGenerationJob(job)) return sendJson(res, 409, { error: "任务当前不可取消", status: job.status });
    return sendJson(res, 200, generationSummary(job));
  }
  const retryMatch = p.match(/^\/api\/generations\/([a-z0-9]+)\/retry$/i);
  if (req.method === "POST" && retryMatch) {
    const authErr = checkAuth(req);
    if (authErr) return sendJson(res, 401, { error: authErr });
    const job = generationJobs.get(retryMatch[1]);
    if (!job) return sendJson(res, 404, { error: "生成任务不存在或已过期" });
    if (!["failed", "interrupted", "cancelled"].includes(job.status)) return sendJson(res, 409, { error: "任务当前不可重试", status: job.status });
    job.status = "queued";
    job.error = null;
    job.updatedAt = new Date().toISOString();
    persistGenerationJob(job);
    enqueueGenerationJob(job, { headers: { authorization: API_TOKEN ? "Bearer " + API_TOKEN : "" } });
    return sendJson(res, 202, generationSummary(job));
  }
  if (req.method === "POST" && p === "/api/generations") {
    let bodyText = "";
    req.on("data", (chunk) => { bodyText += chunk; if (bodyText.length > 2e6) req.destroy(); });
    req.on("end", () => {
      let body;
      try { body = JSON.parse(bodyText); } catch { return sendJson(res, 400, { error: "请求体不是合法 JSON" }); }
      if (!(body.prompt || "").trim()) return sendJson(res, 400, { error: "prompt 不能为空" });
      if (!DEEPSEEK_KEY) return sendJson(res, 400, { error: "服务端未配置 DEEPSEEK_API_KEY" });
      const authErr = checkAuth(req);
      if (authErr) return sendJson(res, 401, { error: authErr });
      const rateErr = checkRate(clientIp(req));
      if (rateErr) return sendJson(res, 429, { error: rateErr });
      const job = createGenerationJob(bodyText, clientIp(req));
      enqueueGenerationJob(job, req);
      return sendJson(res, 202, { generationId: job.id, status: job.status, eventsUrl: "/api/generations/" + job.id + "/events", statusUrl: "/api/generations/" + job.id });
    });
    return;
  }
  // 应用列表（需口令）
  if (req.method === "GET" && p === "/api/apps") {
    const authErr = checkAuth(req);
    if (authErr) return sendJson(res, 401, { error: authErr });
    return sendJson(res, 200, { apps: listApps() });
  }
  const patchMatch = p.match(/^\/api\/apps\/([a-z0-9]+)\/patch$/i);
  if (req.method === "POST" && patchMatch) {
    const authErr = checkAuth(req);
    if (authErr) return sendJson(res, 401, { error: authErr });
    const id = patchMatch[1];
    const dir = path.join(APPS_DIR, id);
    if (!dir.startsWith(APPS_DIR) || !fs.existsSync(path.join(dir, "index.html"))) return sendJson(res, 404, { error: "应用不存在" });
    let bodyText = "";
    req.on("data", (chunk) => { bodyText += chunk; if (bodyText.length > 2e6) req.destroy(); });
    req.on("end", () => {
      try {
        const body = JSON.parse(bodyText);
        if (!Array.isArray(body.patches) || !body.patches.length) return sendJson(res, 400, { error: "patches 不能为空" });
        const files = {};
        for (const patch of body.patches) {
          const safePath = assertSafeBundlePath(patch.path);
          const filePath = path.join(dir, safePath);
          if (!filePath.startsWith(dir) || !fs.existsSync(filePath)) throw new Error("文件不存在：" + safePath);
          files[safePath] = fs.readFileSync(filePath, "utf8");
        }
        const beforeBundle = { entry: "index.html", files };
        const patched = applySearchReplace(beforeBundle, body.patches);
        if (!patched.files["index.html"]) throw new Error("Patch 必须包含 index.html");
        const validationError = validateGeneratedHtml(patched.files["index.html"]);
        if (validationError) throw new Error(validationError);
        const changes = summarizeBundleChanges(beforeBundle, patched);
        if (!changes.length) throw new Error("Patch 没有产生实际变化");
        const sessionPath = path.join(dir, "session.json");
        let version = 1;
        let history = [];
        let conversation = [];
        if (fs.existsSync(sessionPath)) {
          try {
            const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
            version = session.version || 1;
            history = Array.isArray(session.history) ? session.history : [];
            conversation = Array.isArray(session.conversation) ? session.conversation : [];
          } catch {}
        }
        backupBundleFiles(dir, changes.map((item) => item.path), version);
        atomicWriteFiles(dir, patched.files);
        const newVersion = version + 1;
        const title = extractTitle(patched.files["index.html"]);
        const patchConversation = [...conversation, { role: "user", content: "应用增量 Patch：" + changes.map((item) => item.path).join(", "), kind: "message", createdAt: new Date().toISOString() }, { role: "assistant", content: "✅ 已完成：Patch 校验、Diff、版本快照并发布", kind: "step", icon: "✅", createdAt: new Date().toISOString() }].slice(-160);
        const commit = recordVersion(dir, {
          version: newVersion,
          action: "patch",
          message: "应用 Patch：" + changes.map((item) => item.path).join(", "),
          changes,
          validation: "passed",
        });
        fs.writeFileSync(sessionPath, JSON.stringify({ version: newVersion, title, updatedAt: new Date().toISOString(), history: [...history, "应用 Patch：" + changes.map((item) => item.path).join(", ")].slice(-20), conversation: patchConversation, head: commit.commitId, workflow: { editMode: "patch", validation: "passed", changes } }));
        return sendJson(res, 200, { ok: true, id, version: newVersion, title, commit, changes, url: BASE_URL + "/apps/" + id + "/" });
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    });
    return;
  }
  // 应用详情（需口令，含历史，用于恢复会话）
  const delMatch = p.match(/^\/api\/apps\/([a-z0-9]+)$/i);
  if (req.method === "GET" && delMatch) {
    const authErr = checkAuth(req);
    if (authErr) return sendJson(res, 401, { error: authErr });
    const id = delMatch[1];
    const dir = path.join(APPS_DIR, id);
    if (!dir.startsWith(APPS_DIR) || !fs.existsSync(path.join(dir, "index.html"))) return sendJson(res, 404, { error: "应用不存在" });
    let title = "未命名应用", version = 1, updatedAt = null, history = [], conversation = [], workflow = null;
    const sp = path.join(dir, "session.json");
    if (fs.existsSync(sp)) {
      try {
        const sj = JSON.parse(fs.readFileSync(sp, "utf8"));
        if (sj.title) title = sj.title;
        if (typeof sj.version === "number") version = sj.version;
        if (sj.updatedAt) updatedAt = sj.updatedAt;
        if (Array.isArray(sj.history)) history = sj.history;
        if (Array.isArray(sj.conversation)) conversation = sj.conversation;
        if (sj.workflow) workflow = sj.workflow;
      } catch {}
    }
    if (!title || title === "未命名应用") {
      try { title = extractTitle(fs.readFileSync(path.join(dir, "index.html"), "utf8")); } catch {}
    }
    const versionHistory = readVersionHistory(dir);
    return sendJson(res, 200, { app: { id, title, version, versions: versionHistory.length, updatedAt, history, conversation, workflow, head: versionHistory[versionHistory.length - 1]?.commitId || null, versionHistory, url: BASE_URL + "/apps/" + id + "/" } });
  }
  // 删除应用（需口令）
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
    const session = readSession(dir);
    const commit = recordVersion(dir, {
      version: newVersion,
      action: "rollback",
      message: "回退到版本 v" + newVersion,
      changes: [{ path: "index.html", changed: true, addedChars: 0, removedChars: 0 }],
      validation: "not-run",
    });
    fs.writeFileSync(sessionPath, JSON.stringify({ ...session, version: newVersion, title, updatedAt: new Date().toISOString(), head: commit.commitId }));
    console.log("[" + new Date().toISOString() + "] 回退 " + id + " · " + title + " · v" + newVersion + " · ip=" + clientIp(req));
    return sendJson(res, 200, { ok: true, id, version: newVersion, title, commit, url: BASE_URL + "/apps/" + id + "/" });
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

// The compatibility root entry loads the compiled file with require(), so the
// process entry check must also recognize the stable server.js launcher.
if (require.main === module || path.basename(process.argv[1] || "") === "server.js") {
  fs.mkdirSync(APPS_DIR, { recursive: true });
  loadGenerationJobs();
  server.listen(PORT, "0.0.0.0", () => {
    console.log("Chat2App（云端版）已启动：http://0.0.0.0:" + PORT);
    console.log("公开域名：" + BASE_URL);
    console.log("应用存储：" + APPS_DIR);
    console.log("DeepSeek Key：" + (DEEPSEEK_KEY ? "已配置" : "未配置"));
    console.log("访问口令：" + (API_TOKEN ? "已开启" : "未开启（公开可生成，建议开启）"));
    console.log("限流：" + (RATE_LIMIT ? "每小时 " + RATE_LIMIT + " 次/IP" : "未开启"));
  });
}

module.exports = {
  extractHtml,
  extractTitle,
  validateGeneratedHtml,
  genId,
  genManifest,
  genIcon,
  deploy,
  parseSSE,
  assessRequestComplexity,
  extractRelevantHtml,
  buildIterationUserContext,
  buildRepairPrompt,
  SW_JS,
};
