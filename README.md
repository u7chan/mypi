# mypi

自分の常用環境の安定性と管理のしやすさを優先した、TypeScript製のPi拡張セットです。
[pi-lab](https://github.com/u7chan/pi-lab)で登録済みの6機能を移植しています。
公開Gitリポジトリで配布し、npmには公開しません。

1つのPiパッケージとして配布し、拡張のエントリーポイントも1つ（`extensions/index.ts`）にまとめています。
起動時には6機能を常に登録し、Extensions欄にはmypi由来の項目を1つだけ表示します。
機能別のON/OFF設定や設定UIはありません。他の外部拡張の表示は変更しません。
既存の`/minimal-footer`などの操作は残しています。

## 機能

| 機能 | 動作 |
|---|---|
| cache-ttl | 送信ペイロードのキャッシュメタデータから推定したTTLを、`CACHE 04:31`のようにフッターに表示します。情報がない場合は`pending` / `auto` / `hit` / `unsupported` / `unknown`などで区別します |
| cache-savings | アシスタントの最新の応答で、キャッシュヒットによる推定節約額・トークン数を`SAVED 1.5k tok ~$0.0010`と表示します。ヒットしなかった応答やモデル・セッションの切り替え時には表示を消します |
| minimal-footer | トークン数・コストの統計ブロックを除き、cwd・ブランチ・セッション名、コンテキスト使用率、モデル・thinking、各ステータスを表示します。`/minimal-footer`でPi標準のフッターと切り替えます |
| default-model | `/dm`（別名`/default-model`）と`set_default_model`ツールで起動時の既定モデル・thinkingを保存します |
| git-status | origin（なければupstreamまたは最初のリモート）のリポジトリと、現在のブランチのPRをフッターにOSC 8リンクとして表示します |
| elapsed | `before_agent_start`から`agent_settled`までの経過時間を`Working (12m 3s)`にリアルタイムで表示し、確定値を`ELAPSED 12m 3s`としてフッターに残します |

ステータスのキーは従来どおり`cache-savings` / `cache-ttl` / `elapsed` / `git`で、
フッターにはキーの順に並べて表示します。OSC 8リンクは表示幅に含めず、切り詰める際にはリンクを閉じます。
実際のTUIでは、列幅と書記素を扱うPiのユーティリティを使用します。

### 既定モデルの操作

```text
/dm                                      # TUIでは絞り込み可能な選択画面
/dm kimi                                 # あいまい検索（曖昧なら選択）
/dm provider/model:high                   # thinkingも保存し、現在のセッションにも適用
/dm show                                 # 現在の既定を表示
```

`set_default_model`は`model`と、任意の`provider` / `thinkingLevel` / `applyToSession`を受け取ります。
既定では保存だけを行い、`applyToSession: true`を指定すると現在のセッションも切り替えます。

保存先はPiのエージェントディレクトリ内の`settings.json`です。
通常は`~/.pi/agent/settings.json`で、`PI_CODING_AGENT_DIR`で変更できます。
設定の読み取り・変更・書き込みはPiのファイル更新キュー内で行い、一時ファイルをrenameして保存します。
既存のキーとファイル権限を保持し、thinkingが未指定なら既存の`defaultThinkingLevel`を変更しません。
設定が不正、または読み取れない場合は上書きせず、保存処理は失敗します。
未対応のthinking levelは保存前に拒否します。

## 必要な環境

- 検証環境はWSL / Linux、Node.js 24.18.0、Bun 1.3.14、Pi 1.0.0です。
- 実行にはPiとNode.jsが必要です。Bunは開発テスト用です。
- リポジトリ表示には`git`、PR表示には認証済みの`gh` CLIが必要です。
  `gh`がないか未認証の場合や、PRがない場合は、PR部分だけを省略します。
- リンクをクリックするにはOSC 8対応の端末が必要です。未対応の場合はテキスト表示になります。
  Windows Terminalでは`WT_SESSION` / `WT_PROFILE_ID`も検出し、`PI_HYPERLINKS=0`ならリンクを無効にします。
- Piが提供するパッケージは`peerDependencies: "*"`にのみ宣言し、`dependencies`には含めません。

## インストール・更新

公開後のGit経由のインストール・更新例です。

```sh
pi install git:github.com/u7chan/mypi@main
pi update git:github.com/u7chan/mypi@main
```

インストールすると、常用しているPiの設定にパッケージが追加されます。`@main`はローリング配布です。
全拡張の更新には`pi update --extensions`も使えます。
**pi-labの同じ6拡張とは同時にロードしないでください**。コマンド・ツール・表示が重複します。
常用環境を切り替える前に、pi-labの対象拡張を外す手順を確認してください。

## 開発・検証

```sh
git clone https://github.com/u7chan/mypi.git
cd mypi
bun test                           # ホストパッケージのインストールは不要
node scripts/smoke-pi.mjs           # インストール済みPiのSDKで隔離・オフライン検証
node scripts/smoke-tui.mjs          # ローカルHTTPモックプロバイダーで実際のregular TUIを起動
node scripts/smoke-tui.mjs --fullscreen --git-fixture
```

SDKスクリプトは`pi`の実体からホストパッケージを探します。配置が異なる場合は
`PI_SMOKE_PACKAGE_ROOT=/path/to/pi-coding-agent node scripts/smoke-pi.mjs`を指定します。
SDK/TUIスクリプトは一時エージェントディレクトリを作り、終了時に削除します。
ユーザーが常用している設定・認証情報・セッションは使いません。
SDKのプロバイダーとgit/ghにはフィクスチャを使い、TUIのプロバイダーにはローカルモックを使います。
`--git-fixture`指定時は、TUIのgit/ghにもフィクスチャを使います。

TUIではプロンプト、`save-default`によるツール実行、`/dm show`、
`/dm mypi-smoke/other-model:high`、`/dm`の選択画面、`/minimal-footer`での切り替えを試し、
`/quit`で終了します。ANSIログを残す場合は`PI_SMOKE_TUI_LOG=/tmp/mypi-tui.log`を指定します。

手元のモデルで一時的にロードする場合は、次のコマンドを使います。インストールや配布の切り替えは行いません。

```sh
pi --no-extensions --no-session --verbose -e "$PWD"
```

この通常起動ではユーザーのPi設定を読みます。保存操作を試す場合は、上記の隔離スクリプトを使うか、
`PI_CODING_AGENT_DIR`に一時ディレクトリを指定してください。
拡張ファイル1個だけをシンボリックリンクで読み込むのではなく、リポジトリ全体をロードします。

### 構成

```text
extensions/index.ts       # 唯一のエントリーポイント。6つの登録関数を呼ぶだけ
src/<機能>/extension.ts   # Piアダプター・登録処理・機能別の状態
src/<機能>/core.ts        # 機能別のコア処理
tests/<機能>.test.ts      # 移植したテストと回帰テスト
tests/entry.test.ts        # 二重登録・複数ハンドラー・状態分離・UIモード・終了処理
scripts/smoke-*.mjs        # 実際のPiでの隔離検証
```

移植元・変更点・検証範囲は[移行記録](docs/migration.md)を参照してください。

## ライセンス

[MIT License](LICENSE)。Copyright (c) 2026 u7chan。

## 既知の制約

- TTLはリクエスト開始時刻を基準にした推定値で、プロバイダーの実際の有効期限ではありません。
  暗黙のキャッシュを使うプロバイダー・モデル系列はTTLが非公開のため、カウントダウンを表示しません。
- 節約額はカタログの料金区分と`usage.cost`に基づく最新応答の概算で、請求額ではありません。
  時間帯割引やサブスクリプションの実際の請求には追従しません。
  単価が不明、矛盾がある、または節約がない場合はトークン数だけを表示します。
- minimal-footerはTUI専用です。自動コンパクションの状態は公開APIから取得できないため、`(auto)`を省略します。
  他のフッター差し替え拡張とは競合する可能性があります。
- git/PR表示はシェルツールの終了後と`agent_settled`時に、デバウンスして更新します。
  他の端末や`!git checkout`による変更は、次の再検出まで反映が遅れます。
  PR取得の成功結果はブランチ単位で保持し、失敗した場合は10秒後の再検出で再試行します。
  初回コミット前など、`git rev-parse HEAD`が失敗するチェックアウトではリンクを表示しません。
- elapsedはworking行とフッターにだけ表示し、トランスクリプトには完了行を追加しません。
  中断時も所要時間を残し、他の拡張のworkingメッセージは完了時に既定の文言に戻します。
- UIのないprint/jsonモードでは表示を変更しません。RPCでは従来どおりstatus/dialogを利用しますが、
  カスタムフッターとworkingメッセージの端末表示はありません。
- 設定の更新キューは、同じPiプロセス内で更新を直列化するものです。
  他のプロセスや手作業での編集による同時更新を、ファイルロックで排他制御するものではありません。
- エントリーポイントやimportのエラーは全機能のロードに影響します。
  機能別のテストに加え、エントリーポイントのロードも検証します。
