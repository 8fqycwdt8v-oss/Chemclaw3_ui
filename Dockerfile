# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
WORKDIR /app
COPY . .
# Whether this image's bundle may serve the no-token dev auth provider. Defaults to false, so a
# plain `docker build` cannot produce an image that hands out unauthenticated sessions; the compose
# stack, which runs AUTH_MODE=dev on purpose, passes true.
ARG ALLOW_DEV_AUTH=false
ENV ALLOW_DEV_AUTH=${ALLOW_DEV_AUTH}
# vite build -> dist/client ; esbuild --bundle -> dist/server.js
RUN npm run build

# The runtime stage carries NO node_modules: esbuild inlines sirv into dist/server.js, and
# everything else the BFF uses is a node: builtin.
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    BIND_HOST=0.0.0.0 \
    CLIENT_DIR=/app/dist/client
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 8080
# LIVENESS, and `/healthz` deliberately: it answers from a literal and never touches the upstream,
# so it asks "is this process serving?" — the only question a restart may be decided on. Readiness
# is `/readyz`, which probes the Chemclaw service; point a readiness probe or a load balancer at
# that one. Restarting this container because the *backend* is down would take away the one process
# still able to explain the outage, and it would come back no readier than it went down.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
