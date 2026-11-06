# ライセンス

**MIT または Apache License 2.0** のデュアルライセンス。好きな方を選んで使える
（[LICENSE-MIT](../LICENSE-MIT) / [LICENSE-APACHE](../LICENSE-APACHE)）。

Rust エコシステムの慣例に合わせてある。依存ツリーは Tauri・tokio・serde・objc2 と
ほぼ全部これなので、揃えておくと下流で困らない。GPLv2 のプロジェクトは MIT 側を、
特許条項が要る場合は Apache 側を取れる。

貢献した内容も、明示しない限り同じ条件で受け取ったものとする。

## 名前とアイコンは対象外

上記が及ぶのはコードだけで、**「Konjac」「コンニャク」の名前とアイコンは
含まない**（Apache-2.0 §6 も商標を許諾しない旨を明示している）。フォークして配布するのは
自由だが、その場合は別の名前を付けてほしい。同じ名前の別物があると、どちらに
バグを報告すればいいのか分からなくなるため。

## 翻訳モデル

**Built with PLaMo.**

翻訳に使う **PLaMo 3 Translate**（Preferred Networks）の重みは、このリポジトリにも配布物にも
**含まれていない**。ユーザーがアプリの中から Hugging Face（`pfnet/plamo-3-translate-*-GGUF`）
から自分でダウンロードする。上の MIT / Apache-2.0 は重みには及ばない。

重みのライセンスは
[PLaMo Community License](https://plamo.preferredai.jp/info/plamo-community-license-en)。
個人・研究・非商用の利用は登録なしで使えるが、**商用利用には条件がある**。業務で使うなら、
ダウンロードの前に読んで条件を確かめること（アプリのダウンロード画面と設定画面にも
「ライセンスを読む」ボタンがある）。

推論には [llama.cpp](https://github.com/ggml-org/llama.cpp)（MIT）を、Rust バインディングの
`llama-cpp-2` / `llama-cpp-sys-2` クレート経由で静的にリンクしている。

## 依存ライブラリについて

強いコピーレフトのライブラリは入っていない。MPL-2.0 のクレート
（`selectors` / `cssparser` / `servo_arc`）だけは依存ツリーに現れるが、
`tauri-macros` 経由の proc-macro＝ビルド時のみで、配布バイナリにはリンクされない。
