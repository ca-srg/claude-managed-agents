# E2E テストセットアップガイド

## 概要

このドキュメントは、`scripts/e2e-real.ts` を使って実リポジトリ向けの統合ハーネスを実行するための準備手順をまとめたものです。`scripts/e2e-real.ts` は `E2E=1` が明示されない限り起動を拒否します。既定の fixture repo は同梱していないため、利用者が自分で使い捨てのテスト用リポジトリを用意してください。

## 必要な環境

- `bun` 1.3+
- GitHub アカウント
- Anthropic API キー
- 書き込み可能な disposable GitHub repository
- 親 issue を作成できる GitHub 権限

## 使い捨てリポジトリの準備

1. GitHub 上で disposable な空リポジトリを作成します。共有リポジトリや production repository は使わないでください。
2. default branch は `main` のままで構いません。
3. 親 issue を 1 件作成します。内容は小さく安全なものにしてください。例: `Add hello.txt at repo root`。
4. 実行前に次の前提を満たしてください。
   - 親 issue は open
   - 親 issue に sub-issue が 0 件
   - `agent/issue-<issue-number>/*` に一致する branch が local / remote ともに存在しない
   - 親 issue を参照する open PR が存在しない

## GitHub 認証の準備

対象リポジトリにインストール済みの GitHub App を使います。GitHub App には少なくとも次の権限を付与してください。

- `Metadata: read`
- `contents: write`
- `issues: write`
- `pull_requests: write`

## 環境変数の設定

```bash
export E2E=1
export TEST_REPO=<owner>/<repo>
export TEST_ISSUE=<issue-number>
export GITHUB_APP_ID=<app-id>
export GITHUB_APP_PRIVATE_KEY_PATH=/path/to/private-key.pem
export ANTHROPIC_API_KEY=sk-ant-...
```

`TEST_REPO` は `owner/repo` 形式のみ受け付けます。`TEST_ISSUE` は正の整数である必要があります。

## 実行

```bash
cd github-issue
E2E=1 bun run scripts/e2e-real.ts 2>&1 | tee .sisyphus/evidence/task-25-e2e.log
```

正常終了時は次の machine-readable marker が出力されます。

- `PR_URL=https://github.com/<owner>/<repo>/pull/<n>`
- `RUN_ID=<uuidv7>`
- `CLEANUP=OK`
- `THREAD_OBSERVED=true|false`
  - Managed Agents の coordinator topology が child thread (`thread_created` / `thread_message_*` / `thread_status_*`) を 1 件以上 emit したかの best-effort フラグ。`false` でも run が成功すればテスト自体は pass 扱いだが、operator はこの値で delegation の発火を確認できます。

このスクリプトは内部で `main()` を使って本番パイプラインを実行し、その後に GitHub REST API で post-condition を確認して cleanup します。

## 検証

`scripts/e2e-real.ts` は次を確認します。

1. PR が作成され、body に `Closes #<parent>` を含むこと
2. sub-issue が作成され、親 issue に link されていること
3. feature branch が push されていること
4. run state に PR URL と sub-issue 一覧が保存されていること

Task 25 では operator が次の evidence を採取します。

- `.sisyphus/evidence/task-25-e2e.log`
- `.sisyphus/evidence/task-25-cleanup.log`

これら 2 つは live credential が必要なため、実運用時に operator が作成します。

## クリーンアップ

`scripts/e2e-real.ts` は成功時も検証失敗時も best-effort cleanup を走らせます。cleanup 後に Anthropic 側の残留物を確認するには、実行で得た `RUN_ID` を使って次を実行します。

```bash
bun run scripts/verify-cleanup.ts --run-id "$(cat /tmp/ghissue-runid)"
```

正常終了時は次を出力します。

- `VAULT_CLEANUP=OK`
- `SESSION_CLEANUP=OK`

親 issue 自体は cleanup 対象ではありません。cleanup は PR、agent が作成した sub-issue、branch、Vault / Session のみを巻き戻します。

## トラブルシューティング

- `E2E=1 required; refusing to run integration harness`
  - `E2E=1` を export してから再実行してください。
- `TEST_REPO=<owner>/<repo> required`
  - `TEST_REPO` の形式を見直してください。URL ではなく `owner/repo` です。
- `TEST_ISSUE=<positive int> required`
  - issue 番号を整数で指定してください。
- `ANTHROPIC_API_KEY is required`
  - live key を設定してください。
- `GitHub authentication is required`
  - `GITHUB_APP_ID` と `GITHUB_APP_PRIVATE_KEY` または `GITHUB_APP_PRIVATE_KEY_PATH` を設定してください。
- cleanup が途中で失敗した場合
  - 対象 repo に残った PR / branch / sub-issue を目視で確認し、ログの route を追って手動 cleanup してください。

## コスト

このテストは Anthropic API の live call を行うため課金が発生します。`scripts/e2e-real.ts` は実リポジトリに対して PR 作成と cleanup まで行うので、必要なときだけ実行してください。小さい fixture issue を使い、同じ disposable repo を繰り返し流用する運用を推奨します。
