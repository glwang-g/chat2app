# PWA 工坊 · 云端版

移动端聊天 → DeepSeek 流式生成单文件 PWA → 自动发布到 `https://freexlib.com/apps/<id>/`，
**任何人拿到链接都能立即打开**，手机/桌面浏览器可"安装为应用"。

零 npm 依赖，Node 18+（自带 fetch）。对标 WorkBuddy 的"聊天生成子应用"能力，
但用你自己的备案域名 + 云服务器，生成的内容 100% 属于你。

## 本地跑

```bash
cp .env.example .env        # 填 DEEPSEEK_API_KEY、API_TOKEN、BASE_URL
node server.js              # http://127.0.0.1:8787
```

浏览器打开后直接聊天即可。生成的应用在 `apps-data/<id>/`，公开路径 `/apps/<id>/`。

## 部署到你的轻量云服务器

### 方式一：Docker（推荐）

```bash
# 1. 把整个目录传到服务器（或用 git）
scp -r pwa-studio root@你的服务器:/opt/

# 2. 服务器上
cd /opt/pwa-studio
cp .env.example .env        # 填好 DEEPSEEK_API_KEY / API_TOKEN / BASE_URL
docker compose up -d --build
```

### 方式二：systemd 直接跑

```bash
# 服务器上
apt install -y nodejs       # 需要 Node 18+（建议用 nodesource 装 20/22 LTS）
mkdir -p /opt/pwa-studio && cp -r server.js public config.json /opt/pwa-studio/
cp .env.example /opt/pwa-studio/.env   # 填好
cp pwa-studio.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now pwa-studio
```

### 3. Nginx + HTTPS（必须，PWA 需要 HTTPS）

```bash
apt install -y nginx certbot python3-certbot-nginx
cp nginx.conf.example /etc/nginx/conf.d/pwa-studio.conf   # 改好 server_name
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
server.js            云端后端：DeepSeek 流式代理 + PWA 打包 + 发布 + 限流 + 口令
public/              手机聊天界面（PWA：manifest + sw + icon）
apps-data/<id>/      生成的应用（index.html / manifest.json / sw.js / icon.svg）
Dockerfile / docker-compose.yml / pwa-studio.service / nginx.conf.example
```

## 安全说明

- DeepSeek Key 只存在服务器 `.env`，不落到前端/移动端。
- 建议开启 `API_TOKEN` + `RATE_LIMIT_PER_HOUR`，防陌生人刷爆你的额度。
- 生成的子应用是纯前端，数据在访客的浏览器 localStorage，无后端，无隐私泄露风险。
