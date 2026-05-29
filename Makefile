FLY_APP ?= claude-managed-agents
FLY_CONFIG ?= fly.toml

# Keep internal MCP endpoints out of the committed root mcp-proxy.json.
# Put the private config at this gitignored path, then upload it to the /data
# volume path that fly.toml/start.sh read at runtime. /data persists across
# machine restarts; /etc lives on the ephemeral image rootfs and would be
# wiped (reset to the baked-in template) on every restart.
LOCAL_MCP_PROXY_CONFIG ?= .github-issue-agent/mcp-proxy.json
REMOTE_MCP_PROXY_CONFIG ?= /data/mcp-proxy.json
REMOTE_MCP_PROXY_DIR = $(patsubst %/,%,$(dir $(REMOTE_MCP_PROXY_CONFIG)))
REMOTE_MCP_PROXY_TMP ?= /tmp/mcp-proxy.$(shell date +%Y%m%d%H%M%S).json

.PHONY: help
help:
	@printf '%s\n' \
		'Available targets:' \
		'  mcp-proxy-config-init       Create gitignored local config from committed template' \
		'  fly-mcp-proxy-upload        Upload local config to Fly via SFTP and restart so mcp-proxy reloads' \
		'  fly-mcp-proxy-deploy        Alias for fly-mcp-proxy-upload (kept for backward compatibility)' \
		'  fly-mcp-proxy-download      Download remote config as a local backup' \
		'' \
		'Override examples:' \
		'  make fly-mcp-proxy-upload FLY_APP=my-app' \
		'  make fly-mcp-proxy-upload LOCAL_MCP_PROXY_CONFIG=.github-issue-agent/corp-mcp-proxy.json'

.PHONY: mcp-proxy-config-init
mcp-proxy-config-init:
	@if [ -e "$(LOCAL_MCP_PROXY_CONFIG)" ]; then \
		printf '%s\n' "$(LOCAL_MCP_PROXY_CONFIG) already exists"; \
		exit 0; \
	fi
	@mkdir -p "$(dir $(LOCAL_MCP_PROXY_CONFIG))"
	cp mcp-proxy.json "$(LOCAL_MCP_PROXY_CONFIG)"
	@printf '%s\n' "created $(LOCAL_MCP_PROXY_CONFIG)"

.PHONY: fly-mcp-proxy-upload
fly-mcp-proxy-upload:
	@test -f "$(LOCAL_MCP_PROXY_CONFIG)" || { \
		printf '%s\n' "missing $(LOCAL_MCP_PROXY_CONFIG)"; \
		printf '%s\n' "run: make mcp-proxy-config-init"; \
		exit 1; \
	}
	bun -e 'const fs = require("node:fs"); JSON.parse(fs.readFileSync(process.argv[1], "utf8"));' "$(LOCAL_MCP_PROXY_CONFIG)"
	fly ssh console --app "$(FLY_APP)" --config "$(FLY_CONFIG)" -C 'mkdir -p "$(REMOTE_MCP_PROXY_DIR)"'
	fly ssh sftp put "$(LOCAL_MCP_PROXY_CONFIG)" "$(REMOTE_MCP_PROXY_TMP)" --app "$(FLY_APP)" --config "$(FLY_CONFIG)" --mode 0644
	fly ssh console --app "$(FLY_APP)" --config "$(FLY_CONFIG)" -C 'mv "$(REMOTE_MCP_PROXY_TMP)" "$(REMOTE_MCP_PROXY_CONFIG)"'
	# fly ssh writes as root; the mcp-proxy process runs as the non-root `bun`
	# user, so the config must be world-readable. No secrets live in this file
	# (mcp-proxy uses --pass-environment for tokens), so 0644 is safe.
	fly ssh console --app "$(FLY_APP)" --config "$(FLY_CONFIG)" -C 'chmod 0644 "$(REMOTE_MCP_PROXY_CONFIG)"'
	@printf '%s\n' "uploaded $(LOCAL_MCP_PROXY_CONFIG) -> $(FLY_APP):$(REMOTE_MCP_PROXY_CONFIG)"
	# mcp-proxy reads --named-server-config only at startup, so restart the app
	# to make the uploaded config take effect. /data persists across the restart,
	# so the upload is preserved (start.sh keeps the existing file, no re-seed).
	fly apps restart "$(FLY_APP)"
	@printf '%s\n' "restarted $(FLY_APP); mcp-proxy reloaded $(REMOTE_MCP_PROXY_CONFIG)"

# Retained as a thin alias: fly-mcp-proxy-upload now uploads *and* restarts,
# so deploy and upload are equivalent.
.PHONY: fly-mcp-proxy-deploy
fly-mcp-proxy-deploy: fly-mcp-proxy-upload

.PHONY: fly-mcp-proxy-download
fly-mcp-proxy-download:
	@mkdir -p .github-issue-agent/backups
	fly ssh sftp get "$(REMOTE_MCP_PROXY_CONFIG)" ".github-issue-agent/backups/mcp-proxy.$$(date +%Y%m%d%H%M%S).json" --app "$(FLY_APP)" --config "$(FLY_CONFIG)"
