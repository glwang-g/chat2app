import fs = require("node:fs");
import path = require("node:path");

export function createGenerationManager(options: { tasksDir: string; concurrency: number; maxRetries: number; ttl: number; createId: () => string; execute: (req: any, sink: any, bodyText: string, ip: string, skipAccess: boolean, signal: AbortSignal) => Promise<void> }) {
  const jobs = new Map<string, any>();
  const queue: Array<{ job: any; req: any }> = [];
  let active = 0;
  const taskFile = (id: string) => path.join(options.tasksDir, id + ".json");
  function persist(job: any) {
    fs.mkdirSync(options.tasksDir, { recursive: true });
    const saved = { ...job, listeners: undefined, controller: undefined };
    fs.writeFileSync(taskFile(job.id) + ".tmp", JSON.stringify(saved));
    fs.renameSync(taskFile(job.id) + ".tmp", taskFile(job.id));
  }
  function emit(job: any, event: any) {
    if (job.status === "cancelled") return;
    job.events.push(event); job.updatedAt = new Date().toISOString();
    if (event.type === "done") { job.status = "completed"; job.result = event.result; }
    else if (event.type === "error") { job.status = "failed"; job.error = event.message || "生成失败"; job.failure = { message: job.error, events: job.events.slice(-40), attempt: job.attempts, updatedAt: job.updatedAt }; }
    persist(job); for (const listener of job.listeners || []) listener(event);
  }
  async function run(job: any, req: any) {
    for (let attempt = job.attempts + 1; attempt <= options.maxRetries + 1; attempt++) {
      if (job.status === "cancelled") return;
      Object.assign(job, { status: "running", attempts: attempt, error: null, failure: null, updatedAt: new Date().toISOString(), controller: new AbortController() }); persist(job);
      if (attempt > 1) emit(job, { type: "status", text: `正在进行第 ${attempt} 次重试…` });
      const sink: any = { statusCode: 200, writeHead(code: number) { this.statusCode = code; }, write(chunk: unknown) { for (const part of String(chunk).split("\n\n")) { const line = part.split("\n").find((item) => item.startsWith("data:")); if (!line) continue; try { const event = JSON.parse(line.slice(5).trim()); if (event.type === "error") event.retryable = job.attempts <= options.maxRetries; emit(job, event); } catch {} } }, end(body: unknown) { if (this.statusCode >= 400 && body) try { emit(job, { type: "error", message: JSON.parse(String(body)).error || "生成请求失败" }); } catch {} } };
      try { await options.execute(req, sink, job.requestBody, job.ip || "?", true, job.controller.signal); if (job.status === "running") emit(job, { type: "error", message: "生成任务意外结束" }); }
      catch (error) { if (job.status !== "cancelled") emit(job, { type: "error", message: error instanceof Error ? error.message : String(error), retryable: attempt <= options.maxRetries }); }
      job.controller = undefined;
      if (["completed", "cancelled"].includes(job.status)) return;
      if (attempt <= options.maxRetries) { emit(job, { type: "status", text: "本次生成失败，准备自动重试…" }); continue; }
      return;
    }
  }
  function pump() { while (active < options.concurrency && queue.length) { const item = queue.shift()!; if (item.job.status === "cancelled") continue; active++; void run(item.job, item.req).finally(() => { active--; pump(); }); } }
  function enqueue(job: any, req: any) { queue.push({ job, req }); job.status = "queued"; job.updatedAt = new Date().toISOString(); persist(job); pump(); }
  function create(bodyText: string, ip: string) { const now = new Date().toISOString(); const job = { id: options.createId(), status: "queued", createdAt: now, updatedAt: now, events: [], result: null, error: null, failure: null, attempts: 0, requestBody: bodyText, ip, listeners: new Set() }; jobs.set(job.id, job); persist(job); setTimeout(() => { const current = jobs.get(job.id); if (current && Date.now() - Date.parse(current.updatedAt) > options.ttl) jobs.delete(job.id); }, options.ttl + 1000).unref?.(); return job; }
  function cancel(job: any) { if (["completed", "failed", "cancelled"].includes(job.status)) return false; job.status = "cancelled"; job.error = "任务已取消"; job.updatedAt = new Date().toISOString(); if (job.controller) job.controller.abort(); const event = { type: "cancelled", message: job.error }; job.events.push(event); persist(job); for (const listener of job.listeners || []) listener(event); return true; }
  function summary(job: any) { return { generationId: job.id, status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt, result: job.result, error: job.error, failure: job.failure || null, attempts: job.attempts }; }
  function load() { if (!fs.existsSync(options.tasksDir)) return; for (const name of fs.readdirSync(options.tasksDir)) { if (!/^([a-z0-9]+)\.json$/i.test(name)) continue; try { const job = JSON.parse(fs.readFileSync(path.join(options.tasksDir, name), "utf8")); job.listeners = new Set(); if (["running", "queued"].includes(job.status)) { job.status = "interrupted"; job.error = "服务在任务执行期间重启，请点击重试。"; job.updatedAt = new Date().toISOString(); } jobs.set(job.id, job); persist(job); } catch (error) { if (process.env.DEBUG) console.error("[debug] 无法读取任务：", name, error); } } }
  return { jobs, persist, load, create, enqueue, cancel, summary };
}
