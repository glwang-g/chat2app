const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
let child;
let port;
let upstreamPort;
let upstream;
let appsDir;
let tasksDir;
let generatedAppId;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const selectedPort = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => error ? reject(error) : resolve(selectedPort));
    });
  });
}

async function waitForServer(url, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("server did not start: " + url);
}

test.before(async () => {
  port = await freePort();
  upstreamPort = await freePort();
  upstream = http.createServer((req, res) => {
    let requestBody = "";
    req.on("data", (chunk) => { requestBody += chunk; });
    req.on("end", () => {
      const request = JSON.parse(requestBody || "{}");
      const repairedHtml = "<!DOCTYPE html><html><head><title>测试应用</title></head><body><script>" + "const value = 1;\n" + "console.log(value);\n".repeat(30) + "</script></body></html>";
      if (request.stream === false) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ choices: [{ message: { content: "```html\n" + repairedHtml + "\n```" } }] }));
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const html = repairedHtml.replace("console.log(value);", "console.log(value); throw new Error('intentional browser validation failure');");
      const content = "测试生成完成。\n```html\n" + html + "\n```";
      setTimeout(() => res.end("data: " + JSON.stringify({ choices: [{ delta: { content } }] }) + "\n\ndata: [DONE]\n\n"), 120);
    });
  });
  await new Promise((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve));
  appsDir = fs.mkdtempSync(path.join("/tmp", "chat2app-test-"));
  tasksDir = fs.mkdtempSync(path.join("/tmp", "chat2app-tasks-"));
  child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      APPS_DIR: appsDir,
      TASKS_DIR: tasksDir,
      BASE_URL: `http://127.0.0.1:${port}`,
      API_TOKEN: "test-token",
      RATE_LIMIT_PER_HOUR: "30",
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_URL: `http://127.0.0.1:${upstreamPort}/chat/completions`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer(`http://127.0.0.1:${port}/api/health`);
});

test.after(() => {
  if (child && !child.killed) child.kill("SIGTERM");
  if (upstream) upstream.close();
  if (appsDir) fs.rmSync(appsDir, { recursive: true, force: true });
  if (tasksDir) fs.rmSync(tasksDir, { recursive: true, force: true });
});

test("health endpoint reports a running service", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.apps, 0);
  assert.ok(body.time);
});

test("config endpoint exposes settings without exposing the API key", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/config`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.baseUrl, `http://127.0.0.1:${port}`);
  assert.equal(body.hasKey, true);
  assert.equal(body.authRequired, true);
  assert.equal(body.rateLimitPerHour, 30);
});

test("root and PWA shell assets are served", async () => {
  const rootResponse = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(rootResponse.status, 200);
  assert.match(await rootResponse.text(), /Chat2App/);

  const manifestResponse = await fetch(`http://127.0.0.1:${port}/manifest.json`);
  assert.equal(manifestResponse.status, 200);
  assert.equal(manifestResponse.headers.get("content-type"), "application/json; charset=utf-8");
});

test("apps API enforces the configured token and unknown paths return 404", async () => {
  const unauthorizedResponse = await fetch(`http://127.0.0.1:${port}/api/apps`);
  assert.equal(unauthorizedResponse.status, 401);

  const appsResponse = await fetch(`http://127.0.0.1:${port}/api/apps`, {
    headers: { Authorization: "Bearer test-token" },
  });
  assert.equal(appsResponse.status, 200);
  assert.deepEqual(await appsResponse.json(), { apps: [] });

  const missingResponse = await fetch(`http://127.0.0.1:${port}/does-not-exist`);
  assert.equal(missingResponse.status, 404);
  assert.equal(await missingResponse.text(), "not found");
});

