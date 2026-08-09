# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
WORKDIR /app
COPY . .
# Whether the built bundle may fall back to the no-token dev auth provider. Defaults to false, so
# an image built without thinking about it cannot serve unauthenticated access. This is a BUILD
# arg and not a runtime env var because Vite bakes it into the bundle as a literal — a runtime
# value could not remove the code path.
ARG ALLOW_DEV_AUTH=false
ENV ALLOW_DEV_AUTH=${ALLOW_DEV_AUTH}
# vite build -> dist/client ; esbuild --bundle -> dist/server.mjs
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
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
