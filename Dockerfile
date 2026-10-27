FROM node:24-bookworm-slim AS backend-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM backend-build AS operator
COPY migrations ./migrations
COPY scripts/seed-demo-guided-configuration.ts ./scripts/
COPY deploy/operator.ts ./deploy/
USER node
ENTRYPOINT ["./node_modules/.bin/tsx", "deploy/operator.ts"]

FROM node:24-bookworm-slim AS backend
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --cache /tmp/npm-cache && rm -rf /tmp/npm-cache
COPY --from=backend-build /app/dist ./dist
COPY migrations ./migrations
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]

FROM node:24-bookworm-slim AS frontend-build
WORKDIR /ui
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM caddy:2-alpine AS web
COPY --from=frontend-build /ui/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY deploy/caddy-entrypoint.sh /usr/local/bin/demo-caddy
RUN chmod 755 /usr/local/bin/demo-caddy
ENTRYPOINT ["/bin/sh", "/usr/local/bin/demo-caddy"]
