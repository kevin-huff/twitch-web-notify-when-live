FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    DB_PATH=/data/notify.db \
    PORT=8080

RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "src/server.js"]
