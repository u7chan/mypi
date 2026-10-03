# pi-lab からの移行記録

移植元: [u7chan/pi-lab](https://github.com/u7chan/pi-lab)、main `0bb84a0`（PR #20 マージ後）。
移行先: [u7chan/mypi](https://github.com/u7chan/mypi)。
対象は確定方針の６機能だけです。skill-dispatch と他の PoC は含みません。
pi-lab の元コード・配布 manifest は変更していません。

公開ライセンスはユーザー指定の [MIT License](../LICENSE) です。
著作権表記は `Copyright (c) 2026 u7chan` とし、`package.json` にも `MIT` を記載しています。

## 対応

| pi-lab | mypi |
|---|---|
| `u7chan-lab-cache-ttl` | `src/cache-ttl/`、`tests/cache-ttl.test.ts` |
| `u7chan-lab-cache-savings` | `src/cache-savings/`、`tests/cache-savings.test.ts` |
| `u7chan-lab-minimal-footer` | `src/minimal-footer/`、`tests/minimal-footer.test.ts` |
| `u7chan-lab-default-model` | `src/default-model/`、`tests/default-model.test.ts` |
| `u7chan-lab-git-status` | `src/git-status/`、`tests/git-status.test.ts` |
| `u7chan-lab-elapsed` | `src/elapsed/`、`tests/elapsed.test.ts` |

adapter の相対 import とテスト参照を変更し、１入口から各登録関数を１回ずつ呼びます。
機能ごとの closure/controller、status key、コマンド・ツール、lifecycle は維持しました。
elapsed の確定は `agent_end` ではなく `agent_settled` のままです。

### 移植時の補修

- default-model: 欠損ファイル以外の read error・不正 JSON・非 object を空設定と扱わず、
  原本を上書きしない。固有の一時ファイル、失敗時 cleanup、既存の権限保持を追加。
  mutation queue は read-modify-write 全体を囲み、ツール結果には Pi 1.0.0 必須の `details` を追加。
- minimal-footer: コマンド側も TUI/hasUI を guard。
  全角 session 名で40列指定に70列の行が出る旧実装の問題を実測したため、実 TUI は host の
  `visibleWidth` / `truncateToWidth` を利用するよう修正。OSC 8 の閉じも host で維持する。
  core 単体・host なしテストには従来の ASCII/ANSI/OSC 用 fallback を残す。

## 確認結果

環境: WSL / Linux、Node.js 24.18.0、Bun 1.3.14、Pi 1.0.0。

- `bun test`: 移植した６機能のテスト、追加回帰・単一入口テストの129件が成功（失敗0件）。
- `node scripts/smoke-pi.mjs`: **実際の DefaultResourceLoader がパッケージから１入口をロード**。
  コマンド３件、ツール１件、複数 handler の共存を確認。
  ローカル mock provider と実際の AgentSession の retry loop（約4.4秒）で、最初の
  `agent_end` 後も elapsed が継続し、settle 時に４秒で確定した。
  payload による TTL countdown、cache savings、git/PR fixture、footer toggle、model 切り替え、
  settings 保存、shutdown の status/timer cleanup を確認。
  host の列幅関数で0〜160列・全角/emoji/結合文字の session 名を検証。
- `scripts/smoke-tui.mjs`: 実際の CLI の **regular / fullscreen 対話 TUI** を PTY で起動。
  Extensions 欄は mypi の１項目。ローカル HTTP mock で working の秒更新、
  `SAVED … CACHE hit ELAPSED …`、次の指示での elapsed クリアを確認。
  regular では `/minimal-footer` 往復、`/dm` picker とキャンセル、既定モデル変更と
  `set_default_model` の model 発行 tool call を確認（保存先は一時 agent directory）。
  fullscreen では git/PR fixture の OSC 8 リンクと他 status の共存、長い全角 session 名の
  切り詰めを確認。両モードとも `/quit` で終了コード0。

SDK は UI sink を注入した検証、対話 TUI は実 CLI の描画検証です。
これらは provider の本番サービスや GitHub の PR を使った検証ではありません。

## 残る確認・別途判断

- 実 provider の payload/料金による推定の妥当性、実 GitHub PR の取得、端末側のリンククリック。
- 常用環境の外部拡張との組み合わせ、実ユーザーの設定を用いた切り替え。
- 初回コミット・push 後の `pi install git:github.com/u7chan/mypi@main` と更新。

常用環境にはインストールしていません。pi-lab の配布停止、常用設定の変更は
ユーザーの別途指示を待ちます。
