# Konjac（コンニャク）

English | [日本語](README.ja.md)

A tiny translation app that opens on a **double ⌘C**. For macOS. Built with Tauri 2.
Windows builds are published too, but they are [not expected to work yet](#download).

```
[⌘C] [⌘C] → window appears → the copied text is translated → [Esc] to dismiss
```

Short, plain text takes a fast path through **Google Cloud Translation NMT**. Tone-aware
text, code/URLs, and Google failures automatically fall back to the local **`claude` CLI
(Claude Code)**. Without Google configured it still works from a Claude subscription alone.

## Demo

https://github.com/user-attachments/assets/504b6f4c-8680-48ef-8cd6-233493fa400b

## Download

**→ [Latest release](../../releases/latest)**

| OS | File to grab | Tested |
|---|---|---|
| **macOS 13 (Ventura) or later** | **`Konjac_x.y.z_universal.dmg`** (Intel / Apple Silicon) | ✅ this is the one that gets tested |
| Windows 10 or later | `Konjac_x.y.z_x64-setup.exe` | ❌ **untested, and most likely broken** |

**Development and testing happen on macOS.** Windows installers are built and published
on every tag, but not one has ever been launched on an actual machine.

Re-reading the code with Windows in mind, **the current Windows build is unlikely to work
at all**.

- With the npm build of Claude Code — the one [Install](docs/install.md) tells you to get
  — every translation fails at launch ([#27](../../issues/27))
- The double-⌘C detection itself may never fire on Windows ([#28](../../issues/28))
- There is no keyboard monitoring on Windows, so even when it does fire, by default the
  text only lands in the input box; you translate with `Ctrl+Enter`

Until that is fixed, use the macOS `.dmg`.

> **Requirements**: a Google Cloud Translation API key or
> [Claude Code](https://docs.claude.com/en/docs/claude-code/setup) installed and logged in.
> With both configured, Google is the fast path and Claude Code is the fallback
> (Google alone covers only short, plain text).
>
> **Double ⌘C is off by default.** Turning it on means the app reads the clipboard the
> moment it detects the gesture and sends that text to the selected translation service, so it asks for consent
> — spelling out what gets sent — before the switch takes (→ [Privacy](docs/privacy.md),
> in Japanese).

## What it does

- **Double ⌘C to open and translate** — the copied text lands in the input box (off by
  default). Grant Accessibility and it also catches **C pressed twice while ⌘ is held**
- **Lives in the tray (menu bar on macOS)** — closing the window keeps it running;
  reopen and quit from there
- 16 languages with a swap button, 4 tones, and a model picker
  (`opus` / `sonnet` / `haiku` / `fable`)
- **Google NMT fast path** with automatic Claude Code fallback
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
| [インストール / Install](docs/install.md) | Setting up Google / Claude Code, getting past the first-launch warning, enabling double ⌘C and Accessibility, supported OS versions |
| [使い方 / Usage](docs/usage.md) | Window behaviour, picking a model, where settings are stored |
| [仕組み / How it works](docs/how-it-works.md) | Google → Claude routing, streaming, input-length limits, how the double ⌘C is detected |
| [更新の通知とキルスイッチ / Updates](docs/updates.md) | Why there is no auto-update, and what is there instead |
| [詰まりやすいところ / Troubleshooting](docs/troubleshooting.md) | `claude` not found, double ⌘C not firing, and friends |
| [開発 / Development](docs/development.md) | Build, test, CI, directory layout |
| [リリース / Release](docs/release.md) | Cutting a tag, signing and notarisation, verifying what you downloaded |

## Licence

Dual-licensed under **MIT or Apache License 2.0**
([LICENSE-MIT](LICENSE-MIT) / [LICENSE-APACHE](LICENSE-APACHE)) — take whichever you
prefer. The name "Konjac" / "コンニャク" and the icon are **not** covered
→ [Licence](docs/license.md) (in Japanese)
