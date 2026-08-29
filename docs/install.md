# インストール

## 対応 OS

| OS | 下限 | 動作確認 | 何がそれを決めているか |
|---|---|---|---|
| macOS | **13（Ventura）** | ✅ 実機（開発機） | 画面が `color-mix()` に依存している。これを解釈できる WebKit は Safari 16.2 が最初で、載っているのは macOS 13 以降 |
| Windows | **10** | ⚠️ 未検証 | WebView2 が要る。Windows 11 には最初から入っている |

**開発と動作確認は macOS でやっている。** Windows 版もタグを打つたびにビルドして配布して
いるが、実機で起動を通した記録は無い。⌘C 2 回の検出（`GetClipboardSequenceNumber()`）も
コード上は入っているだけで、実機で確かめてはいない。

macOS の下限は `.app` の `LSMinimumSystemVersion` に入る（`tauri.conf.json` の
`minimumSystemVersion`）ので、これより古い macOS では Finder が起動を止める。

12 以前で外しているのは「試していない」ほうではなく「壊れて出る」ほう。`color-mix()`
を知らない WebKit はその宣言ごと捨てるので、ボタン・枠・オーバーレイの背景が抜けた
画面になる。中途半端に起動して崩れて見えるより、起動を止めたほうが分かりやすい。

**ただしこの下限は CI で検証していない。** GitHub の macOS ランナーは新しい 2 世代
（今は macOS 15 と 26）しか無く、13 や 14 で起動を確かめる手段が無い。上の数字は
コードが要求している版から引いたもので、実機で通した記録ではない。

## 1. 翻訳先を用意する

短い通常文だけなら Google NMT 単独でも動く。全機能を使うには Claude Code を用意する。両方を
設定すると、Google を短文の高速経路、Claude Code を文体指定・コードを含む文書・Google 失敗時の
フォールバックとして使う。

### Google NMT を使う

1. 課金を有効にした Google Cloud プロジェクトで **Cloud Translation API** を有効にする
2. API キーを作り、API の制限を **Cloud Translation API** のみにする
3. コンニャクの設定画面で「Google Cloud Translation API キー」へ入れて保存する

キーは `settings.json` ではなく macOS Keychain / Windows 資格情報マネージャーに保存される。
設定手順は [Google Cloud Translation の認証](https://cloud.google.com/translate/docs/authentication) を参照。

### Claude Code を使う

まだ無ければ、インストールしてログインまで通しておく。

```bash
npm install -g @anthropic-ai/claude-code
claude          # 起動して、サブスクのアカウントでログイン
```

この経路はここで通した認証をそのまま使う。Anthropic API キーは要らない
（詳しくは [Claude Code のセットアップ](https://docs.claude.com/en/docs/claude-code/setup)）。

## 2. コンニャクを入れる

[Releases](https://github.com/hashibadaiki/konjac/releases/latest) から落とす。

| OS | ファイル |
|---|---|
| **macOS 13 以降（Intel / Apple Silicon 共通）** | **`Konjac_x.y.z_universal.dmg`** ← 動作確認しているのはこちら |
| Windows 10 以降 | `Konjac_x.y.z_x64-setup.exe`（未検証） |

Linux 版は出していない。⌘C 2 回の検出に使える API が無く、この
アプリのほぼ全部がそれなので（[⌘C ⌘C をどう取っているか](how-it-works.md#c-c-をどう取っているか)）。
ソースからは普通にビルドできて、トレイから開く常駐アプリとしては動く。

## 3. 初回起動の警告を通す

**macOS** — Release に出している `.dmg` は署名・公証済みなので、そのまま開く。
警告が出るのは自分でビルドした未署名の `.app` を使っている場合で、そのときは
`Applications` に入れたうえで **アイコンを右クリック → 開く**（1 回通せば以降は不要）。

配布物が本当にこのリポジトリから出たものか確かめたいなら
[配布物の検証](release.md#配布物の検証)。

**Windows** — 署名していないので SmartScreen が「WindowsによってPCが保護されました」を
出す。**「詳細情報」→「実行」**で進む。証明書を買っていないためで、それ以外の意味はない。

## 4. ⌘C 2 回を有効にする（任意）

**既定ではオフ**。初回起動時に「コピー 2 回で開きますか？」という画面が出て、何が
送信されるかを提示したうえで有効にするかどうかを訊く。ここで「いまはしない」を選んでも、
設定画面（歯車）の「コピーを 2 回押したら開いて、クリップボードの内容を翻訳する」から
あとで有効にできる（そちらでも同じ確認が出る）。この質問は一度きりで、答えた時点で
記録される（[プライバシー](privacy.md)）。

## 5. アクセシビリティを許可する（macOS、任意）

**⌘ を押しっぱなしのまま C を 2 回**にも反応させたいなら、アクセシビリティ許可が要る。
上で有効にした直後に macOS のアラートが出るので、「システム設定を開く」→ コンニャクに
チェック。それだけで切り替わる。あとから許可するなら、メイン画面に出る案内か、設定画面の
「許可設定を開く」から。
許可しない場合はクリップボード監視で動くので、**⌘ を一度離してから** 2 回押す。
このときは入力欄に入るところまでで止まり、翻訳は `⌘/Ctrl+Enter` で実行する。
違いは [この表](how-it-works.md#deepl-と同じ-押しっぱなしに対応するmacos)。

## 更新のしかた

[Releases](https://github.com/hashibadaiki/konjac/releases/latest) から新しいインストーラを
落として、そのまま上書きする。設定（`settings.json`）も同意の記録もアプリの外にあるので
消えない。**自動更新は入れていない** — 理由と、代わりに何が入っているかは
[更新の通知とキルスイッチ](updates.md)。

署名済みのリリース版を使っているなら、アクセシビリティ許可は更新をまたいで残る。
自分でビルドした未署名の `.app` では毎回外れる（[macOS の署名と公証](release.md#macos-の署名と公証)）。
