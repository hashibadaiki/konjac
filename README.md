# Konjac（コンニャク）

English | [日本語](README.ja.md)

A tiny translation app that opens on a **double ⌘C**. For macOS. Built with Tauri 2.
Windows builds are published too, but they are [not expected to work yet](#download).

```
[⌘C] [⌘C] → window appears → the copied text is translated → [Esc] to dismiss
```

Translation runs **on your machine** with Preferred Networks' open-weight
**[PLaMo 3 Translate](https://www.preferred.jp/ja/news/pr20261105)** through llama.cpp. The model
is downloaded once from Hugging Face the first time you use it; after that, nothing you
translate leaves the machine and no network connection is needed. **Built with PLaMo.**

Alternatively, pick **Claude Haiku** in the model menu to translate through the local
`claude` CLI (Claude Code, `claude -p`) on your Claude subscription. That engine **sends
the text to Anthropic**.

## Demo

https://github.com/user-attachments/assets/635d6680-36f0-4da6-aa56-ff033c469d1a

## Download

**→ [Latest release](../../releases/latest)**

| OS | File to grab | Tested |
|---|---|---|
| **macOS 13 (Ventura) or later** | **`Konjac_x.y.z_universal.dmg`** (Intel / Apple Silicon) | ✅ this is the one that gets tested |
| Windows 10 or later | `Konjac_x.y.z_x64-setup.exe` | ❌ **untested, and most likely broken** |

**Development and testing happen on macOS.** Windows installers are built and published
on every tag, but not one has ever been launched on an actual machine.

Windows is still untested, and there are known gaps:

- The double-⌘C detection itself may never fire on Windows ([#28](../../issues/28))
- There is no keyboard monitoring on Windows, so even when it does fire, by default the
  text only lands in the input box; you translate with `Ctrl+Enter`
- The model runs on the CPU there (the macOS build uses Metal), so it is much slower

Until someone runs it, use the macOS `.dmg`.

> **Requirements**: disk space and memory for the model you pick — the default 0.8B model is
> about a 0.6 GB download (2B / 8B / 31B are also offered). The first translation needs
> a network connection to fetch it; nothing else does.
>
> **Model licence**: the weights are under the
> [PLaMo Community License](https://plamo.preferredai.jp/info/plamo-community-license-en).
> Personal, research and non-commercial use need no registration; **commercial use has
> conditions** — read it first. The weights are not bundled with the app.
>
> **Double ⌘C is off by default.** Turning it on means the app reads the clipboard the
> moment it detects the gesture, so it asks for consent — spelling out what gets read —
> before the switch takes (→ [Privacy](docs/privacy.md), in Japanese).

## What it does

- **Double ⌘C to open and translate** — the copied text lands in the input box (off by
  default). Grant Accessibility and it also catches **C pressed twice while ⌘ is held**
- **Lives in the tray (menu bar on macOS)** — closing the window keeps it running;
  reopen and quit from there
- 15 languages with a swap button, a register picker for Japanese output
  (です・ます / だ・である), and a model-size picker (0.8B / 2B / 8B / 31B)
- **Fully on-device translation** with PLaMo 3 Translate — no API key, no account
- **Claude Haiku via Claude Code** as a selectable alternative (sends the text to Anthropic)
- **Streaming output**, editable results, optional auto-copy
- **Update notices and a kill switch** — [no auto-update](docs/updates.md)

## Usage

| Action | What happens |
|---|---|
| `⌘/Ctrl + C` twice | Shows the window with the copied text in the input box; with keyboard monitoring it translates right away (off by default) |
| Tray icon → コンニャクを開く | Shows the window (the clipboard is not touched) |
| `⌘/Ctrl + Enter` | Translate |
| `Esc` | Close settings / hide the window |
| `−` / `✕` in the title bar | Minimise / hide (bring it back from the tray) |

Settings live behind the gear button. There is no save button — a change is written the
moment you make it. → [Usage notes](docs/usage.md) (in Japanese)

## Documentation

The detailed docs are written in Japanese.

| | |
|---|---|
| [プライバシー / Privacy](docs/privacy.md) | What is sent and when, and why the clipboard is not read by default |
| [インストール / Install](docs/install.md) | Downloading the model, getting past the first-launch warning, enabling double ⌘C and Accessibility, supported OS versions |
| [使い方 / Usage](docs/usage.md) | Window behaviour, picking a model, where settings and models are stored |
| [仕組み / How it works](docs/how-it-works.md) | The PLaMo prompt, streaming, long input, model download, how the double ⌘C is detected |
| [更新の通知とキルスイッチ / Updates](docs/updates.md) | Why there is no auto-update, and what is there instead |
| [詰まりやすいところ / Troubleshooting](docs/troubleshooting.md) | Download failures, slow or out-of-memory models, double ⌘C not firing, and friends |
| [開発 / Development](docs/development.md) | Build, test, CI, directory layout |
| [リリース / Release](docs/release.md) | Cutting a tag, signing and notarisation, verifying what you downloaded |

## Licence

Dual-licensed under **MIT or Apache License 2.0**
([LICENSE-MIT](LICENSE-MIT) / [LICENSE-APACHE](LICENSE-APACHE)) — take whichever you
prefer. The name "Konjac" / "コンニャク" and the icon are **not** covered, and the PLaMo 3
Translate weights the app downloads are under their own licence
→ [Licence](docs/license.md) (in Japanese)
