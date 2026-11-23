# mypi

自分の常用環境の安定性と管理のしやすさを優先した、TypeScript製のPi拡張セットです。
[pi-lab](https://github.com/u7chan/pi-lab)で登録済みの6機能と、実行中の状態を外部へ書き出すlive-thinkingを移植し、
生成速度の表示を追加しています。
公開Gitリポジトリで配布し、npmには公開しません。

1つのPiパッケージとして配布し、拡張のエントリーポイントも1つ（`extensions/index.ts`）にまとめています。
通常の起動では9機能を登録し、Herdrのペイン（`HERDR_PANE_ID`がある起動）ではhwc連携の`hwc-rewind`を加えた10機能を登録します。
Extensions欄にはmypi由来の項目を1つだけ表示します。
機能別のON/OFF設定や設定UIはありません。他の外部拡張の表示は変更しません。
既存の`/minimal-footer`などの操作は残しています。

## 機能

| 機能 | 動作 |
|---|---|
| cache-ttl | 送信ペイロードのキャッシュメタデータから推定した残り時間を`ttl 4:31`のように表示します。TTLがない場合は状態を`cache auto` / `cache off` / `cache hit` / `cache expired`で示し、情報のない`pending`と`unknown`は表示しません |
| cache-reuse | アシスタントの最新の応答でキャッシュから読まれたトークン数を`cached 1.5k`と表示します。金額の推定はしません。ヒットしなかった応答やモデル・セッションの切り替え時には表示を消します |
| minimal-footer | トークン数・コストの統計ブロックを除いた2行のフッター（他の拡張のステータスが2行目に収まらないときだけ3行）に、cwd・ブランチ・セッション名、コンテキスト使用率、モデル・thinking（`zai glm-5.3-flash max`）、各ステータスを表示します。`/minimal-footer`でPi標準のフッターと切り替えます |
| default-model | `/dm`（別名`/default-model`）と`set_default_model`ツールで起動時の既定モデル・thinkingを保存します |
| ask-user | `ask_user`ツールでユーザーに1問だけ質問し、TUIのダイアログかhwc（Web）の回答を待ちます。質問は500コードポイント、選択肢は2〜6個（各120コードポイント、推奨を1つ指定）、自由入力の回答は2000コードポイントまでです。Herdrの永続TUI（`mode`が`tui`で`HERDR_ENV=1`・`HERDR_SOCKET_PATH`・`HERDR_PANE_ID`とセッションファイルが揃う場合）だけ、セッションの隣に`<session>.ask.json`を書いて待ちの間`herdr:blocked`を報告します。それ以外はダイアログだけを使い、print / JSONではエラーを返します |
| git-status | origin（なければupstreamまたは最初のリモート）のリポジトリと、現在のブランチのPRをフッターにOSC 8リンクとして表示します |
| elapsed | `before_agent_start`から`agent_settled`までの経過時間を`Working (12m 3s)`にリアルタイムで表示し、確定値を`elapsed 12m 3s`としてフッターに残します |
| tok-rate | 生成中は最新の assistant 応答の速度を`4.6 tok/s`（差分からの推定）で表示し、指示が落ち着いたら測定できた成功メッセージの合計`usage.output`÷合計生成時間を`avg 92 tok/s`で表示します。短すぎる、またはまとめて届いた応答は生成時間を測れないため`-- tok/s`と表示します |
| live-thinking | 実行中のphase・thinkingの末尾・生成中の速度を、セッションの隣の`<session>.jsonl.thinking.json`に書き出します。hwc（Herdr Web Client）などの外部クライアントが、piのプロセスにアタッチせず、TUIも読まずに実行中の状態を表示できます。phaseは`waiting` / `thinking` / `writing` / `tool-call` / `tool` / `compacting` / `waiting-user`の7段階で、1行JSONを上書きのみします。`tokPerSecond`はtok-rateと同じsamplerで測った現在のassistant応答の推定速度（tok/s、丸めなし）で、`thinking` / `writing` / `tool-call`のときだけ入り、`message_end`で消えます。thinkingは末尾1200文字だけを500ms間隔でまとめ、phaseの変化は即時に書きます。tmpとrenameで置き換えて権限0600にし、`agent_settled`と`session_shutdown`で削除、セッションファイルのない起動では何もしません。TUI・トランスクリプト・フッターは変更しません |
| hwc-rewind | Herdrのペイン（`HERDR_PANE_ID`がある起動）だけで有効になるhwc（Herdr Web Client）連携です。`session_start`で`hwc-capabilities`を1回だけ追記し、hwcが過去の発言を編集できるペインだと分かるようにします。`/hwc-rewind <entryId> <requestId>`は対象のuser発言の親まで葉を移し（要約なし）、入力欄を空にして`hwc-rewind` markerを追記します。同じ`requestId`の再送は何もせず成功し、marker追記だけ失敗した再送は移動せずmarkerだけを追記します。ファイル変更の復元と分岐の要約はしません。通常のpi起動ではコマンドもcapabilityも登録しません |

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

### `ask_user`とWeb回答

`ask_user`はモデルがユーザーに1問だけ質問して回答を待つツールです。`options`を渡すときは
`recommended`に選択肢の1つを指定し、TUIではそれを先頭に`推奨💡`付きで表示します。
`options`があっても最下部の`その他（自由入力）`から自由入力できます。`options`がなければ
最初から自由入力です。回答はツール結果に`ユーザーの回答: ...`として返り、
bash / editの実行許可にはなりません。
1セッションで同時に待てるのは1問だけです。2問目はファイルにもダイアログにも触れずにエラーを返します。
TUIの自由入力は、選択肢を選んだあとに`input`ダイアログを開く2段階です。入力側でEscを押すと
質問全体が未回答になります。

Herdrの永続TUI（`ctx.mode`が`tui`、`HERDR_ENV=1`、空でない`HERDR_SOCKET_PATH`、`HERDR_PANE_ID`、
セッションファイルがすべて揃う場合）では、hwc（Herdr Web Client）とセッションの隣のファイルでやり取りします。
`--no-session`、Herdrの外、RPCではファイル契約と`herdr:blocked`を使わず、ダイアログだけを使います。
print / JSONにはダイアログがないため、`ask_user`はエラーを返します。

- pending（mypiが書く）: `<session path>.ask.json`

  ```json
  { "v": 1, "id": "<uuid>", "question": "...", "options": ["..."], "recommended": "...", "freeText": true }
  ```

  `options`は自由入力のとき`null`です。`recommended`は`options`の1つで、表示だけに使います。
  `freeText`は選択肢があってもtext回答を受け付けるかの可否です。

- answer（hwcが書く）: `<session path>.ask.answer.json`

  ```json
  { "v": 1, "id": "<uuid>", "answer": { "kind": "option", "label": "..." } }
  ```

  自由入力のときは`answer`を`{ "kind": "text", "text": "..." }`にします。`freeText`がtrueなら、
  選択肢がある質問でもtext回答を使えます。

どちらも1行JSONで末尾に改行を1つ付け、tmpとrenameで置き換えて権限を0600にします。
読み取りはJSONをparseする前にサイズを見ます（pending 8KB、answer 16KB）。
`v`、UUIDの`id`、質問・選択肢・回答の形と制限を検証し、壊れたファイルや未知の`v`は無いものとして扱います。

pendingの`id`とツール呼び出しは1対1です。待機中に`id`の一致しないanswerが現れても、
消さずに無視します。readしてからdeleteする間に次の質問の正しいanswerがrenameで置き換わり、
それを消してしまうためです。残骸は次の質問の開始前と後始末で消します。

mypiは300ms間隔でanswerを読み、有効な回答が先に来たらダイアログを閉じてその回答を返します。
TUIが先ならファイルを消してTUIの回答を返します。タイムアウトはありません。
待機中は`herdr:blocked`の`active`を1回送り、後始末で`inactive`を1回だけ返します。
pendingを書けなかった場合はどちらも送りません（Herdrの`blockedCount`をずらさないため）。
後始末の順序は「勝者確定・監視停止 → pending削除 → answer削除 → inactive」です。
hwcは推奨を先頭のカードにし、`freeText`がtrueなら`その他（自由入力）`を出します。
`recommended`と`freeText`が無い古いpendingは、`recommended: null` / `freeText: false`
（`options`が`null`ならtrue）として読むため、古いhwcとmypiの組み合わせでも質問カードは壊れません。

## 必要な環境

- 検証環境はWSL / Linux、Node.js 24.18.0、Bun 1.3.14、Pi 1.5.2です。
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
`ask-user-option`で`推奨💡`付きの選択肢と`その他（自由入力）`の2段階ダイアログ
（回答と、再度送ってEscでの未回答の両方）、`ask-user-text`で自由入力ダイアログを確認して、
`/quit`で終了します。
ANSIログを残す場合は`PI_SMOKE_TUI_LOG=/tmp/mypi-tui.log`を指定します。

手元のモデルで一時的にロードする場合は、次のコマンドを使います。インストールや配布の切り替えは行いません。

```sh
pi --no-extensions --no-session --verbose -e "$PWD"
```

この通常起動ではユーザーのPi設定を読みます。保存操作を試す場合は、上記の隔離スクリプトを使うか、
`PI_CODING_AGENT_DIR`に一時ディレクトリを指定してください。
拡張ファイル1個だけをシンボリックリンクで読み込むのではなく、リポジトリ全体をロードします。

### 構成

```text
extensions/index.ts       # 唯一のエントリーポイント。10個の登録関数を呼ぶだけ（hwc-rewindはHerdrのペインだけ）
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
- hwc-rewindはHerdrのペイン（`HERDR_PANE_ID`）だけで登録します。通常のpi起動ではコマンド・capabilityとも
  存在せず、セッションにも何も追記しません。capabilityは`session_start`時の記録なので、起動中にmypiを
  外してもhwc側の検出は変わりません。mypiの配備がhwcより先に必要です。
- hwc-rewindのmarkerは`v: 1`、`requestId`、`targetId`、`leafId`を持ちます。`leafId`は移動後の葉、
  つまり対象の親でmarker自身ではありません。Pi 1.5.2では先頭のuser発言の前にもsystem messageの
  エントリがあるため、通常は`null`ではなくその親のIDになります（親が無い場合だけ`null`）。
  markerは移動後の葉の子として追記されます。
  markerとcapabilityは`/tree`に`[custom: hwc-rewind]` / `[custom: hwc-capabilities]`として見え、
  チャットとLLMの文脈には入りません。`v`を上げるときはhwcと同時に更新します。
- hwc-rewindが葉を移せるのは、対象がactive branch上のuser発言で、現在の葉ではないときだけです。
  最後の1通は葉になるため編集できません。実行中・圧縮中の`navigateTree`は拒否され、markerが
  書かれないためhwcはタイムアウトします。mypiは再試行しません。
  marker追記に失敗した場合はpiのメモリ上だけ葉が移り、同じ`requestId`の再送で対象の親が現在の葉と
  一致すればmarkerだけを追記して復旧しますが、追記が続けて失敗する場合はhwcから完了できません。
- hwc-rewindは入力欄を空にします。TUIに書きかけの下書きがある場合はその下書きを消します。
  また、入力欄に行頭`/`以外の書きかけがあるとhwcの`pane.send_input`ではコマンドが発火せず、
  markerも書かれません。mypiからは検知できません。
- ask-userのWeb回答は`<session>.ask.answer.json`に置かれ、次の監視（300ms）で読まれます。
  hwcが推奨の表示と自由入力を行うため、`recommended`と`freeText`はmypiとhwcで同じ意味に保ちます。
- ask-userのファイル契約と`herdr:blocked`は、Herdrの永続TUIでセッションファイルがあるときだけ使います。
  `--no-session`、Herdrの外、RPCではTUI / RPCのダイアログだけ、print / JSONではエラーになります。
- TUIで答えた直後（監視の300ms以内）にWebが回答すると、TUIの回答を採り、answerファイルは
  後始末で消えます。回答した側には「送ったのに反映されない」ように見えますが、二重回答の調停はしません。
  後から届いたanswerは残骸として次の質問の開始前に消えます。
- piのプロセスが強制終了するとpendingが残ります。Herdrの状態は`blocked`でなくなるのでhwcには出ず、
  次の質問の開始前に残骸を消します。pendingのタイムアウト・再送・複数クライアントの調停はしません。
- ask-userの制限値（500 / 120 / 2000コードポイント、2〜6個、8KB / 16KB）はmypiとhwcの両方に書きます。
  片方だけ変えると、有効なファイルが無視されます。質問文・選択肢・回答はログやHerdrの状態メッセージへ
  出しませんが、TUIのタイトル・hwcのカード・セッションのツールコールには現れます。
- 設定の更新キューは、同じPiプロセス内で更新を直列化するものです。
  他のプロセスや手作業での編集による同時更新を、ファイルロックで排他制御するものではありません。
- エントリーポイントやimportのエラーは全機能のロードに影響します。
  機能別のテストに加え、エントリーポイントのロードも検証します。
