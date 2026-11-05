# 開発

前提: Node.js 18+ / Rust 1.77+ / [Tauri の OS 別依存](https://tauri.app/start/prerequisites/)。
ビルドする側の OS も [対応 OS](install.md#対応-os) と同じ下限。
llama.cpp を C++ からビルドするので **CMake と C/C++ コンパイラ**も要る（macOS は Xcode
Command Line Tools で揃う）。初回の `cargo build` は llama.cpp のぶん数分余計にかかる。

```bash
npm install
npm run tauri dev      # 開発起動
npm run tauri build    # 配布用ビルド
```

依存は薄い。フロントは素の TypeScript + Vite、フレームワークなし。推論は
`llama-cpp-2`（llama.cpp の Rust バインディング）で、バージョンは `=0.1.161` に固定している。
同梱の llama.cpp が `plamo3` アーキテクチャを知っていることが前提なので、上げるときは
実モデルで下のテストを通すこと。既定 feature は切ってある（OpenMP を macOS に同梱したくない
ため）。macOS では `metal` を有効にする。

## 開発ビルドとインストール済みアプリの同居

同じ Mac に入れたまま開発できる。**設定と一度きりのマーカーの置き場所が別**で、
デバッグビルドは `~/Library/Application Support/dev.hashibadaiki.konjac.dev/`、
リリースビルドは `.dev` の付かない方を使う（`settings.rs` の `config_dir`）。分けていないと、
朝の `tauri dev` が置いた `clipboard-consent` のせいで、その日インストールした .app が
初回の「コピー 2 回で開きますか？」を飛ばして macOS の許可アラートだけを出す、
といったことが起きる。初回フローを何度でも試せるのも分けているおかげ。

分かれていないものが一つある。**アクセシビリティ許可**は macOS が実行ファイル単位で
覚えるので、開発用バイナリと `.app` はそれぞれ別に許可が要る。システム設定の一覧には
どちらも `konjac` という名前で並ぶので、どちらの行を入れたのか見分けがつかない。
しかも開発用の行は再ビルドのたびに中身が変わって勝手に外れる。「許可したのに
キーボード監視にならない」の大半はこれ（[トラブルシューティング](troubleshooting.md)）。

## テスト

`cd src-tauri && cargo test`。プロンプトの組み立て・言語コード・長文の分割・UTF-8 の持ち越し
（`plamo.rs`）、モデルの選定とハッシュ（`models.rs`）はモデル無しでテストできる。

実際の GGUF を読み込む 4 本（`engine.rs`。制御トークンが 1 トークンになるか、貼ったテキストの
`<|plamo:tag|>` が特殊トークンにならないか、区切ってトークン化しても 1 本の文字列と同じになるか、
訳してストリーミングできるか）は既定で無視される。通したいときはモデルを指定する。

```bash
KONJAC_TEST_GGUF=/path/to/plamo-3-translate-2b-Q4_K_M.gguf \
  cargo test -- --ignored --nocapture
```

アプリが落としたモデルなら `~/Library/Application Support/dev.hashibadaiki.konjac/models/` にある。

## CI

macOS 上で `clippy -D warnings` / `cargo build` / `cargo test` と、フロントの
`tsc --noEmit` を回す（`.github/workflows/ci.yml`）。`cargo build` を
`clippy --all-targets` と別に走らせているのは、`--all-targets` が dev-dependencies の
feature を巻き込んでしまい、アプリ本体に足りない feature を隠すため
（実際に `tokio::join!` でこれを踏んだ）。`cargo fmt --check` は入れていない
（rustfmt が書き換えたがる箇所を意図的に手で整えているため）。

アイコンの作り直しは [`icon/README.md`](../icon/README.md) を参照。

## 構成

```
konjac/
├── LICENSE-MIT / LICENSE-APACHE
├── .github/workflows/
│   ├── ci.yml            PR ごとの fmt / clippy / build / test
│   └── release.yml       タグから両 OS のインストーラを作り、署名・公証を検証してから公開する
├── docs/                 このドキュメント
├── icon/                 アイコンの元データと生成スクリプト
├── index.html            UI マークアップ
├── security.json         使ってはいけない版の下限。ここを上げると全インストールが止まる
├── src/
│   ├── main.ts           UI ロジック（invoke / イベント / キーバインド / モデルのダウンロード画面）
│   ├── update.ts         最新リリースと security.json の取得（失敗しても素通りする）
│   └── style.css         ライト・ダーク両対応のスタイル
└── src-tauri/
    └── src/
        ├── lib.rs               Tauri コマンド、トレイ、状態管理
        ├── plamo.rs             PFML3 プロンプト、言語コード、文体、長文の分割、UTF-8 の持ち越し
        ├── engine.rs            llama.cpp でのモデル読み込み・保持と生成（ストリーミング）
        ├── models.rs            モデルの一覧と保存先、Hugging Face からのダウンロードと検証
        ├── settings.rs          設定の型・既定値・永続化、クリップボード読み取りの同意ゲート
        ├── update.rs            バージョン比較、停止の判定、告知 URL の検証
        ├── clipboard_watch.rs   ⌘C ⌘C 検出（変更カウンタのポーリング）と 2 回目の判定
        └── key_watch.rs         ⌘C 検出（macOS のキーボード監視）
```

コードの内部については [仕組み](how-it-works.md)、特に
[コードの置き場所](how-it-works.md#コードの置き場所)。
