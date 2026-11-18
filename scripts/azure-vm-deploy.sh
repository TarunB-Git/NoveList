
#!/bin/sh
# Azure VM Run Command can execute this script with /bin/sh.
set -eu

if [ "$#" -ne 5 ]; then
  echo "Expected: IMAGE DOMAIN GHCR_USERNAME GHCR_TOKEN ADMIN_PASSWORD" >&2
  exit 1
fi

IMAGE="$1"
DOMAIN="$2"
GHCR_USERNAME="$3"
GHCR_TOKEN="$4"
ADMIN_PASSWORD="$5"

# Runs as root through Azure VM Run Command.
if ! command -v docker >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io
fi
systemctl enable --now docker

mkdir -p /srv/novelist/data
mkdir -p /srv/novelist/caddy-data
mkdir -p /srv/novelist/caddy-config

umask 077

printf 'ADMIN_USERNAME=admin\nADMIN_PASSWORD=%s\nNOVELIST_DATA_DIR=/app/backend/data\nPORT=8080\nCORS_ORIGINS=https://%s\n' \
  "$ADMIN_PASSWORD" "$DOMAIN" > /srv/novelist/app.env

cat > /srv/novelist/Caddyfile <<EOF
${DOMAIN} {
    reverse_proxy novelist:8080
}
EOF

docker network inspect novelist-net >/dev/null 2>&1 \
  || docker network create novelist-net

# Authenticate to pull the private GitHub image.
printf '%s' "$GHCR_TOKEN" \
  | docker login ghcr.io \
      -u "$GHCR_USERNAME" \
      --password-stdin >/dev/null

docker pull "$IMAGE"
docker logout ghcr.io >/dev/null

# Replace the app container, not its persistent data.
docker rm -f novelist >/dev/null 2>&1 || true

docker run -d \
  --name novelist \
  --restart unless-stopped \
  --network novelist-net \
  --env-file /srv/novelist/app.env \
  -v /srv/novelist/data:/app/backend/data \
  "$IMAGE" >/dev/null

# HTTPS reverse proxy with persistent certificates.
docker rm -f novelist-caddy >/dev/null 2>&1 || true

docker run -d \
  --name novelist-caddy \
  --restart unless-stopped \
  --network novelist-net \
  -p 80:80 \
  -p 443:443 \
  -v /srv/novelist/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v /srv/novelist/caddy-data:/data \
  -v /srv/novelist/caddy-config:/config \
  caddy:2 >/dev/null

echo 'NOVELIST_DEPLOY_OK'
