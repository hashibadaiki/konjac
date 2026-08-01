# 翻訳評価セット（英語 → 日本語）

`en-ja.jsonl` は英語 20 件と、その参照訳（日本語）の対。モデルを変えたとき
（`haiku` に落とす、バージョン固定 ID に切り替える）や、`translate.rs` の
システムプロンプトをいじったときに、訳の質が落ちていないかを見るためのもの。

## フォーマット

1 行 1 件の JSONL。

| フィールド | 内容 |
|---|---|
| `id` | `en-ja-01` … `en-ja-20` |
| `category` | 何を見る項目か（下表） |
| `tone` | この件を流すときの文体設定。アプリの値と同じ（`default` / `formal` / `casual` / `technical`） |
| `source` | 翻訳対象の英語。`\n` は実際の改行 |
| `reference` | 参照訳。**唯一の正解ではなく**、この程度に訳せていれば合格という基準 |
| `must_keep` | 訳文に**そのまま含まれていなければ失格**の文字列（コード・URL・数値など）。機械チェック用 |
| `notes` | 採点時に見るポイント。落ちるときの典型的な壊れ方を書いてある |

`must_keep` だけが自動判定できる部分で、それ以外は `reference` と `notes` を見て人が判断する。

## 内訳

| category | 件数 | 見ているもの |
|---|---|---|
| `register` | 4 | 文体設定（敬体・口語・技術文書・警告文）が訳文に効いているか |
| `code` | 2 | コードブロック・識別子・パス・URL を触らずに残すか |
| `injection` | 2 | 訳文だけを返し、本文中の指示に従わないか |
| `numbers` | 2 | 数値・単位・日付・通貨を改変しないか |
| `grammar` | 2 | 代名詞の省略、長文の係り受け |
| `ui` | 2 | UI ラベル・エラーメッセージの日本語らしさ |
| `markdown` / `layout` | 2 | 見出し・リスト・強調・行数の保持 |
| `plain` / `idiom` / `ambiguity` / `punctuation` | 4 | 基準ケース、慣用句、同形語の訳し分け、引用符（`「」`） |

## 回し方

一番手軽なのはアプリ本体。言語を `English → Japanese`、文体をその件の `tone` に合わせて
`source` を貼る。20 件なら数分。

CLI で自動化する場合は、アプリと同じ条件で呼ぶ必要がある
（`src-tauri/src/translate.rs` の `run_cli` と `system_prompt` が実体）。

```bash
claude --print \
       --model <モデル> \
       --output-format json \
       --tools "" \
       --safe-mode \
       --strict-mcp-config \
       --no-session-persistence \
       --system-prompt "<system_prompt(\"English\", \"Japanese\", <tone>) と同じ文面>" \
       <<< "<source>"
```

`MAX_THINKING_TOKENS=0` も付ける（アプリが設定している。付けないと haiku が
数十秒かけて同じ答えを出す）。システムプロンプトを直書きで持たせると
`translate.rs` を変えたときにズレるので、比較したいのが「プロンプトの変更前後」なら
その時点の `system_prompt()` の出力を使うこと。

## 採点

件ごとに ○ / △ / × の 3 段階で足りる。

- **×** — `must_keep` が欠けた、行数や構造が壊れた、指示に従ってしまった、意味が変わった、
  訳文以外（前置き・断り書き・引用符での囲み）が混ざった
- **△** — 意味は合っているが文体が指定と違う、直訳が残っている、日本語として不自然
- **○** — `reference` と同程度

× が出た件は `notes` にどう壊れたかを書き足しておくと、次にモデルを変えるときに効く。
