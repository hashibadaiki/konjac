# アイコン

縦長のコンニャクを一丁、少し上から見た向きで。上面・正面・側面の 3 面と、
中に浮いた黒い斑点（奥にあるものは薄く）で立体を出している。

- `build.mjs` — 元データ。寸法は先頭の定数（正面の位置、奥行きベクトル、角の
  丸み）だけで決まる。斑点は面に対する相対座標なので、寸法を変えても崩れない
- `app-icon.svg` / `.png` — `build.mjs` の出力。`tauri icon` に食わせるのは PNG
- `app-icon-tile.svg` / `.png` — 琥珀色のタイルに乗せた別案

縦長なので、正方形の枠に置くと小さいサイズ（トレイの 22px あたり）では細く
なる。Dock やメニューバーで埋没するようならタイル案に差し替えるとよい。

`src-tauri/icons/` 以下は生成物なので、直接いじらずに作り直す:

```sh
npm i -D playwright && npx playwright install chromium

node icon/build.mjs                  # SVG と PNG（1024、透過）を両案ぶん書き出す
npm run tauri icon icon/app-icon.png
rm -rf src-tauri/icons/android src-tauri/icons/ios   # デスクトップのみなので不要
```

SVG を `tauri icon` に直接渡してもいいが、そちらは resvg で描かれるので
斑点のコントラストとフチの太さが変わる。上のようにブラウザで PNG にしてから
渡すこと。

タイル案に差し替えるなら `npm run tauri icon icon/app-icon-tile.png`。
