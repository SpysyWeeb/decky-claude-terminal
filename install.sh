#!/usr/bin/env bash
# Build and install into Decky (needs sudo: ~/homebrew/plugins is root-owned).
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/home/linuxbrew/.linuxbrew/bin:$PATH"
pnpm run build
DEST="$HOME/homebrew/plugins/claude-terminal"
sudo rm -rf "$DEST"
sudo mkdir -p "$DEST"
sudo cp -r dist main.py plugin.json package.json LICENSE "$DEST/"
sudo systemctl restart plugin_loader
echo "Installed to $DEST and restarted Decky."
