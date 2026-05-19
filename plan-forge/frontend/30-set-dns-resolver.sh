#!/bin/sh
# Substitute the runtime's DNS server into nginx.conf's `resolver` directive.
#
# nginx ignores /etc/resolv.conf and only uses what's in the `resolver` line.
# Docker puts its embedded DNS at 127.0.0.11; Podman puts it at the bridge
# gateway (e.g. 10.89.3.1). Hardcoding either value breaks the other runtime.
# /etc/resolv.conf is correctly populated by both, so we read it at startup
# and patch the config in place. Runs before nginx via /docker-entrypoint.d/.
set -e

DNS=$(awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf 2>/dev/null || true)
if [ -z "$DNS" ]; then
  echo "[30-set-dns-resolver] WARN: no nameserver in /etc/resolv.conf — falling back to 127.0.0.11" >&2
  DNS=127.0.0.11
fi
echo "[30-set-dns-resolver] using DNS resolver: $DNS"
sed -i "s|__DNS_RESOLVER__|$DNS|g" /etc/nginx/conf.d/default.conf
