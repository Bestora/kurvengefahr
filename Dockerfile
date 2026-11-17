# Self-hosting image (e.g. Coolify): nginx serving a prebuilt dist/. Build first —
# `npm run build` (needs Rust + wasm-pack) — then `docker build .`. The image.yml workflow does
# both on GitHub and pushes to GHCR, so the host only pulls.
FROM nginx:1.27-alpine
COPY tools/nginx.conf /etc/nginx/conf.d/default.conf
COPY dist /usr/share/nginx/html
EXPOSE 80
