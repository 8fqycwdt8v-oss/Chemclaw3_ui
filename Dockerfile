# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
WORKDIR /app
COPY . .
# vite build -> dist/client ; esbuild --bundle -> dist/server.js
RUN npm run build
# Sourcemaps are built (they are worth having locally) but never shipped.
#
# `sourcemap: 'hidden'` only omits the `//# sourceMappingURL` comment — the .map files are still
# emitted next to the bundles at a derivable path, the runtime stage copies them, and `sirv` serves
# them. Verified before this line existed: GET /assets/index-*.js.map returned 200 and 2.3 MB
# containing the original TypeScript of 55 source files, unauthenticated, in msal mode. Hidden is
# not private. This also takes ~4.6 MB out of the image.
RUN find dist -name '*.map' -delete

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