test("generation API creates a task and replays its completed SSE events", async () => {
  const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };
  const createResponse = await fetch(`http://127.0.0.1:${port}/api/generations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: "创建一个测试应用" }),
  });
  assert.equal(createResponse.status, 202);
  const task = await createResponse.json();
  assert.match(task.generationId, /^[a-z0-9]+$/i);
  assert.ok(["queued", "running"].includes(task.status));

  const eventsResponse = await fetch(`http://127.0.0.1:${port}${task.eventsUrl}`, { headers });
  assert.equal(eventsResponse.status, 200);
  const eventsText = await eventsResponse.text();
  assert.match(eventsText, /"type":"done"/);
  assert.match(eventsText, /"type":"edit"/);
  assert.match(eventsText, /"mode":"full"/);
  assert.match(eventsText, /测试应用/);

  const statusResponse = await fetch(`http://127.0.0.1:${port}${task.statusUrl}`, { headers });
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.status, "completed");
  assert.equal(status.result.title, "测试应用");
  assert.equal(status.result.version, 1);
  generatedAppId = status.result.id;

  const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/apps/${generatedAppId}`, { headers });
  assert.equal(sessionResponse.status, 200);
  const sessionBody = await sessionResponse.json();
  assert.ok(Array.isArray(sessionBody.app.conversation));
  assert.ok(sessionBody.app.conversation.some((entry) => entry.role === "user" && entry.content === "创建一个测试应用"));
  assert.ok(sessionBody.app.conversation.some((entry) => entry.kind === "feedback" && entry.content.includes("测试生成完成")));
  assert.equal(sessionBody.app.conversation.filter((entry) => entry.kind === "step").length, 1);
  assert.match(sessionBody.app.conversation.find((entry) => entry.kind === "step").content, /代码生成、PWA 打包、验证并发布/);
  assert.equal(sessionBody.app.workflow.editMode, "full");
  assert.ok(["skipped", "passed"].includes(sessionBody.app.workflow.validation.status));

  const appResponse = await fetch(`http://127.0.0.1:${port}/apps/${status.result.id}/`);
  assert.equal(appResponse.status, 200);
  assert.match(await appResponse.text(), /测试应用/);
});

test("apps patch API updates one file and increments the app version", async () => {
  const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };
  const response = await fetch(`http://127.0.0.1:${port}/api/apps/${generatedAppId}/patch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ patches: [{ path: "index.html", search: "测试应用", replace: "测试应用二版" }] }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.version, 2);
  assert.deepEqual(body.changes, [{ path: "index.html", changed: true, addedChars: 2, removedChars: 0 }]);
  assert.equal(body.commit.validation, "passed");
  assert.equal(body.commit.commitId, "c000002");
  assert.equal(body.commit.parent, "c000001");
  const appResponse = await fetch(`http://127.0.0.1:${port}/apps/${generatedAppId}/`);
  assert.match(await appResponse.text(), /测试应用二版/);

  const rollbackResponse = await fetch(`http://127.0.0.1:${port}/api/apps/${generatedAppId}/rollback`, {
    method: "POST",
    headers,
  });
  assert.equal(rollbackResponse.status, 200);
  const rollback = await rollbackResponse.json();
  assert.equal(rollback.version, 1);
  assert.equal(rollback.commit.commitId, "c000003");
  assert.equal(rollback.commit.parent, "c000002");
  const rolledBackAppResponse = await fetch(`http://127.0.0.1:${port}/apps/${generatedAppId}/`);
  const rolledBackHtml = await rolledBackAppResponse.text();
  assert.match(rolledBackHtml, /测试应用/);
  assert.doesNotMatch(rolledBackHtml, /测试应用二版/);

  const detailResponse = await fetch(`http://127.0.0.1:${port}/api/apps/${generatedAppId}`, { headers });
  const detail = await detailResponse.json();
  assert.equal(detail.app.head, "c000003");
  assert.deepEqual(detail.app.versionHistory.map((entry) => entry.action), ["create", "patch", "rollback"]);
});

test("patch API validates all patches before writing and rejects no-op patches", async () => {
  const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };
  const beforeResponse = await fetch(`http://127.0.0.1:${port}/apps/${generatedAppId}/`);
  const beforeHtml = await beforeResponse.text();
  const failedResponse = await fetch(`http://127.0.0.1:${port}/api/apps/${generatedAppId}/patch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ patches: [
      { path: "index.html", search: "测试应用", replace: "不会写入" },
      { path: "index.html", search: "不存在的片段", replace: "x" },
    ] }),
  });
  assert.equal(failedResponse.status, 400);
  const afterFailedResponse = await fetch(`http://127.0.0.1:${port}/apps/${generatedAppId}/`);
  assert.equal(await afterFailedResponse.text(), beforeHtml);

  const noOpResponse = await fetch(`http://127.0.0.1:${port}/api/apps/${generatedAppId}/patch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ patches: [{ path: "index.html", search: "测试应用", replace: "测试应用" }] }),
  });
  assert.equal(noOpResponse.status, 400);
  assert.match(await noOpResponse.text(), /没有产生实际变化/);
});

test("generation API can cancel a running task", async () => {
  const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };
  const createResponse = await fetch(`http://127.0.0.1:${port}/api/generations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: "创建一个稍后取消的应用" }),
  });
  assert.equal(createResponse.status, 202);
  const task = await createResponse.json();
  const cancelResponse = await fetch(`http://127.0.0.1:${port}/api/generations/${task.generationId}/cancel`, { method: "POST", headers });
  assert.equal(cancelResponse.status, 200);
  const status = await cancelResponse.json();
  assert.equal(status.status, "cancelled");
  assert.equal(status.error, "任务已取消");
});
