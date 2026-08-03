# リリースの出し方

`tauri.conf.json` の `version` を上げて、同じ番号のタグを push する。

```bash
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/release.yml` が macOS（universal）と Windows のインストーラを作って
Release に添付する。タグと `tauri.conf.json` の `version` が食い違っていると最初の
ジョブで止まる（成果物のファイル名は設定側の番号から付くので、放っておくと
`v0.2.0` のリリースに `0.1.0` のファイルが並ぶ）。両方のビルドが揃って、
macOS の成果物が署名・公証の検証を通るまでリリースは下書きのままで、
どれかが失敗したら下書きのまま残る。

`tauri.conf.json` の `version` は、成果物のファイル名とタグの検証に使われるだけでなく、
アプリが自分を何番だと思うかでもある（設定画面の表示と、更新の判定に使う番号。
[更新の通知とキルスイッチ](updates.md)）。`package.json` と
`src-tauri/Cargo.toml` にも番号があるが、そちらは CI では検証していないので手で揃える。

## macOS の署名と公証

**secrets が揃っていないとリリースは走らない。** 最初の `preflight` ジョブで
6 つの secret の存在と `APPLE_SIGNING_IDENTITY` が
`Developer ID Application:` で始まることを確かめ、欠けていればビルドに入る前に落とす
（[未署名 DMG を公開しない仕組み](#未署名-dmg-を公開しない仕組み)）。
Developer ID Application 証明書を用意して、リポジトリの secrets に入れる:

| Secret | 中身 |
|---|---|
| `APPLE_CERTIFICATE` | `.p12` を base64 にしたもの（`base64 -i cert.p12`） |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` の書き出し時に付けたパスワード |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: 名前 (TEAMID)` |
| `APPLE_ID` | Apple ID のメールアドレス |
| `APPLE_PASSWORD` | [App 用パスワード](https://account.apple.com/account/manage)（ログインパスワードではない） |
| `APPLE_TEAM_ID` | 10 文字のチーム ID |

`security find-identity -v -p codesigning | grep "Developer ID Application"` で
証明書の有無と識別名が確認できる。Xcode が自動で作る `Apple Development` は
配布には使えない。

署名の実利は警告が消えることだけではない。macOS はアクセシビリティ許可を、
未署名アプリでは**実行ファイルのパスと内容**で覚えるので、アプリを更新するたびに
許可が外れる。署名済みなら Team ID と bundle ID で覚えるため、更新をまたいで残る。

entitlements ファイルは置いていない。必要が無いため:
`claude` の子プロセス起動は Hardened Runtime の制限対象ではなく、キーボード監視は
entitlement ではなくアクセシビリティ許可で決まり、WebView の JIT は OS 側の別プロセスに
ある。**App Sandbox は有効にしない** — 有効にすると `claude` を起動できなくなる。

Windows は署名していない。OV/EV 証明書が必要で、費用対効果が「詳細情報 → 実行」の
2 クリックに見合わないと判断した。

## 未署名 DMG を公開しない仕組み

アクセシビリティ許可を求めるアプリなので、「配布元が誰か」「落としたファイルが
そのビルドと同じものか」を利用者が確かめられることを公開の条件にしている。
secrets の入れ忘れや公証の失敗で未署名の `.dmg` が公開されないよう、
workflow を 3 段で止める。

| ジョブ | いつ落ちるか |
|---|---|
| `preflight` | Apple の secrets が 1 つでも空、または `APPLE_SIGNING_IDENTITY` が `Developer ID Application:` で始まらないとき。ビルドを 1 分も回す前に落ちる |
| `verify` | 下書きリリースに上がった `.dmg` が署名・公証・staple のどれかを満たさないとき |
| `publish` | 上の 2 つが通らないかぎり実行されない。下書きを公開状態にするのはこのジョブだけ |

`verify` はビルドツリーではなく**下書きリリースから `.dmg` を落とし直して**検証する。
利用者が実際に受け取るファイルと同じものを見たいからで、ビルド機の上では正しいのに
アップロードで壊れた、という失敗もここで捕まる。落としてきた `.dmg` をマウントし、
`.dmg` 本体と中の `.app` の両方に対して:

- `codesign --verify --deep --strict` — 署名の破損、後から足された同梱物、
  universal バイナリの両スライスを見る
- `codesign --display` の `Authority` が `Developer ID Application:` であること
  （ad-hoc 署名や `TeamIdentifier=not set` は落とす）
- `spctl --assess` が `source=Notarized Developer ID` を返すこと。
  署名しただけで公証していないと、ここが `Unnotarized Developer ID` になる
- `xcrun stapler validate` — 公証チケットが埋め込まれていること。これが無いと
  初回起動時に Apple への問い合わせが要る（＝オフラインで開けない）

検証を通ったら、リリースに上がっている全ファイルの SHA-256 を計算して
`SHA256SUMS.txt` として添付し、リリースノートにも同じ内容を載せる。

失敗した場合、下書きリリースには成果物が残るが**下書きのまま**なので公開されない。
原因を直して同じタグで workflow を再実行すれば、同じリリースを作り直す。

## 配布物の検証

Release から落とした `.dmg` は、手元で 2 つのことを確かめられる。

```bash
# 1. ファイルの同一性 — リリースノート（または SHA256SUMS.txt）の値と突き合わせる
shasum -a 256 Konjac_0.1.0_universal.dmg

# 2. 配布元 — Team ID と Developer ID を見る
codesign --display --verbose=4 /Applications/Konjac.app
#   Authority=Developer ID Application: ... (TEAMID)

# 3. 公証 — Gatekeeper がどう見ているか
spctl --assess --type execute --verbose=4 /Applications/Konjac.app
#   source=Notarized Developer ID
```

`accepted` と `Notarized Developer ID` の両方が出れば、Apple の公証を通った
Developer ID 署名として受理されている。CI が公開前に通しているのと同じ確認で、
違うのは対象が手元のファイルであることだけ。
