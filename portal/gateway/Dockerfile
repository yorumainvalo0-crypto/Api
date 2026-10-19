FROM mirror.gcr.io/library/node:22-alpine AS build
WORKDIR /app
# Optional extra CA bundle for builds behind a TLS-inspecting proxy: put build-ca.pem into the build
# context. Plain COPY/RUN only, so the classic builder works too (servers without buildx)
COPY package.json package-lock.json .npmrc build-ca.pe[m] ./
RUN if [ -f build-ca.pem ]; then export NODE_EXTRA_CA_CERTS="$PWD/build-ca.pem"; fi; \
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
