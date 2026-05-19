FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY html /usr/share/nginx/html

# Runs before nginx via the official nginx:alpine entrypoint. Substitutes
# the runtime's DNS server (from /etc/resolv.conf) into nginx.conf's
# `resolver` directive — necessary because Docker (127.0.0.11) and Podman
# (bridge gateway) put their DNS at different addresses, and nginx ignores
# /etc/resolv.conf for upstream resolution.
COPY 30-set-dns-resolver.sh /docker-entrypoint.d/30-set-dns-resolver.sh
RUN chmod +x /docker-entrypoint.d/30-set-dns-resolver.sh

EXPOSE 80
