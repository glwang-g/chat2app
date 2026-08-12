# Chat2App · 云端版

当前演进状态、Aider 对比和部署记录见：[项目进展与演进路线](docs/PROJECT_STATUS.md)。

移动端聊天 → DeepSeek 流式生成单文件 PWA → 自动发布到 `https://freexlib.com/apps/<id>/`，
**任何人拿到链接都能立即打开**，手机/桌面浏览器可"安装为应用"。

运行时不需要 npm 依赖，构建阶段使用 TypeScript；Node 18+（自带 fetch）。对标 WorkBuddy 的"聊天生成子应用"能力，
但用你自己的备案域名 + 云服务器，生成的内容 100% 属于你。

## 本地跑

```bash
cp .env.example .env        # 填 DEEPSEEK_API_KEY、API_TOKEN、BASE_URL
npm install
npm run build
node server.js              # http://127.0.0.1:8787
```

开发检查：

```bash
npm install
npm run typecheck
npm test
```

后端源码已经迁移到 `server.ts`，`server.js` 保留为兼容启动入口；`npm run build` 会生成实际运行的 `dist/server.js`。

生成任务接口：

```text
POST /api/generations              创建异步生成任务，返回 generationId
GET  /api/generations/:id          查询任务状态和最终结果
GET  /api/generations/:id/events   通过 SSE 获取任务进度，可重连并重放历史事件
```

任务状态目前保存在本地任务文件中，默认保留 30 分钟；服务重启后正在执行的任务会标记为中断，可通过重试接口重新执行。旧的 `POST /api/generate` 流式接口仍保留，便于兼容旧客户端。

当前异步任务层已支持本地任务文件持久化、有限并发、自动重试、取消和刷新恢复。任务文件默认保存在 `tasks-data/`，也可以通过 `TASKS_DIR` 指定目录；`GENERATION_CONCURRENCY` 控制并发数（默认 2），`GENERATION_MAX_RETRIES` 控制自动重试次数（默认 2）。

生成质量和 Patch：

```text
POST /api/apps/:id/patch          对应用文件执行安全 SEARCH/REPLACE
```

Patch 要求每个 SEARCH 片段恰好匹配一次，路径不能越权，修改后会重新检查 `index.html` 的 HTML 和 JavaScript 语法。

Linux 浏览器验证是可选能力。安装 Chromium 后设置：

```bash
BROWSER_VALIDATION=true
BROWSER_EXECUTABLE=/usr/bin/chromium
```

验证器使用 `playwright-core` 以无头模式加载应用、捕获 `pageerror`/console error 并截图。没有配置浏览器时会安全跳过，不影响原有 Node-only 部署。

也可以在 `config.json` 中配置生成应用后的交互验收步骤：

```json
{
  "browserInteractions": [
    { "name": "点击保存", "selector": "#save", "action": "click", "expectSelector": ".saved" },
    { "name": "输入内容", "selector": "#input", "action": "fill", "value": "测试内容" },
    { "name": "提交表单", "selector": "#form", "action": "press", "value": "Enter" }
  ]
}
```

支持 `click`、`fill`、`press` 三种操作；`expectSelector` 用于确认交互后的元素出现。验收失败会进入现有的浏览器错误自动修复流程。

这意味着你可以把一条真实用户路径写成自动化验收，例如“输入内容 -> 点击保存 -> 刷新后确认 localStorage 还在”，或者“计数器加一 -> 重新进入页面确认状态恢复”。

浏览器打开后直接聊天即可。生成的应用在 `apps-data/<id>/`，公开路径 `/apps/<id>/`。

## 部署到你的轻量云服务器

### 方式一：Docker（推荐）

```bash
# 1. 把整个目录传到服务器（或用 git）
scp -r chat2app root@你的服务器:/opt/

# 2. 服务器上
cd /opt/chat2app
cp .env.example .env        # 填好 DEEPSEEK_API_KEY / API_TOKEN / BASE_URL
docker compose up -d --build
```

### 方式二：systemd 直接跑

```bash
# 服务器上
apt install -y nodejs       # 需要 Node 18+（建议用 nodesource 装 20/22 LTS）
mkdir -p /opt/chat2app && cp -r server.js server.ts src public config.json package.json package-lock.json tsconfig.json /opt/chat2app/
cd /opt/chat2app && npm ci && npm run build
cp .env.example /opt/chat2app/.env   # 填好
cp chat2app.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now chat2app
```

### 3. Nginx + HTTPS（必须，PWA 需要 HTTPS）

```bash
apt install -y nginx certbot python3-certbot-nginx
cp nginx.conf.example /etc/nginx/conf.d/chat2app.conf   # 改好 server_name
certbot --nginx -d freexlib.com                            # 自动签发并续期 HTTPS
systemctl reload nginx
```

> ⚠️ `nginx.conf.example` 里已关闭 `proxy_buffering`，否则 SSE 流式生成会卡住不输出。

## 配置项（.env）

| 变量 | 说明 |
|------|------|
| `DEEPSEEK_API_KEY` | 必填，DeepSeek 密钥 |
| `API_TOKEN` | 访问口令，生成应用时需要。留空=公开可生成（会烧你的额度，建议开启） |
| `RATE_LIMIT_PER_HOUR` | 每个 IP 每小时生成上限，0=不限 |
| `BASE_URL` | 对外域名，生成网址的前缀 |
| `DEEPSEEK_URL` | 可选，换其它 OpenAI 兼容端点 |

## 验证

- `curl https://freexlib.com/api/health` → `{"ok":true,...}`
- 打开 `https://freexlib.com/apps/<id>/` 就是生成的小应用，无需口令，任何人可访问。

## 结构

```
server.ts            云端后端源码：DeepSeek 流式代理 + PWA 打包 + 发布 + 限流 + 口令
server.js            兼容启动入口，实际运行 dist/server.js
public/              手机聊天界面（PWA：manifest + sw + icon）
apps-data/<id>/      生成的应用（index.html / manifest.json / sw.js / icon.svg）
Dockerfile / docker-compose.yml / chat2app.service / nginx.conf.example
```

## GitHub Actions 自动部署

推送到 `master` 后，`.github/workflows/deploy.yml` 会先执行类型检查和测试；全部通过后通过 SSH 登录 Linux 服务器，执行 `git pull --ff-only`、`npm ci`、`npm run build`，最后重启 `chat2app.service`。当前服务器采用 systemd 部署，因此不依赖 Docker 运行服务。

需要在 GitHub 仓库的 `production` Environment 中配置以下 Secrets：

```text
DEPLOY_HOST          服务器地址
DEPLOY_USER          SSH 用户
DEPLOY_PATH          服务器上的项目目录，例如 /opt/chat2app
DEPLOY_SSH_KEY       部署专用 SSH 私钥
DEPLOY_KNOWN_HOSTS   ssh-keyscan 服务器得到的整行主机指纹
```

服务器需要提前完成一次初始化：克隆仓库到 `DEPLOY_PATH`、准备 `.env`，并确保部署用户可以执行 Docker。之后本地只需：

```bash
git add -A
git commit -m "描述改动"
git push origin master
```

## 安全说明

- DeepSeek Key 只存在服务器 `.env`，不落到前端/移动端。
- 建议开启 `API_TOKEN` + `RATE_LIMIT_PER_HOUR`，防陌生人刷爆你的额度。
- 生成的子应用是纯前端，数据在访客的浏览器 localStorage，无后端，无隐私泄露风险。
