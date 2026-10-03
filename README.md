# mypi

自分の常用環境の安定と管理しやすさを優先した、TypeScript 製の Pi 拡張セットです。
[pi-lab](https://github.com/u7chan/pi-lab) の登録済み６機能を移植しています。
Public な Git リポジトリで配布し、npm には公開しません。

**１つの Pi package、１つの拡張入口**（`extensions/index.ts`）として配布します。
起動時の Extensions 欄で mypi 由来の表示は１項目になり、６機能を常に登録します。
機能別 ON/OFF 設定や設定 UI はありません。他の外部拡張の表示は変更しません。
既存の `/minimal-footer` などの操作は残しています。

## 機能

| 機能 | 動作 |
|---|---|
| cache-ttl | outgoing payload の cache metadata から推定した TTL を `CACHE 04:31` のように footer に表示。情報がない場合は `pending` / `auto` / `hit` / `unsupported` / `unknown` 等で区別 |
| cache-savings | 最新の assistant レスポンスの cache hit による推定節約額・token 数を `SAVED 1.5k tok ~$0.0010` と表示。hit がない応答や model/session 切り替えでクリア |
| minimal-footer | token/cost 統計ブロックを除き、cwd・branch・session 名、context 使用率、model/thinking、各 status を表示。`/minimal-footer` で本体 footer と往復 |
| default-model | `/dm`（別名 `/default-model`）と `set_default_model` ツールで起動時の既定モデル・thinking を保存 |
| git-status | origin（なければ upstream / 最初の remote）のリポジトリと、現在ブランチの PR を footer の OSC 8 リンクとして表示 |
| elapsed | `before_agent_start` から **`agent_settled`** までの経過時間を `Working (12m 3s)` にライブ表示し、確定値を `ELAPSED 12m 3s` として footer に残す |

status の key は従来どおり `cache-savings` / `cache-ttl` / `elapsed` / `git` で、
footer 上では key 順に共存します。OSC 8 リンクを幅に数えず、切り詰め時にはリンクを閉じます。
実際の TUI では Pi の列幅・grapheme ユーティリティを使用します。

### 既定モデルの操作

```text
/dm                                      # TUI では絞り込み可能な picker
/dm kimi                                 # あいまい検索（曖昧なら選択）
/dm provider/model:high                   # thinking も保存し、現セッションにも適用
/dm show                                 # 現在の既定を表示
```

`set_default_model` は `model`、任意の `provider` / `thinkingLevel` /
`applyToSession` を受け取ります。ツールは既定では保存だけ、`applyToSession: true` で
現セッションも切り替えます。

保存先は Pi の agent directory の `settings.json`（通常は `~/.pi/agent/settings.json`、
`PI_CODING_AGENT_DIR` で変更可能）です。Pi の file mutation queue 内で read-modify-write し、
一時ファイル + rename で保存します。既存キーとファイル権限を保持し、thinking 未指定なら
既存の `defaultThinkingLevel` を変更しません。不正・読み取り不能な settings は上書きせず失敗します。
未対応 thinking level は保存前に拒否します。

## 必要な環境

- 検証環境: WSL / Linux、Node.js 24.18.0、Bun 1.3.14、Pi 1.0.0。
- 実行には Pi と Node.js。Bun は開発テスト用です。
- リポジトリ表示には `git`。PR 表示には認証済みの `gh` CLI。
  `gh` がない・未認証・PR がない場合、PR 部分だけを省略します。
- リンクのクリックには OSC 8 対応端末が必要です。未対応時はテキスト表示になります。
  Windows Terminal は `WT_SESSION` / `WT_PROFILE_ID` も検出し、`PI_HYPERLINKS=0` なら無効化します。
- Pi が供給するパッケージは `peerDependencies: "*"` のみ宣言し、`dependencies` に同梱しません。

## インストール・更新

公開後の Git 配布例:

```sh
pi install git:github.com/u7chan/mypi@main
pi update git:github.com/u7chan/mypi@main
```

インストールは常用 Pi 設定に package を追加します。`@main` は rolling 配布です。
全拡張の更新には `pi update --extensions` も使えます。
**pi-lab の同じ６拡張とは同時ロードしないでください。** コマンド・ツール・表示が重複します。
常用環境への切り替えは、pi-lab の対象拡張を外す手順を確認してから行ってください。

## 開発・検証

```sh
git clone https://github.com/u7chan/mypi.git
cd mypi
bun test                           # host パッケージのインストール不要
node scripts/smoke-pi.mjs           # インストール済み Pi の SDK で隔離・offline 検証
node scripts/smoke-tui.mjs          # ローカル HTTP mock provider で実際の regular TUI を起動
node scripts/smoke-tui.mjs --fullscreen --git-fixture
```

SDK スクリプトは `pi` の実体から host package を探します。配置が違う場合は
`PI_SMOKE_PACKAGE_ROOT=/path/to/pi-coding-agent node scripts/smoke-pi.mjs` を指定します。
SDK/TUI スクリプトは一時 agent directory を作り、終了時に削除します。
ユーザーの常用 settings/auth/session は使いません。SDK の provider・git/gh は fixture、
TUI の provider はローカル mock（`--git-fixture` では git/gh も fixture）です。

TUI ではプロンプト、`save-default`（ツール実行）、`/dm show`、
`/dm mypi-smoke/other-model:high`、`/dm` の picker、`/minimal-footer` の往復を試し、
`/quit` で終了します。ANSI ログを残す場合は `PI_SMOKE_TUI_LOG=/tmp/mypi-tui.log` を指定します。

手元のモデルで一時ロードする場合（インストール・配布切り替えはしません）:

```sh
pi --no-extensions --no-session --verbose -e "$PWD"
```

この通常起動はユーザーの Pi 設定を読みます。保存操作を試す場合は、上記の隔離スクリプトか
一時 `PI_CODING_AGENT_DIR` を使用してください。拡張ファイル１個だけの symlink ではなく、
リポジトリ全体をロードします。

### 構成

```text
extensions/index.ts       # 唯一の入口。６つの登録関数を呼ぶだけ
src/<機能>/extension.ts   # Pi adapter・登録処理・機能別の状態
src/<機能>/core.ts        # 機能別 core
tests/<機能>.test.ts      # 移植したテストと回帰テスト
tests/entry.test.ts        # 二重登録・複数 handler・状態分離・UI mode・cleanup
scripts/smoke-*.mjs        # 実際の Pi での隔離検証
```

移植元・変更点・検証範囲は [移行記録](docs/migration.md) を参照してください。

## 既知の制約

- TTL は request 開始時刻を基準にした推定で、provider の実 expiry ではありません。
  暗黙 cache の provider/model family は TTL 非公開のため countdown を表示しません。
- 節約額は catalogue の tier と usage.cost に基づく最新応答の概算で、請求額ではありません。
  時間帯割引・subscription の実請求には追従せず、単価不明・矛盾・節約なしなら token 数だけです。
- minimal-footer は TUI のみ。自動 compaction の状態は公開 API から取れないため `(auto)` を省きます。
  他の footer 差し替え拡張とは競合し得ます。
- git/PR は shell tool 終了後・`agent_settled` で debounce 更新します。他端末や `!git checkout`
  の変更は次の再検出まで遅れます。PR 成功結果はブランチ単位で保持し、失敗は10秒後の再検出で再試行。
  初回コミット前など `git rev-parse HEAD` が失敗する checkout ではリンクを表示しません。
- elapsed は working 行と footer のみで、トランスクリプトへの完了行は追加しません。
  abort でも所要時間を残し、他の拡張の working 文言は完了時に既定へ戻します。
- UI なしの print/json は表示を触りません。RPC は既存どおり status/dialog を利用し、
  custom footer と working message の端末表示はありません。
- settings の mutation queue は同一 Pi プロセス内の直列化です。他プロセス・手編集との同時更新を
  ファイルロックで排他するものではありません。
- 入口や import のエラーは全機能のロードに影響します。機能別テストに加え、入口のロードを検証します。
