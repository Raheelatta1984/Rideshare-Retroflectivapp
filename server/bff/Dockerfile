# Retroflex session service (BFF) + the built SPA, same origin.
#
#   docker build -f server/bff/Dockerfile -t retroflex-bff .
#   docker run -p 8080:8080 --env-file .env.bff retroflex-bff
#
# Required at runtime: SUPABASE_URL, SUPABASE_ANON_KEY, BFF_CSRF_SECRET,
# BFF_ALLOWED_ORIGINS, BFF_SESSION_KEY, and either BFF_DATABASE_URL (postgres
# store) or BFF_SESSION_FILE on a mounted volume. See docs/security/bff.md.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm run bff:build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

# The server bundle has no runtime dependencies of its own; `pg` is installed
# because the postgres session store (the default in production) requires it.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm install --no-save pg && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server

ENV BFF_PORT=8080 \
    BFF_HOST=0.0.0.0 \
    BFF_STATIC_DIR=/app/dist

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BFF_PORT||8080)+'/bff/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist-server/bff.mjs"]
