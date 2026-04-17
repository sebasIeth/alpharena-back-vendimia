#!/bin/bash
set -e

# ── Config ─────────────────────────────────────────────────────────────────
# Deploy the Base-migrated backend on a DIFFERENT port/path from the legacy
# Solana one so both can coexist on the VPS during the transition.
VPS_HOST=$(grep '^VPS_HOST=' .env.prod.vendimia | cut -d'=' -f2-)
VPS_PASSWORD=$(grep '^VPS_PASSWORD=' .env.prod.vendimia | cut -d'=' -f2-)

if [ -z "$VPS_HOST" ] || [ -z "$VPS_PASSWORD" ]; then
  echo "Error: VPS_HOST or VPS_PASSWORD not found in .env.prod"
  exit 1
fi

APP_DIR="/root/alpharena-api-vendimia"
COMPOSE_FILE="docker-compose.vendimia.yml"
PORT=3011

echo "==> 1/4 Setting up VPS (Docker install + project dir)..."
sshpass -p "$VPS_PASSWORD" ssh -o StrictHostKeyChecking=no "$VPS_HOST" "bash -s" <<SETUP
  if ! command -v docker &> /dev/null; then
    echo "Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
  fi
  if ! docker compose version &> /dev/null; then
    apt-get update && apt-get install -y docker-compose-plugin
  fi
  mkdir -p $APP_DIR
SETUP

echo "==> 2/4 Syncing project files to VPS..."
sshpass -p "$VPS_PASSWORD" rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.git' \
  --exclude '.claude' \
  --exclude '.env' \
  --exclude '.env.dev' \
  --exclude '.env.tmp' \
  -e "ssh -o StrictHostKeyChecking=no" \
  ./ "$VPS_HOST:$APP_DIR/"

echo "==> 3/4 Building and starting container on VPS (port $PORT)..."
sshpass -p "$VPS_PASSWORD" ssh -o StrictHostKeyChecking=no "$VPS_HOST" "cd $APP_DIR && docker compose -f $COMPOSE_FILE up -d --build"

echo "==> 4/4 Checking status..."
sshpass -p "$VPS_PASSWORD" ssh -o StrictHostKeyChecking=no "$VPS_HOST" "docker ps --filter name=alpharena-api-vendimia"

echo ""
echo "Deploy complete! Vendimia API running at http://${VPS_HOST#*@}:$PORT"
