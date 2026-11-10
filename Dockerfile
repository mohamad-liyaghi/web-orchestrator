# Orchestrator: static build served by an unprivileged nginx with built-in HTTPS.
#
#   docker compose up -d --build          (see README.md and docker-compose.yml)

# ---- build -----------------------------------------------------------------------------------
FROM node:22.23.3-alpine3.24 AS build
WORKDIR /app
ENV CI=true npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false

COPY package.json package-lock.json ./
RUN --mount=type=cache,id=web-orchestrator-npm,target=/root/.npm npm ci

# Runtime assets (MediaPipe wasm, models, samples) only depend on the fetch scripts, the committed
# samples and the installed packages, so this layer survives source edits and the downloads are
# not repeated. The samples step only verifies public/samples, so it has to be in place first.
COPY scripts/ scripts/
COPY public/samples/ public/samples/
RUN npm run assets

COPY . .
RUN npm run build && node deploy/precompress.mjs dist

# ---- runtime ---------------------------------------------------------------------------------
FROM nginx:1.30.5-alpine-slim

# openssl creates the self-signed certificate on first start. The stock entrypoint, its hooks and
# the default site are replaced by deploy/.
RUN apk add --no-cache openssl \
 && rm -rf /docker-entrypoint.sh /docker-entrypoint.d /etc/nginx/conf.d /usr/share/nginx/html/* \
 && mkdir -p /etc/nginx/certs/self-signed /etc/nginx/certs/custom \
 && chown nginx:nginx /etc/nginx/certs/self-signed

COPY deploy/nginx.conf deploy/site.conf deploy/headers.conf deploy/csp.conf deploy/mime.extra.types /etc/nginx/
COPY --chmod=0755 deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --from=build /app/dist /usr/share/nginx/html

USER nginx
EXPOSE 8443 8080
STOPSIGNAL SIGQUIT
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
