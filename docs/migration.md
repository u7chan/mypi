# pi-labからの移行記録

移植元は[u7chan/pi-lab](https://github.com/u7chan/pi-lab)のmain `0bb84a0`（PR #20マージ後）です。
移行先は[u7chan/mypi](https://github.com/u7chan/mypi)です。
対象は確定した方針にある6機能だけです。skill-dispatchと他のPoCは含みません。
pi-labの元のコードと配布マニフェストは変更していません。

公開ライセンスはユーザー指定の[MIT License](../LICENSE)です。
著作権表記は`Copyright (c) 2026 u7chan`とし、`package.json`にも`MIT`を記載しています。

## 機能とファイルの対応

| pi-lab | mypi |
|---|---|
| `u7chan-lab-cache-ttl` | `src/cache-ttl/`、`tests/cache-ttl.test.ts` |
| `u7chan-lab-cache-savings` | `src/cache-savings/`、`tests/cache-savings.test.ts` |
| `u7chan-lab-minimal-footer` | `src/minimal-footer/`、`tests/minimal-footer.test.ts` |
| `u7chan-lab-default-model` | `src/default-model/`、`tests/default-model.test.ts` |
| `u7chan-lab-git-status` | `src/git-status/`、`tests/git-status.test.ts` |
| `u7chan-lab-elapsed` | `src/elapsed/`、`tests/elapsed.test.ts` |

アダプターの相対importとテストの参照先を変更し、1つのエントリーポイントから各登録関数を1回ずつ呼びます。
機能ごとのクロージャー・コントローラー、ステータスキー、コマンド・ツール、ライフサイクルは維持しました。
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

## 確認結果

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

## 未確認事項・別途判断

- 実際のプロバイダーのペイロード・料金に基づく推定の妥当性、実際のGitHub PRの取得、端末でのリンクのクリック。
- 常用環境の外部拡張との組み合わせ、実際のユーザー設定を使った切り替え。
- 初回コミット・push後の`pi install git:github.com/u7chan/mypi@main`によるインストールと更新。

常用環境にはインストールしていません。pi-labの配布停止や常用設定の変更は、ユーザーからの別途指示を待ちます。
