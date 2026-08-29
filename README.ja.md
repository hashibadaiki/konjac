# Konjac（コンニャク）

[English](README.md) | 日本語

**⌘C を 2 回**押すだけで開く、ミニ翻訳アプリ。macOS 用。Tauri 2 製。
Windows 版も配布しているが、いまは[動かない見込み](#ダウンロード)。

```
[⌘C] [⌘C] → ウィンドウ表示 → コピーしたテキストを翻訳 → [Esc] で消える
```

短い通常文は **Google Cloud Translation NMT** へ直接送り、文体指定・コードや URL を含む文書・
Google の失敗時は **手元の `claude` CLI（Claude Code）**へ自動で切り替える。Google を設定
しなければ、これまでどおり Claude のサブスクだけでも使える。

## デモ

https://github.com/user-attachments/assets/504b6f4c-8680-48ef-8cd6-233493fa400b

## ダウンロード

**→ [最新版はこちら](../../releases/latest)**

| OS | 落とすファイル | 動作確認 |
|---|---|---|
| **macOS 13（Ventura）以降** | **`Konjac_x.y.z_universal.dmg`**（Intel / Apple Silicon 共通） | ✅ 実機で確認しているのはこちら |
| Windows 10 以降 | `Konjac_x.y.z_x64-setup.exe` | ❌ **未検証。おそらく動かない** |

**開発と動作確認は macOS でやっている。** Windows 版はタグを打つたびにビルドして配布して
いるが、実機で一度も起動していない。

そのうえでコードを読み直したところ、**いまの Windows 版はまともに動かない公算が高い**。

- 下の[インストール](docs/install.md)が案内している npm 版の Claude Code を使っていると、
  翻訳の実行時に必ず失敗する（[#27](../../issues/27)）
- ⌘C 2 回の検出そのものが Windows では一度も発火しない疑いがある（[#28](../../issues/28)）
- そもそも Windows にはキーボード監視が無いので、⌘C 2 回で反応しても**既定では入力欄に
  入るところまで**で、翻訳は `Ctrl+Enter` で実行することになる

直るまでは macOS の `.dmg` を使ってほしい。

> **必要なもの**: Google Cloud Translation API キー、またはログイン済みの
> [Claude Code](https://docs.claude.com/en/docs/claude-code/setup)。両方あれば Google を高速経路、
> Claude Code をフォールバックとして使う（Google 単独では短い通常文のみ）。
>
> **⌘C 2 回は既定でオフ。** 有効にすると、検出した瞬間にクリップボードの本文を読んで
> 選択中の外部翻訳サービスへ送ることになるので、何が送られるかを提示したうえで同意を取ってから
> 有効になる（→ [プライバシー](docs/privacy.md)）。

## できること

- **⌘C 2 回で起動して翻訳** — コピーした文字がそのまま入力欄に入る（既定オフ）。
  アクセシビリティを許可すれば **⌘ を押しっぱなしのまま C を 2 回**でも反応する
- **トレイ（macOS はメニューバー）常駐** — ウィンドウを閉じても残る。開き直すのと終了はここから
- 言語 16 種＋入れ替え、文体 4 種、モデル切り替え（`opus` / `sonnet` / `haiku` / `fable`）
- **Google NMT の高速経路**＋失敗時の Claude Code 自動フォールバック
- **ストリーミング表示**・結果のその場編集・自動コピー
- **更新の通知と、いざというときの停止**（[自動更新はしない](docs/updates.md)）

## 使い方

| 操作 | 動作 |
|---|---|
| `⌘/Ctrl + C` を 2 回 | ウィンドウを出してコピーした内容を入力欄に入れる。キーボード監視ならそのまま翻訳する（既定オフ） |
| トレイアイコン → コンニャクを開く | ウィンドウを出す（クリップボードには触らない） |
| `⌘/Ctrl + Enter` | 翻訳実行 |
| `Esc` | 設定を閉じる / ウィンドウを隠す |
| タイトルバーの `−` / `✕` | 最小化 / 隠す（トレイから戻す） |

設定は歯車ボタンから。保存ボタンは無く、触った時点でその場で保存される。
→ [使い方の細かいところ](docs/usage.md)

## ドキュメント

| | |
|---|---|
| [プライバシー](docs/privacy.md) | 何を・いつ送るか。既定でクリップボードを読まない理由 |
| [インストール](docs/install.md) | Google / Claude Code の準備、初回起動の警告、⌘C 2 回とアクセシビリティの有効化、対応 OS |
| [使い方](docs/usage.md) | 前面表示、モデルの選び方、設定の保存先 |
| [仕組み](docs/how-it-works.md) | Google→Claude の経路、ストリーミング、入力長の限界、⌘C ⌘C の検出方式 |
| [更新の通知とキルスイッチ](docs/updates.md) | 自動更新を入れていない理由と、代わりに入っているもの |
| [詰まりやすいところ](docs/troubleshooting.md) | `claude` が見つからない、⌘C 2 回が反応しない、など |
| [開発](docs/development.md) | ビルド、テスト、CI、ディレクトリ構成 |
| [リリース](docs/release.md) | タグの切り方、署名と公証、配布物の検証 |

## ライセンス

**MIT または Apache License 2.0** のデュアルライセンス
（[LICENSE-MIT](LICENSE-MIT) / [LICENSE-APACHE](LICENSE-APACHE)）。
ただし「Konjac」「コンニャク」の名前とアイコンは対象外 → [ライセンス](docs/license.md)
