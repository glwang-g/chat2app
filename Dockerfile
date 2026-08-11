# Chat2App · 云端版
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.json server.js server.ts ./
COPY src ./src
COPY public ./public
COPY config.json ./
RUN npm ci && npm run build && npm prune --omit=dev
RUN mkdir -p apps-data
ENV PORT=8787 APPS_DIR=/app/apps-data
EXPOSE 8787
CMD ["node", "server.js"]
