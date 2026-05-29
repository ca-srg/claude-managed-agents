FLY_APP ?= claude-managed-agents
FLY_CONFIG ?= fly.toml

# Keep internal MCP endpoints out of the committed root mcp-proxy.json.
# Put the private config at this gitignored path, then upload it to the path
# currently used by fly.toml/start.sh.
LOCAL_MCP_PROXY_CONFIG ?= .github-issue-agent/mcp-proxy.json
REMOTE_MCP_PROXY_CONFIG ?= /etc/mcp-proxy/mcp-proxy.json
REMOTE_MCP_PROXY_DIR = $(patsubst %/,%,$(dir $(REMOTE_MCP_PROXY_CONFIG)))
REMOTE_MCP_PROXY_TMP ?= /tmp/mcp-proxy.$(shell date +%Y%m%d%H%M%S).json

.PHONY: help
help:
	@printf '%s\n' \
		'Available targets:' \
		'  mcp-proxy-config-init       Create gitignored local config from committed template' \
		'  fly-mcp-proxy-upload        Upload local config to Fly via SFTP' \
		'  fly-mcp-proxy-restart       Restart Fly app so mcp-proxy reloads config' \
		'  fly-mcp-proxy-deploy        Upload config, then restart Fly app' \
		'  fly-mcp-proxy-download      Download remote config as a local backup' \
		'' \
		'Override examples:' \
		'  make fly-mcp-proxy-deploy FLY_APP=my-app' \
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
	fly ssh sftp put "$(LOCAL_MCP_PROXY_CONFIG)" "$(REMOTE_MCP_PROXY_TMP)" --app "$(FLY_APP)" --config "$(FLY_CONFIG)" --mode 0600
	fly ssh console --app "$(FLY_APP)" --config "$(FLY_CONFIG)" -C 'mv "$(REMOTE_MCP_PROXY_TMP)" "$(REMOTE_MCP_PROXY_CONFIG)"'
	fly ssh console --app "$(FLY_APP)" --config "$(FLY_CONFIG)" -C 'chmod 0600 "$(REMOTE_MCP_PROXY_CONFIG)"'
	@printf '%s\n' "uploaded $(LOCAL_MCP_PROXY_CONFIG) -> $(FLY_APP):$(REMOTE_MCP_PROXY_CONFIG)"

.PHONY: fly-mcp-proxy-restart
fly-mcp-proxy-restart:
	fly apps restart "$(FLY_APP)"

.PHONY: fly-mcp-proxy-deploy
fly-mcp-proxy-deploy: fly-mcp-proxy-upload fly-mcp-proxy-restart

.PHONY: fly-mcp-proxy-download
fly-mcp-proxy-download:
	@mkdir -p .github-issue-agent/backups
	fly ssh sftp get "$(REMOTE_MCP_PROXY_CONFIG)" ".github-issue-agent/backups/mcp-proxy.$$(date +%Y%m%d%H%M%S).json" --app "$(FLY_APP)" --config "$(FLY_CONFIG)"
