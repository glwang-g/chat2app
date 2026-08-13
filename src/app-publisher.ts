import fs = require("node:fs");
import path = require("node:path");
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const SW_JS = `/* Chat2App 生成的 Service Worker：离线可打开 */\nconst C="chat2app-v1";const SHELL=["./","./index.html","./manifest.json","./icon.svg"];\nself.addEventListener("install",e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});\nself.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});\nself.addEventListener("fetch",e=>{const r=e.request;if(r.method!=="GET")return;const u=new URL(r.url);if(u.origin!==self.location.origin)return;const nav=r.mode==="navigate"||u.pathname.endsWith("index.html")||u.pathname.endsWith("/");if(nav){e.respondWith(fetch(r).then(x=>{const c=x.clone();caches.open(C).then(c=>c.put(r,c));return x}).catch(()=>caches.match(r).then(m=>m||caches.match("./index.html"))));return}e.respondWith(caches.match(r).then(m=>m||fetch(r).then(x=>{const c=x.clone();caches.open(C).then(c=>c.put(r,c));return x})))});\n`;

export function genManifest(name: string, theme?: string) {
  const short = name.replace(/\s*[·｜|].*$/, "").slice(0, 12) || "小应用";
  return { name, short_name: short, lang: "zh-CN", start_url: "./", scope: "./", display: "standalone" as const, background_color: "#0f1420", theme_color: theme || "#4f8cff", icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" as const }] };
}

export function genIcon(name: string) {
  const letter = (name.replace(/[^A-Za-z0-9\u4e00-\u9fa5]/g, "")[0] || "A").toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f8cff"/><stop offset="1" stop-color="#7a5cff"/></linearGradient></defs><rect width="512" height="512" rx="112" fill="url(#g)"/><text x="256" y="332" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="240" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text></svg>`;
}

export function createPublisher(appsDir: string, config: any, baseUrl: string, extractTitle: (html: string) => string) {
  async function deploy(id: string, files: string[]) {
    const mode = (config.deploy && config.deploy.mode) || "local";
    if (mode === "local") return { mode, ok: true, detail: "已发布到 /apps/" + id + "/" };
    if (mode === "ftp") {
      const f = config.deploy.ftp || {};
      if (!f.host || !f.user) return { mode, ok: false, detail: "config.json 缺少 deploy.ftp.host/user" };
      const base = "ftp://" + f.host + (f.pathPrefix || "") + "/apps/" + id;
      const args = ["-sS", "--ftp-create-dirs", "-u", f.user + ":" + (f.pass || "")];
      const results = [];
      for (const file of files) try { await execFileP("curl", [...args, "-T", path.join(appsDir, id, file), base + "/" + file], { timeout: 30000 }); results.push(file + " ✓"); } catch (e: any) { return { mode, ok: false, detail: file + " 上传失败: " + (e.stderr || e.message) }; }
      return { mode, ok: true, detail: results.join("  ") };
    }
    if (mode === "command") {
      const tmpl = config.deploy.command || "";
      if (!tmpl) return { mode, ok: false, detail: "config.json 缺少 deploy.command" };
      const cmd = tmpl.replaceAll("{id}", id).replaceAll("{dir}", path.join(appsDir, id));
      try { await execFileP("sh", ["-c", cmd], { timeout: 60000 }); return { mode, ok: true, detail: "命令执行成功：" + cmd }; } catch (e: any) { return { mode, ok: false, detail: "命令失败: " + (e.stderr || e.message) + "\n命令：" + cmd }; }
    }
    return { mode, ok: false, detail: "未知发布模式: " + mode };
  }
  function listApps() {
    if (!fs.existsSync(appsDir)) return [];
    const apps: any[] = [];
    for (const id of fs.readdirSync(appsDir)) {
      if (!/^[a-z0-9]+$/i.test(id)) continue;
      const dir = path.join(appsDir, id); if (!dir.startsWith(appsDir) || !fs.statSync(dir).isDirectory()) continue;
      const indexHtml = path.join(dir, "index.html"); if (!fs.existsSync(indexHtml)) continue;
      let title = "未命名应用", version = 1, updatedAt: string | null = null;
      const sp = path.join(dir, "session.json"); if (fs.existsSync(sp)) try { const s = JSON.parse(fs.readFileSync(sp, "utf8")); if (s.title) title = s.title; if (typeof s.version === "number") version = s.version; if (s.updatedAt) updatedAt = s.updatedAt; } catch {}
      if (!title || title === "未命名应用") try { title = extractTitle(fs.readFileSync(indexHtml, "utf8")); } catch {}
      if (!updatedAt) try { updatedAt = fs.statSync(indexHtml).mtime.toISOString(); } catch {}
      let size = 0; for (const f of ["index.html", "manifest.json", "sw.js", "icon.svg"]) try { size += fs.statSync(path.join(dir, f)).size; } catch {}
      const vDir = path.join(dir, "versions"); let versions = 0; if (fs.existsSync(vDir)) try { versions = fs.readdirSync(vDir).filter((f) => /^v\d+\.html$/.test(f)).length; } catch {}
      apps.push({ id, title, version, versions, updatedAt, size, url: baseUrl + "/apps/" + id + "/" });
    }
    return apps.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  }
  return { deploy, listApps };
}
