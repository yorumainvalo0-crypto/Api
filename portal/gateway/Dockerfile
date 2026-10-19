# syntax=docker/dockerfile:1.7
FROM mirror.gcr.io/library/node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# Optional extra CA bundle for builds behind a TLS-inspecting proxy
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM mirror.gcr.io/library/node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/portal/health || exit 1
CMD ["node", "dist/main.js"]
