#!/usr/bin/env bash
set -euo pipefail

echo "[*] Installing Envoy Proxy (latest release)..."

# 1. Get latest release tag using GitHub's redirect trick (no jq required)
LATEST_TAG=$(curl -sIL https://github.com/envoyproxy/envoy/releases/latest | grep -i '^location:' | sed 's/.*tag\///' | tr -d '\r\n')
if [[ -z "$LATEST_TAG" ]]; then
    echo "ERROR: Could not determine latest Envoy version."
    exit 1
fi
echo "[*] Latest Envoy version: $LATEST_TAG"

# 2. Download binary
# We try envoy-contrib first (as you specified), and fallback to standard envoy if it doesn't exist for this release
DOWNLOAD_URL="https://github.com/envoyproxy/envoy/releases/download/${LATEST_TAG}/envoy-contrib-${LATEST_TAG}-linux-x86_64"
HTTP_STATUS=$(curl -sIL -o /dev/null -w "%{http_code}" "$DOWNLOAD_URL")

if [[ "$HTTP_STATUS" != "200" && "$HTTP_STATUS" != "302" ]]; then
    echo "[!] envoy-contrib not found (HTTP $HTTP_STATUS), falling back to standard envoy binary..."
    DOWNLOAD_URL="https://github.com/envoyproxy/envoy/releases/download/${LATEST_TAG}/envoy-${LATEST_TAG}-linux-x86_64"
fi

echo "[*] Downloading from: $DOWNLOAD_URL"
curl -sSL "$DOWNLOAD_URL" -o /usr/local/bin/envoy
chmod +x /usr/local/bin/envoy

# 3. Setup configuration
echo "[*] Configuring Envoy..."
mkdir -p /etc/envoy/eds

cat <<EOF > /etc/envoy/envoy.yaml
node:
  id: envoy-1
  cluster: envoy-cluster
  metadata:
    role: proxy
admin:
  access_log_path: /tmp/admin_access.log
  address:
    socket_address:
      address: 127.0.0.1
      port_value: 9901
static_resources:
  listeners:
    # HTTP listener
    - name: listener_http
      address:
        socket_address:
          address: 0.0.0.0
          port_value: 80
      filter_chains:
        - filters:
            - name: envoy.filters.network.tcp_proxy
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy
                stat_prefix: tcp_http
                cluster: app_http
    # HTTPS listener (TLS passthrough)
    - name: listener_https
      address:
        socket_address:
          address: 0.0.0.0
          port_value: 443
      filter_chains:
        - filters:
            - name: envoy.filters.network.tcp_proxy
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy
                stat_prefix: tcp_https
                cluster: app_https
  clusters:
    # HTTP cluster, file-based EDS
    - name: app_http
      connect_timeout: 2s
      type: EDS
      lb_policy: ROUND_ROBIN
      eds_cluster_config:
        eds_config:
          path: /etc/envoy/eds/app_http.json
      common_lb_config:
        healthy_panic_threshold:
          value: 0
      outlier_detection:
        consecutive_5xx: 5
        interval: 10s
        base_ejection_time: 30s
        max_ejection_percent: 50
      circuit_breakers:
        thresholds:
          - priority: DEFAULT
            max_connections: 1000
            max_pending_requests: 500
            max_requests: 300
    # HTTPS cluster, file-based EDS
    - name: app_https
      connect_timeout: 2s
      type: EDS
      lb_policy: ROUND_ROBIN
      eds_cluster_config:
        eds_config:
          path: /etc/envoy/eds/app_https.json
      common_lb_config:
        healthy_panic_threshold:
          value: 0
      outlier_detection:
        consecutive_5xx: 5
        interval: 10s
        base_ejection_time: 30s
        max_ejection_percent: 50
      circuit_breakers:
        thresholds:
          - priority: DEFAULT
            max_connections: 1000
            max_pending_requests: 10000
            max_connection_pools: 500
      transport_socket:
        name: envoy.transport_sockets.raw_buffer
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.transport_sockets.raw_buffer.v3.RawBuffer
EOF

# Create initial empty EDS files so Envoy doesn't crash on startup before controller updates them
for cluster in app_http app_https; do
  if [[ ! -f "/etc/envoy/eds/${cluster}.json" ]]; then
    cat <<EDS_EOF > "/etc/envoy/eds/${cluster}.json"
{
  "version_info": "1",
  "resources": [
    {
      "@type": "type.googleapis.com/envoy.config.endpoint.v3.ClusterLoadAssignment",
      "cluster_name": "${cluster}",
      "endpoints": []
    }
  ]
}
EDS_EOF
  fi
done

# 4. Systemd setup
echo "[*] Configuring systemd service for Envoy..."
systemctl unmask envoy.service >/dev/null 2>&1 || true

cat <<EOF > /etc/systemd/system/envoy.service
[Unit]
Description=Envoy Proxy
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
Restart=always
RestartSec=1
User=root
ExecStart=/usr/local/bin/envoy -c /etc/envoy/envoy.yaml

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now envoy

echo "[✓] Envoy Proxy installed and started."
