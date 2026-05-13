#!/usr/bin/env bash
set -euo pipefail

echo "[1/4] Instalando dependências base..."
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl git ufw

if ! command -v docker >/dev/null 2>&1; then
  echo "[2/4] Instalando Docker Engine + Compose plugin..."
  curl -fsSL https://get.docker.com | sudo sh
else
  echo "[2/4] Docker já instalado."
fi

echo "[3/4] Habilitando Docker no boot..."
sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker "$USER"

echo "[4/4] Configurando firewall (22/80/443)..."
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable

echo
echo "[ok] Bootstrap concluído."
echo "Saia e entre novamente no SSH para aplicar grupo docker no seu usuário."
