# mypi

自分の常用環境の安定性と管理のしやすさを優先した、TypeScript製のPi拡張セットです。
[pi-lab](https://github.com/u7chan/pi-lab)で登録済みの6機能と、実行中の状態を外部へ書き出すlive-thinkingを移植し、
生成速度の表示を追加しています。
公開Gitリポジトリで配布し、npmには公開しません。

1つのPiパッケージとして配布し、拡張のエントリーポイントも1つ（`extensions/index.ts`）にまとめています。
起動時には8機能を常に登録し、Extensions欄にはmypi由来の項目を1つだけ表示します。
機能別のON/OFF設定や設定UIはありません。他の外部拡張の表示は変更しません。
既存の`/minimal-footer`などの操作は残しています。

## 機能

| 機能 | 動作 |
|---|---|
| cache-ttl | 送信ペイロードのキャッシュメタデータから推定した残り時間を`ttl 4:31`のように表示します。TTLがない場合は状態を`cache auto` / `cache off` / `cache hit` / `cache expired`で示し、情報のない`pending`と`unknown`は表示しません |
| cache-reuse | アシスタントの最新の応答でキャッシュから読まれたトークン数を`cached 1.5k`と表示します。金額の推定はしません。ヒットしなかった応答やモデル・セッションの切り替え時には表示を消します |
| minimal-footer | トークン数・コストの統計ブロックを除いた2行のフッター（他の拡張のステータスが2行目に収まらないときだけ3行）に、cwd・ブランチ・セッション名、コンテキスト使用率、モデル・thinking（`zai glm-5.3-flash max`）、各ステータスを表示します。`/minimal-footer`でPi標準のフッターと切り替えます |
| default-model | `/dm`（別名`/default-model`）と`set_default_model`ツールで起動時の既定モデル・thinkingを保存します |
| git-status | origin（なければupstreamまたは最初のリモート）のリポジトリと、現在のブランチのPRをフッターにOSC 8リンクとして表示します |
| elapsed | `before_agent_start`から`agent_settled`までの経過時間を`Working (12m 3s)`にリアルタイムで表示し、確定値を`elapsed 12m 3s`としてフッターに残します |
| tok-rate | 生成中は最新の assistant 応答の速度を`4.6 tok/s`（差分からの推定）で表示し、指示が落ち着いたら測定できた成功メッセージの合計`usage.output`÷合計生成時間を`avg 92 tok/s`で表示します。短すぎる、またはまとめて届いた応答は生成時間を測れないため`-- tok/s`と表示します |
| live-thinking | 実行中のphase・thinkingの末尾・生成中の速度を、セッションの隣の`<session>.jsonl.thinking.json`に書き出します。hwc（Herdr Web Client）などの外部クライアントが、piのプロセスにアタッチせず、TUIも読まずに実行中の状態を表示できます。phaseは`waiting` / `thinking` / `writing` / `tool-call` / `tool` / `compacting` / `waiting-user`の7段階で、1行JSONを上書きのみします。`tokPerSecond`はtok-rateと同じsamplerで測った現在のassistant応答の推定速度（tok/s、丸めなし）で、`thinking` / `writing` / `tool-call`のときだけ入り、`message_end`で消えます。thinkingは末尾1200文字だけを500ms間隔でまとめ、phaseの変化は即時に書きます。tmpとrenameで置き換えて権限0600にし、`agent_settled`と`session_shutdown`で削除、セッションファイルのない起動では何もしません。TUI・トランスクリプト・フッターは変更しません |

minimal-footerのステータスはコンテキスト使用率と同じ行に`5.0k/256k (2.0%) · elapsed 2s · 4.6 tok/s · ttl 4:31 · cached 1k`のように並べ、`elapsed` / `tok` / `cache-ttl` / `cache-reuse`の順、他の拡張はキー順でその後、`git`は最後に置きます。
区切りは` · `で、ラベルはdim、値は通常色にします。幅が足りない場合は右寄せのモデル情報を`provider model level` → `model level` → `model` → 非表示の順に落とし、ステータスを優先します。
`elapsed` / `tok` / `cache-ttl` / `cache-reuse`と`git`は2行目に固定します。他の拡張のステータスまで含めた全体が2行目に収まらない場合は、他の拡張のステータスだけを3行目へ移します。Codex使用時の`Codex adapter V: low • weekly: 60% left`が例で（pi-codex-conversionでは1つのステータス）、PRリンクが`u7...`に切れる代わりに、3行目でそのまま表示し、空いた幅はモデル情報に戻します。3行目も収まらない場合は3行目を切り詰め、他の拡張のステータスを除いても2行目が収まらない場合は2行目のまま切り詰めます。
Pi標準フッターへ切り替えると、ステータスは独立した行に戻り、並びはキー順、区切りはスペースになります（ラベルと色は同じです）。
OSC 8リンクは表示幅に含めず、切り詰める際にはリンクを閉じます。
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
**pi-labの同じ6拡張やlive-thinkingのPoCとは同時にロードしないでください**。コマンド・ツール・表示が重複します。
live-thinkingのPoCを一時的に`extensions`で読み込んでいる場合は、同じsidecarへ二重に書くため、mypi側を入れる前に外してください。
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
extensions/index.ts       # 唯一のエントリーポイント。8つの登録関数を呼ぶだけ
src/<機能>/extension.ts   # Piアダプター・登録処理・機能別の状態
src/<機能>/core.ts        # 機能別のコア処理
src/tok-rate/sampler.ts   # tok-rateとlive-thinkingが共有する生成速度の測定
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
  情報のない`pending` / `unknown`は表示せず、状態語だけを出す場合があります。
- cache-reuseは最新応答の`usage.cacheRead`だけを表示します。サブスクリプション運用を前提に、
  カタログ単価との差から金額を推定することはしません。ヒットしなかった応答、モデル・セッションの
  切り替えでは表示を消します。
- minimal-footerはTUI専用です。自動コンパクションの状態は公開APIから取得できないため、`(auto)`を省略します。
  他のフッター差し替え拡張とは競合する可能性があります。
- git/PR表示はシェルツールの終了後と`agent_settled`時に、デバウンスして更新します。
  他の端末や`!git checkout`による変更は、次の再検出まで反映が遅れます。
  PR取得の成功結果はブランチ単位で保持し、失敗した場合は10秒後の再検出で再試行します。
  初回コミット前など、`git rev-parse HEAD`が失敗するチェックアウトではリンクを表示しません。
- elapsedはworking行とフッターにだけ表示し、トランスクリプトには完了行を追加しません。
  中断時も所要時間を残し、他の拡張のworkingメッセージは完了時に既定の文言に戻します。
- tok-rateの生成中表示は、ASCIIを0.25トークン、それ以外を1トークンとして差分から推定した概算です。
  `message_end`の確定値はプロバイダーが返す`usage.output`を使い、返さない場合は推定値のままです。
  `usage.output`は推論トークンを含むため、`thinking_delta`を流さないプロバイダーでは
  `usage.reasoning`を差し引いて、実際に時計が測った可視部分だけを数えます。
- tok-rateが測るのは「最初の差分→`message_end`」が400ms以上あり、受信時刻が8個以上ある応答だけです。
  同じミリ秒に届いた差分は1個と数えるので、1〜数回のフラッシュでまとめて届いた応答は測りません。
  測れない応答は`-- tok/s`と表示し、`avg`にも加算しません。
  ゲートウェイのバッファリングで同じ生成でも値が大きく変わるのを避けるためです。
- tok-rateの`avg`は、測定できた成功assistantメッセージの`usage.output`合計÷生成時間合計です。
  ツールの実行・待機とTTFTは含みません。測定できる応答が1件もない場合は表示しません。
  `usage.output`がない応答は表示だけ推定し、avgには加算しません。失敗・中断した応答も除外します。
- UIのないprint/jsonモードでは表示を変更しません。RPCでは従来どおりstatus/dialogを利用しますが、
  カスタムフッターとworkingメッセージの端末表示はありません。
- live-thinkingは観測専用で、セッションを止めません。sidecarの書き込みに失敗しても（ディスク不足、
  権限、ディレクトリの消失など）エラーを握りつぶし、そのまま実行を続けます。
- 自動リトライのbackoffには拡張イベントがないため、その待ち時間は`waiting`として見えます。
  並列ツールは1つの`tool`にまとめ、直近に開始したツール名と実行数だけを出すので、個々のツールの
  進捗は分かりません。
- `tool-call`は引数の生成中だけ続く短命なphaseです。約1秒間隔で読む側では取りこぼすことがあります。
- `thinking`はプロバイダーがreasoningを流したときだけ現れます。reasoningを流さないモデルでは
  `waiting` → `tool-call` → `writing`のように進み、`text`は付きません。
- 強制終了などで残ったsidecarは、次回の`session_start`で自セッション分だけ削除します。
  `--no-session`ではセッションファイルがないため、sidecarを作りません。
  残骸の掃除は自セッションのパスに限られ、他のセッションのsidecarには触れません。
- live-thinkingの`tokPerSecond`は、TUIのtok-rateと同じsamplerで測った現在のassistant応答の
  推定速度です。文字数推定（ASCII 0.25、それ以外1トークン）に、先行する`usage.output`とのmaxと、
  reasoningをストリームしていない場合の減算を適用します。最初の差分から400ms以上かつ受信時刻が
  8個以上あるときだけ入り、短い・まとめて届いた応答では省略します（`--`や0は入れません）。
  既存の500ms flushに乗せ、最後の差分時点の値に更新するので、flush時刻で分母は伸びません。
  `message_end`で消し、`assistantMessageStart` / `agentStart` / `turnStart`でリセットします。
  `waiting` / `tool` / `compacting` / `waiting-user`では出しません。
  履歴・確定値・avgは持たず、値は100000を上限にします。
- 設定の更新キューは、同じPiプロセス内で更新を直列化するものです。
  他のプロセスや手作業での編集による同時更新を、ファイルロックで排他制御するものではありません。
- エントリーポイントやimportのエラーは全機能のロードに影響します。
  機能別のテストに加え、エントリーポイントのロードも検証します。
