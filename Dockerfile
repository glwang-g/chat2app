# Chat2App · 云端版
FROM node:22-alpine
WORKDIR /app
COPY server.js config.json ./
COPY public ./public
RUN mkdir -p apps-data
ENV PORT=8787 APPS_DIR=/app/apps-data
EXPOSE 8787
CMD ["node", "server.js"]
