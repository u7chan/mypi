# pi-labからの移行記録

移植元は[u7chan/pi-lab](https://github.com/u7chan/pi-lab)のmain `0bb84a0`（PR #20マージ後）です。
移行先は[u7chan/mypi](https://github.com/u7chan/mypi)です。
対象は確定した方針にある6機能だけです。skill-dispatchと他のPoCは含みません。
後に、実行中のphaseとthinkingの末尾を外部へ書き出すlive-thinkingを追加しています（[live-thinkingの追加移植](#live-thinkingの追加移植)）。
pi-labの元のコードと配布マニフェストは変更していません。

公開ライセンスはユーザー指定の[MIT License](../LICENSE)です。
著作権表記は`Copyright (c) 2026 u7chan`とし、`package.json`にも`MIT`を記載しています。

## 機能とファイルの対応

| pi-lab | mypi |
|---|---|
| `u7chan-lab-cache-ttl` | `src/cache-ttl/`、`tests/cache-ttl.test.ts` |
| `u7chan-lab-cache-savings` | `src/cache-reuse/`、`tests/cache-reuse.test.ts`（金額推定を削除） |
| `u7chan-lab-minimal-footer` | `src/minimal-footer/`、`tests/minimal-footer.test.ts` |
| `u7chan-lab-default-model` | `src/default-model/`、`tests/default-model.test.ts` |
| `u7chan-lab-git-status` | `src/git-status/`、`tests/git-status.test.ts` |
| `u7chan-lab-elapsed` | `src/elapsed/`、`tests/elapsed.test.ts` |
| `u7chan-lab-live-thinking` | `src/live-thinking/`、`tests/live-thinking.test.ts` |
| （新規） | `src/tok-rate/`、`tests/tok-rate.test.ts` |

アダプターの相対importとテストの参照先を変更し、1つのエントリーポイントから各登録関数を1回ずつ呼びます。
機能ごとのクロージャー・コントローラー、コマンド・ツール、ライフサイクルは維持しました。
ステータスキーは`cache-reuse`（旧`cache-savings`）だけ変更しています。
elapsedの確定タイミングは`agent_end`ではなく、従来どおり`agent_settled`です。

### 移植時の修正

- default-model: ファイルの欠損以外の読み取りエラー、不正なJSON、オブジェクト以外の値は空の設定として扱わず、
  元のファイルを上書きしないようにしました。一時ファイルを固有の名前で作成し、
  失敗時の後処理と既存のファイル権限の保持を追加しました。
  設定の読み取り・変更・書き込みをすべて更新キュー内で行い、ツール結果にはPi 1.0.0で必須の`details`を追加しました。
- minimal-footer: コマンド側にもTUIと`hasUI`のガードを追加しました。
  旧実装では全角のセッション名を使うと、40列の指定に対して70列の行が表示されることを実測で確認しました。
  そのため、実際のTUIではホストの`visibleWidth` / `truncateToWidth`を使うように修正しました。
  OSC 8リンクを閉じる処理もホスト側で維持しました。
  コア単体のテストやホストなしのテストには、従来のASCII/ANSI/OSC用フォールバックを残しました。

## mypiで追加した機能

- tok-rate: Pi本体にもpi-labにも生成速度の表示がないため、mypiで追加しました。
  生成中はストリームの差分から推定した速度を表示し、`message_end`では
  プロバイダーが返す`usage.output`と最初の差分からの経過時間で確定します。
  ただし差分の受信時刻は生成時間そのものではないため、400ms未満または受信時刻が8個未満の
  応答は測定不能として`-- tok/s`にし、`avg`からも除外します。
- フッターのラベル体系: 大文字の`SAVED` / `CACHE` / `ELAPSED` / `TOK/S`をやめ、
  小文字のラベル（dim）と値（通常色）に揃えました。` · `区切りで並べ、
  `elapsed` / `tok` / `cache-ttl` / `cache-reuse`の順、`git`は最後です。
- cache-reuse: サブスクリプション運用では金額の意味がないため、`usage.cost`とカタログ単価に
  基づく節約額の推定を削除し、`cached 1.5k`のようにトークン数だけを表示します。
- cache-ttl: カウントダウンを`ttl 4:31`にし、状態語を`cache auto` / `cache off` / `cache hit` /
  `cache expired`に整理しました。情報のない`pending` / `unknown`は表示しません。

## 移行時点の確認結果

環境はWSL / Linux、Node.js 24.18.0、Bun 1.3.14、Pi 1.0.0です。

- `bun test`: 移植した6機能のテスト、追加の回帰テスト、単一エントリーポイントのテストの計129件が成功しました。失敗は0件です。
- `node scripts/smoke-pi.mjs`: 実際のDefaultResourceLoaderでパッケージから1つのエントリーポイントをロードしました。
  コマンド3件、ツール1件、複数ハンドラーの共存を確認しました。
  ローカルのモックプロバイダーと実際のAgentSessionの再試行ループ（約4.4秒）で、最初の
  `agent_end`後もelapsedが継続し、settle時に4秒で確定することを確認しました。
  ペイロードによるTTLカウントダウン、キャッシュ節約額、git/PRのフィクスチャ、フッターの切り替え、モデルの切り替え、
  設定の保存、終了時のステータスとタイマーの後処理を確認しました。
  ホストの列幅関数を使い、0〜160列の表示幅と、全角・絵文字・結合文字のセッション名を検証しました。
- `scripts/smoke-tui.mjs`: 実際のCLIのregular / fullscreen対話TUIをPTYで起動しました。
  Extensions欄はmypiの1項目でした。ローカルHTTPモックでworkingメッセージが毎秒更新されること、
  `SAVED … CACHE hit ELAPSED …`の表示、次の指示でelapsedが消えることを確認しました。
  regularでは`/minimal-footer`の切り替え、`/dm`の選択画面とキャンセル、既定モデルの変更、
  モデルによる`set_default_model`のツール呼び出しを確認しました。保存先は一時エージェントディレクトリです。
  fullscreenではgit/PRのフィクスチャによるOSC 8リンクと他のステータスの共存、長い全角のセッション名の
  切り詰めを確認しました。両モードとも`/quit`で終了し、終了コードは0でした。

SDKではUI sinkを注入して検証し、対話TUIでは実際のCLIの描画を検証しました。
これらはプロバイダーの本番サービスやGitHubのPRを使った検証ではありません。

## フッター変更後の確認結果

環境はWSL / Linux、Node.js 24.18.0、Bun 1.3.14、Pi 1.4.0です。

- `bun test`: 7機能と単一エントリーポイントの計141件が成功しました。失敗は0件です。
- `node scripts/smoke-pi.mjs`: Pi 1.4.0のSDKで1エントリーポイント、7機能、再試行ループ、
  `elapsed` / `tok/s` / `ttl` / `cached`のステータス、終了時の後処理を確認しました。
- `scripts/smoke-tui.mjs`: regular TUIをPTYで起動し、
  `elapsed 2s · avg 4.6 tok/s · cache hit · cached 1k · u7chan/mypi PR #3`の並びと区切り、
  停止後に`avg`へ切り替わることを実測しました。
  `/minimal-footer`、`/dm`、`/quit`の動作と終了コード0も確認しました。
- 金額推定の削除と`cache-savings`から`cache-reuse`へのキー変更はテストで確認しています。

これらもローカルHTTPモックとフィクスチャによる検証で、実プロバイダーや実PRを使ったものではありません。

## tok/s精度の修正（測定不能時は`--`）

実プロバイダー（opencode-go / deepseek-v4.1-flash、Pi 1.4.0）のストリームを拡張で記録して確認しました。

- `message_start`はレスポンスヘッダの受信後に発火するため、`message_start`→`message_end`は生成時間ではなく
  末尾の受信時間です（実測6〜8ms）。旧実装の「全体の時間」へのフォールバックもTTFTを含んでいませんでした。
- 短い応答（`usage.output`=11）は、差分3〜10個が35ms以内にまとまり、修正前は1100〜2750 tok/sと表示されました。
  修正後は測定不能として`-- tok/s`になります。
- 中程度の応答（142トークン、26差分、582ms、受信時刻11個）は244 tok/s、
  長い応答（658トークン、245差分、6556ms、受信時刻113個）は100 tok/sです。
  推論トークン（それぞれ22と386）は`thinking_delta`として流れていたため、差し引きません。
- `bun test`: 153件成功（`--`、バースト除外、推論トークンの差し引きを含む）。
- `node scripts/smoke-pi.mjs` と `scripts/smoke-tui.mjs`: 成功。

## live-thinkingの追加移植

移植元はpi-labのPR #23（`u7chan-lab-live-thinking`、ブランチ`feat/live-thinking`、コミット`ca5ef29`）です。
piのセッションJSONLは`message_end`でしかassistantメッセージを書かないため、実行中の状態はディスク上に存在しません。
TUIを読む方法は折り返し・再描画・`hideThinkingBlock`に依存するため採らず、拡張が受け取ったイベントを
セッションの隣のsidecarへ書き出す形にしています。

契約は変更していません。

- 置き場所は`<session>.jsonl.thinking.json`で、1行JSONの上書きのみです。履歴は持ちません。
- `v: 1` / `at` / `phase`の3つを常に持ち、phaseは`waiting` / `thinking` / `writing` / `tool-call` /
  `tool` / `compacting` / `waiting-user`の7段階です。
- `thinking`のときだけ末尾1200文字の`text`、`tool`のときだけ`tool`と`tools`を付けます。
- thinkingの差分は500msでまとめ、phaseの変化は即時に書きます。
- 一時ファイルとrenameで置き換え、権限は0600です。
- `agent_settled`と`session_shutdown`で削除し、`agent_end`では消しません。自動リトライのbackoffを
  `waiting`として見せるためです。`session_start`では自セッションの残骸だけを削除します。
- セッションファイルのない起動（`--no-session`）では何も書きません。
- 書き込みの失敗は握りつぶします。観測専用で、セッションを止めないためです。

mypi側の変更点は次の4つです。

- ファイルを`src/live-thinking/core.ts`と`src/live-thinking/extension.ts`に分け、
  extensionの相対importを`./core.ts`にしました。他機能と同じく、純粋な関数と型をre-exportします。
- `extensions/index.ts`へ`registerLiveThinking`を追加し、起動時の登録を8機能にしました。
- `tests/live-thinking.test.ts`は拡張とコアの参照先だけを`src/live-thinking/`へ変え、テスト内容は維持しました。
- `tests/entry.test.ts`と`scripts/smoke-pi.mjs`のハンドラー件数を実測値へ更新しました。
  `session_start` 4→5、`message_start` 1→2、`message_end` 3→4、`message_update` 1→2、`agent_settled` 3→4です。
  `agent_end`はlive-thinkingだけが使うようになったため、「`agent_end`を登録していない」という
  従来のアサーションを「live-thinkingの1本だけ」に置き換えました。elapsedが`agent_settled`で
  終わる契約は変えていません。

確認結果です。環境はWSL / Linux、Node.js 26.12.1、Bun 1.3.14、Pi 1.5.0です。

- `bun test`: 174件成功（9ファイル、572アサーション）しました。失敗は0件です。
- `node scripts/smoke-pi.mjs`: 成功しました。1エントリーポイント、8機能で、出力は
  `Pi 1.5.0: one entry, eight features, retry 4921ms, isolated settings, cleanup OK`です。
- 実ペイン（Herdr）での隔離観測: `--session-dir`に一時ディレクトリを指定し、作業ツリーのmypiを
  `--no-extensions -e "$PWD"`で読み、`opencode-go/deepseek-v4-pro` / thinking `high`で非対話実行しながら
  20ms間隔でsidecarを観測しました。
  `waiting` → `thinking`（`text`あり、500ms間隔で末尾だけ更新） → `tool`（`bash`、1） → `waiting` →
  `writing` → 消失（`agent_settled`）の順に遷移し、`sleep 1`の実行中だけ`tool`が続きました。
  別の実行で、sidecarの権限が`600`であること、終了後に`.thinking.json`と`.tmp`が残らないこと、
  `--no-session`ではsidecarが1つも作られないことを確認しました。
  20ms間隔では`tool-call`（引数の生成中だけ続く短命なphase）は取り切れておらず、phaseの網羅は
  ユニットテスト側で確認しています。`hideThinkingBlock`は変更せず、`pi update`も実行していません。
- `git diff --check`: 指摘はありません。
- PR #9（`feat/live-thinking`、base `main`）のレビューRound 1はBlocker 0でLGTMでした。

未確認は、対話TUIでの長時間ストリーミングと、hwcからの実際の表示です。

## 未確認事項・別途判断

- 実際のプロバイダーのusageに基づくtok/sとTTLの妥当性、実際のGitHub PRの取得、端末でのリンクのクリック。
- 常用環境の外部拡張との組み合わせ、実際のユーザー設定を使った切り替え。
- 初回コミット・push後の`pi install git:github.com/u7chan/mypi@main`によるインストールと更新。

常用環境にはインストールしていません。pi-labの配布停止や常用設定の変更は、ユーザーからの別途指示を待ちます。
