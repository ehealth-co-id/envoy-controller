#!/usr/bin/env bash
set -euo pipefail

# Configuration
REPO="ehealth-co-id/envoy-controller"
SERVICE_NAME="envoy-controller"
INSTALL_DIR="/opt/envoy-controller" # Best practice: use /opt for system services
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
NODE_BIN="/usr/bin/node"

echo "[*] Installing ${SERVICE_NAME} from latest release..."

# 1. Pre-flight checks
if [[ $EUID -ne 0 ]]; then
   echo "ERROR: This script must be run as root" 
   exit 1
fi

if [[ ! -x "$NODE_BIN" ]]; then
  echo "ERROR: Node.js not found at $NODE_BIN"
  exit 1
fi

# 2. Fetch latest release asset URL using Node (since it's a prerequisite)
echo "[*] Fetching latest release information..."
ASSET_URL=$(node -e "
  const https = require('https');
  const opts = {
    hostname: 'api.github.com',
    path: '/repos/${REPO}/releases/latest',
    headers: { 'User-Agent': 'node.js' }
  };
  https.get(opts, (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
      try {
        const release = JSON.parse(data);
        // Look for the tarball we created in the pipeline
        const asset = release.assets.find(a => a.name.endsWith('.tar.gz'));
        if (asset) {
          console.log(asset.browser_download_url);
        } else {
          console.error('No .tar.gz asset found in latest release.');
          process.exit(1);
        }
      } catch (e) {
        console.error('Failed to parse release JSON:', e.message);
        process.exit(1);
      }
    });
  }).on('error', (e) => {
    console.error('Request failed:', e.message);
    process.exit(1);
  });
")

if [[ -z "$ASSET_URL" ]]; then
    echo "ERROR: Could not determine download URL."
    exit 1
fi

echo "[*] Downloading release from: $ASSET_URL"
TMP_DIR=$(mktemp -d)
cd "$TMP_DIR"
curl -sL -o release.tar.gz "$ASSET_URL"

# 3. Extract and Install
echo "[*] Extracting to ${INSTALL_DIR}..."
# Stop service if it exists to allow file overwrite
systemctl stop ${SERVICE_NAME} 2>/dev/null || true

mkdir -p "$INSTALL_DIR"
# Extract and strip the top-level directory if it exists
tar -xzvf release.tar.gz -C "$INSTALL_DIR" --strip-components=1

# Install production dependencies
echo "[*] Installing Node.js dependencies..."
cd "$INSTALL_DIR"
npm install --omit=dev

# Cleanup temp files
cd /
rm -rf "$TMP_DIR"

# 4. Systemd Setup
echo "[*] Configuring systemd service..."
cat > "$SERVICE_FILE"
