# Local Development

ローカルで `github-issue-agent` を開発するための手順と、Claude Managed Agents
が手元のマシン上の MCP server に到達できるようにするための **dev tunnel** の
仕組みをまとめる。

## 前提

- [Bun](https://bun.sh) 1.3 以上
- Python 3 (`mcp-proxy` を pip 経由で入れる場合)
- GitHub App credentials (`GITHUB_APP_ID`, private key)
- `ANTHROPIC_API_KEY`
- (任意) [ngrok](https://ngrok.com/) アカウントと authtoken — ローカル MCP を
  Managed Agents 側から呼び出す場合に必要

## セットアップ

```bash
bun install
cp .env.example .env
# .env を編集して ANTHROPIC_API_KEY / GITHUB_APP_* を埋める
bun run start
# → Listening on http://127.0.0.1:3000
```

検証コマンド:

```bash
bun run lint        # biome check .
bun run typecheck   # tsc --noEmit
bun test            # 全テスト
```

検証順は `lint` → `typecheck` → `test`。CI ではこれらを走らせないため、
ローカルで通すのは開発者責任。

## ローカル MCP Dev Tunnel

### なぜ必要か

Claude Managed Agents は Anthropic 側クラウドで動くため、`127.0.0.1` 上で
listen している MCP server には直接到達できない。本番 (Fly.io) では
**Cloudflare Tunnel** が `scripts/start.sh` から起動して mcp-gateway を
公開しているが、ローカル開発ではこの sidecar は動かない。

`ENABLE_DEV_TUNNEL=true` を設定すると `bun run start` が次の sidecar を
自動的に立ち上げ、Cloudflare Tunnel の代わりに **ngrok** で gateway を
公開する。

### アーキテクチャ

```
Claude Managed Agents (Anthropic cloud)
  └─ https://<random>.ngrok.app/servers/<name>/mcp
       └─ ngrok tunnel
            └─ mcp-gateway (Bun subprocess, port 8097)
                 - Bearer token 認証 (MCP_GATEWAY_TOKEN)
                 - CIDR allowlist は dev tunnel 中のみ bypass
                   (MCP_GATEWAY_DISABLE_CLIENT_IP_CHECK=true 相当)
                 └─ mcp-proxy (Python subprocess, port 8096)
                      └─ stdio MCP server (mcp-proxy.json の named server)
```

dev tunnel 経路でも mcp-gateway は本番 (Fly sidecar) と同じく **別 Bun
プロセス** として起動する (`bun src/features/mcp-gateway/server.ts` を
`Bun.spawn` で呼ぶ)。当初は in-process (`Bun.serve()` を main process 内で
呼ぶ) で実装していたが、socket-firewall 等の対話 shell helper が親 bun
process の TCP を hook してしまい、ngrok 経由のリクエストが Socket Firewall
の interstitial (`405 Socket Firewall Connection Required`) でブロックされる
事象が発生したため subprocess 化した。

### 起動手順

#### 1. mcp-proxy のインストール

mcp-proxy は Python パッケージで、Docker image には `pip install mcp-proxy==0.11.0`
で入れている (`Dockerfile`)。手元でも同等のバージョンを入れる:

```bash
pip install --user mcp-proxy
# あるいは venv に入れる場合
python3 -m venv .venv && .venv/bin/pip install mcp-proxy
```

`mcp-proxy --help` がエラー無く動くことを確認する。

#### 2. ngrok authtoken の取得

[ngrok dashboard](https://dashboard.ngrok.com/get-started/your-authtoken) で
authtoken を取得する。`ngrok` CLI のインストールは不要 (Node 用の native SDK
`@ngrok/ngrok` を `bun add` 済み)。

#### 3. mcp-proxy.json の確認

リポジトリ root に `mcp-proxy.json` がある。デフォルトでは `figma` を含む:

```json
{
  "mcpServers": {
    "figma": {
      "command": "npx",
      "args": ["-y", "figma-developer-mcp", "--stdio", "--skip-image-downloads"]
    }
  }
}
```

新しい server を追加する場合はこのファイルに entry を増やす。`MCP_PROXY_CONFIG`
env で別パスを指す事もできる。

#### 4. .env を編集

```sh
ENABLE_DEV_TUNNEL=true
NGROK_AUTHTOKEN=2x...
MCP_GATEWAY_TOKEN=$(uuidgen)     # 任意の長いランダム文字列。固定値推奨。

# 必要に応じて mcp-proxy.json の一部の server だけを露出する場合:
# DEV_TUNNEL_TARGET_SERVERS=figma
```

`MCP_GATEWAY_TOKEN` は Managed Agents が gateway を呼ぶ際の Bearer。`mcp_servers`
テーブルには `token_env_name = "MCP_GATEWAY_TOKEN"` で登録される。**毎回違う
値にすると vault credential が DB に溜まる**ので、`.env` に固定して書く。

#### 5. 起動

```bash
bun run start
```

起動ログに以下のようなメッセージが出れば成功:

```
{"component":"dev-tunnel","msg":"starting dev tunnel", ...}
{"component":"dev-tunnel","msg":"mcp-proxy ready", ...}
{"component":"dev-tunnel","msg":"mcp-gateway in-process listener ready", ...}
{"component":"dev-tunnel","status":"connected","msg":"ngrok status changed"}
{"component":"dev-tunnel","publicUrl":"https://xxx.ngrok.app", ...}
{"component":"dev-tunnel","msg":"dev-tunnel: created/updated mcp_servers row", ...}
```

WebUI の `/mcp-servers` (もしくは DB) を見ると、`figma` などの row の `url` が
`https://xxx.ngrok.app/servers/figma/mcp` に書き換わっている。次回 run 実行
時に Managed Agents 側 agent definition に反映される。

### 環境変数まとめ

| env | 必須/任意 | デフォルト | 説明 |
|---|---|---|---|
| `ENABLE_DEV_TUNNEL` | 任意 | unset | `true` で dev tunnel sidecar 一式を起動 |
| `NGROK_AUTHTOKEN` | 有効時必須 | — | ngrok authtoken |
| `MCP_GATEWAY_TOKEN` | 有効時必須 | — | gateway の Bearer token (固定値推奨) |
| `DEV_TUNNEL_TARGET_SERVERS` | 任意 | mcp-proxy.json 全エントリ | カンマ区切りで対象 server を絞る |
| `DEV_TUNNEL_DROP_NODE_EXTRA_CA_CERTS` | 任意 | `false` | `true` で subprocess の env から `NODE_EXTRA_CA_CERTS` を削除。socket-firewall 等の対話 shell helper を使っている環境で必要 (下記トラブルシューティング参照) |
| `MCP_PROXY_HOST` | 任意 | `127.0.0.1` | mcp-proxy bind host |
| `MCP_PROXY_PORT` | 任意 | `8096` | mcp-proxy listen port |
| `MCP_PROXY_CONFIG` | 任意 | `./mcp-proxy.json` | named-server config パス |
| `MCP_GATEWAY_HOST` | 任意 | `127.0.0.1` | gateway bind host |
| `MCP_GATEWAY_PORT` | 任意 | `8097` | gateway listen port |
| `MCP_GATEWAY_DISABLE_CLIENT_IP_CHECK` | 任意 | `false` | gateway 単体で起動する場合に IP allowlist を無効化 (dev tunnel ON のときは内部で true 扱い) |

### 仕組み (実装)

- `src/features/dev-tunnel/index.ts` — supervisor。env 検証 / mcp-proxy spawn /
  mcp-gateway spawn / ngrok 起動 / `mcp_servers` upsert を行う。各 subprocess
  は `/healthz` または `/` への TCP reachability poll で起動完了を待つ
- `src/features/dev-tunnel/servers-sync.ts` — `mcp_servers` テーブルの upsert
  ロジック。builtin row (`github`) は touch しない
- `src/features/mcp-gateway/server.ts` — `disableClientIpCheck` オプションで
  CF-Connecting-IP ベースの CIDR allowlist を bypass できる
- `index.ts` — `startDevTunnel(...)` を起動時に呼び、cleanup registry に
  `handle.stop()` を登録

dev tunnel が落ちても他の機能は動き続けるよう、起動失敗は warn ログのみで
process は継続する。

### トラブルシューティング

- `dev-tunnel: failed to spawn mcp-proxy` →
  `pip install mcp-proxy` で `mcp-proxy` を PATH に通す
- `dev-tunnel: timed out waiting for http://127.0.0.1:8096/` →
  port 8096 が既に使われていないか確認 (`lsof -iTCP:8096`)
- `ENABLE_DEV_TUNNEL=true requires NGROK_AUTHTOKEN` /
  `... requires MCP_GATEWAY_TOKEN` → `.env` に該当 env を追加
- ngrok が `ERR_NGROK_4018` (account limit) → 既存 tunnel を閉じるか
  free plan の同時 tunnel 上限を確認
- Managed Agents から 401 → `MCP_GATEWAY_TOKEN` の値が `mcp_servers` 登録時と
  一致しているか確認 (再起動を挟むと token を変えてしまいがち)
- ngrok URL が起動毎に変わる → 無料 plan の制約。固定したい場合は ngrok
  reserved domain (paid plan) を取得し、`@ngrok/ngrok` の `domain` オプションで
  指定する (実装は要追加)
- mcp-proxy のログに `npm error code UNABLE_TO_GET_ISSUER_CERT_LOCALLY` /
  `unable to get local issuer certificate` →
  mcp-proxy の `npx` 子プロセスが registry の TLS 検証に失敗。
  原因は環境によって 2 通り。dev-tunnel 起動時に出る
  `dev-tunnel: TLS / npm registry env propagated ...` ログの
  `nodeExtraCaCerts` を確認する。

  **(A) `nodeExtraCaCerts` が `/var/folders/.../sfw-XXXX/socketFirewallCa.crt`
  のような temp dir のパスになっている場合**:
  対話 shell helper (socket-firewall や類似ツール) が ephemeral CA を生成して
  `NODE_EXTRA_CA_CERTS` に set している。これが subprocess に伝わると、
  Node が temp CA を読み込もうとして失敗、default trust store にも fallback
  しない。`bun run start` を起動した shell で別 terminal を開いて
  `npx -y figma-developer-mcp --stdio --skip-image-downloads` を直接叩いて
  動くなら、registry 自体は default CA で検証可能なので、subprocess から
  CA を **削除** するだけで解決する。`.env` に以下を追加して再起動:

  ```sh
  DEV_TUNNEL_DROP_NODE_EXTRA_CA_CERTS=true
  ```

  **(B) `nodeExtraCaCerts` が `(unset)` で、社内 npm proxy registry を
  使っている場合**:
  registry の証明書チェーンに default trust store では検証できない
  中間 CA がある。社内 CA bundle (PEM) を入手して、`bun run start` を
  実行する shell に **export** してから起動:

  ```sh
  export NODE_EXTRA_CA_CERTS=/path/to/corporate-ca-bundle.pem
  ```

  `NODE_TLS_REJECT_UNAUTHORIZED=0` は最終手段 (検証を完全に無効化するので
  非推奨)。
- mcp-proxy のログに `mcp.shared.exceptions.McpError: Connection closed` +
  Managed Agents 側で `MCP server '<name>' initialize failed: HTTP 405` →
  stdio MCP server (`npx ...` など) が起動できていない。直前のログに
  npm / npx / docker / 各 CLI のエラーが出ているはずなのでそちらが本筋
  (上の `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` も典型例)。

## テスト

```bash
bun test                                # 全テスト
bun test src/features/dev-tunnel        # dev-tunnel のみ
bun test --coverage                     # カバレッジ
```

ソース横の `__tests__/` にテストを colocate するのが基本。
詳細は `AGENTS.md` の「テスト」セクション参照。

## 関連ドキュメント

- `AGENTS.md` — リポジトリ全体の作法、コマンド、アーキテクチャ
- `docs/mcp.md` — 本番 (Cloudflare Tunnel) 構成の詳細
- `docs/deploy-fly.md` — Fly.io デプロイ手順
- `docs/e2e-setup.md` — E2E テスト環境
