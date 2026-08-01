import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

// ---------------------------------------------------------------- types

interface Settings {
  claude_bin: string;
  model: string;
  source_lang: string;
  target_lang: string;
  tone: string;
  double_copy_enabled: boolean;
  double_copy_window_ms: number;
  auto_copy_result: boolean;
  timeout_secs: number;
}

interface TranslateResult {
  text: string;
  model: string;
  elapsed_ms: number;
}

interface TriggerPayload {
  text: string | null;
}

/** A fragment of a translation in progress, tagged with the run it belongs to. */
interface DeltaPayload {
  id: number;
  text: string;
}

/** What `check_cli` reports about the `claude` it found. */
interface CliStatus {
  version: string;
  path: string;
  /** Non-empty means the CLI predates flags the app cannot translate without. */
  missingFlags: string[];
  streaming: boolean;
  apiKeyInEnv: boolean;
}

interface WatchStatus {
  supported: boolean;
  running: boolean;
  enabled: boolean;
  windowMs: number;
  source: "keyboard" | "clipboard" | "none";
  needsPermission: boolean;
  changeCount: number;
  copiesSeen: number;
  burstsIgnored: number;
  doublesFired: number;
}

// ---------------------------------------------------------------- options

const LANGS: [string, string][] = [
  ["auto", "自動検出"],
  ["Japanese", "日本語"],
  ["English", "English"],
  ["Chinese (Simplified)", "简体中文"],
  ["Chinese (Traditional)", "繁體中文"],
  ["Korean", "한국어"],
  ["French", "Français"],
  ["German", "Deutsch"],
  ["Spanish", "Español"],
  ["Portuguese", "Português"],
  ["Italian", "Italiano"],
  ["Russian", "Русский"],
  ["Vietnamese", "Tiếng Việt"],
  ["Thai", "ไทย"],
  ["Indonesian", "Bahasa Indonesia"],
  ["Arabic", "العربية"],
];

const TONES: [string, string][] = [
  ["default", "標準"],
  ["formal", "敬体・ビジネス"],
  ["casual", "口語・カジュアル"],
  ["technical", "技術文書"],
];

const MODEL_GROUPS: [string, [string, string][]][] = [
  [
    "エイリアス（常に最新）",
    [
      ["opus", "opus — 最高品質"],
      ["sonnet", "sonnet — 品質と速度のバランス"],
      ["haiku", "haiku — 最速・最安"],
      ["fable", "fable — 最上位"],
    ],
  ],
  [
    "バージョン固定",
    [
      ["claude-opus-4-8", "claude-opus-4-8"],
      ["claude-sonnet-4-6", "claude-sonnet-4-6"],
      ["claude-haiku-4-5", "claude-haiku-4-5"],
    ],
  ],
];

/**
 * Only reached if the select somehow has no value — the Rust side applies the
 * same default to a blank model, and it is the authority (`settings.rs`).
 */
const DEFAULT_MODEL = "sonnet";

/*
 * Past a certain length the CLI stops returning the whole translation, and it
 * does so silently: the model runs into its output ceiling, and `result` comes
 * back holding only the tail of the document with no error attached. Measured
 * against this app's own invocation (English → Japanese), haiku loses the head
 * of the text somewhere between 72,000 and 80,000 source characters, and the
 * larger models at roughly twice that (144,000 clean, 160,000 truncated).
 *
 * These caps sit well under both, because the ceiling is not the only thing in
 * the way. Streaming turned `timeout_secs` into an idle timer, so a long run is
 * no longer cut off while it is still producing — but the wait is real either
 * way: about 25 seconds at 6,000 characters, 44 at 12,000, two and a half
 * minutes at 48,000. A translation nobody will sit through is not much better
 * than one that never arrives.
 */
const HAIKU_CHAR_LIMIT = 10_000;
const CHAR_LIMIT = 100_000;

/** Matches the aliases (`haiku`) and the pinned ids (`claude-haiku-4-5`) alike. */
const charLimit = (model: string) =>
  /haiku/i.test(model) ? HAIKU_CHAR_LIMIT : CHAR_LIMIT;

const IS_MAC = navigator.userAgent.includes("Mac");
const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";
const COPY_KEY = IS_MAC ? "⌘C" : "Ctrl+C";

// ---------------------------------------------------------------- dom

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element: #${id}`);
  return el as T;
};

const el = {
  backendBadge: $<HTMLSpanElement>("backend-badge"),
  btnSettings: $<HTMLButtonElement>("btn-settings"),
  btnMinimize: $<HTMLButtonElement>("btn-minimize"),
  btnClose: $<HTMLButtonElement>("btn-close"),

  paneTranslate: $<HTMLElement>("pane-translate"),
  paneSettings: $<HTMLElement>("pane-settings"),
  paneSetup: $<HTMLElement>("pane-setup"),

  apiKeyWarning: $<HTMLParagraphElement>("api-key-warning"),

  permissionBanner: $<HTMLDivElement>("permission-banner"),
  permissionBannerText: $<HTMLParagraphElement>("permission-banner-text"),
  btnBannerAccessibility: $<HTMLButtonElement>("btn-banner-accessibility"),
  btnBannerDismiss: $<HTMLButtonElement>("btn-banner-dismiss"),

  setupHead: $<HTMLHeadingElement>("setup-head"),
  setupLead: $<HTMLParagraphElement>("setup-lead"),
  setupStepInstall: $<HTMLParagraphElement>("setup-step-install"),
  setupCommand: $<HTMLElement>("setup-command"),
  setupStatus: $<HTMLParagraphElement>("setup-status"),
  setupDetail: $<HTMLParagraphElement>("setup-detail"),
  btnSetupCopy: $<HTMLButtonElement>("btn-setup-copy"),
  btnSetupRecheck: $<HTMLButtonElement>("btn-setup-recheck"),
  btnSetupDocs: $<HTMLButtonElement>("btn-setup-docs"),
  btnSetupSettings: $<HTMLButtonElement>("btn-setup-settings"),

  sourceLang: $<HTMLSelectElement>("source-lang"),
  targetLang: $<HTMLSelectElement>("target-lang"),
  tone: $<HTMLSelectElement>("tone"),
  model: $<HTMLSelectElement>("model"),
  btnSwap: $<HTMLButtonElement>("btn-swap"),

  input: $<HTMLTextAreaElement>("input"),
  inputOverflow: $<HTMLParagraphElement>("input-overflow"),
  inputOverflowCount: $<HTMLSpanElement>("input-overflow-count"),
  inputOverflowNote: $<HTMLSpanElement>("input-overflow-note"),
  output: $<HTMLTextAreaElement>("output"),
  status: $<HTMLSpanElement>("status"),

  loading: $<HTMLDivElement>("loading"),
  loadingLabel: $<HTMLSpanElement>("loading-label"),
  loadingElapsed: $<HTMLSpanElement>("loading-elapsed"),

  btnTranslate: $<HTMLButtonElement>("btn-translate"),
  btnCopy: $<HTMLButtonElement>("btn-copy"),

  setClaudeBin: $<HTMLInputElement>("set-claude-bin"),
  setDoubleCopy: $<HTMLInputElement>("set-double-copy"),
  setDoubleCopyWindow: $<HTMLInputElement>("set-double-copy-window"),
  fieldDoubleCopyWindow: $<HTMLLabelElement>("field-double-copy-window"),
  doubleCopyGesture: $<HTMLParagraphElement>("double-copy-gesture"),
  doubleCopyUnsupported: $<HTMLParagraphElement>("double-copy-unsupported"),
  permissionPrompt: $<HTMLDivElement>("permission-prompt"),
  btnOpenAccessibility: $<HTMLButtonElement>("btn-open-accessibility"),
  btnRecheckAccessibility: $<HTMLButtonElement>("btn-recheck-accessibility"),
  doubleCopyDiag: $<HTMLDivElement>("double-copy-diag"),
  diagRunning: $<HTMLSpanElement>("diag-running"),
  diagRowCount: $<HTMLDivElement>("diag-row-count"),
  diagCount: $<HTMLSpanElement>("diag-count"),
  diagCopies: $<HTMLSpanElement>("diag-copies"),
  diagRowBursts: $<HTMLDivElement>("diag-row-bursts"),
  diagBursts: $<HTMLSpanElement>("diag-bursts"),
  diagDoubles: $<HTMLSpanElement>("diag-doubles"),
  diagHint: $<HTMLParagraphElement>("diag-hint"),
  setAutoCopy: $<HTMLInputElement>("set-auto-copy"),
  setTimeout: $<HTMLInputElement>("set-timeout"),
  btnSave: $<HTMLButtonElement>("btn-save"),
  btnCheck: $<HTMLButtonElement>("btn-check"),
  settingsStatus: $<HTMLSpanElement>("settings-status"),
};

// ---------------------------------------------------------------- state

let settings: Settings;
let busy = false;
let doubleCopySupported = false;
/**
 * Whether the main pane's permission banner has been waved off. Session-only:
 * the ask is still true next launch, and dropping it for good would leave the
 * settings pane as the only place it is ever made again.
 */
let permissionDismissed = false;

/** Identifies the run whose fragments may be written to the output box. */
let streamSeq = 0;
let activeStream = 0;
let streamed = "";

const appWindow = getCurrentWindow();

// ---------------------------------------------------------------- helpers

function fillSelect(select: HTMLSelectElement, options: [string, string][]) {
  select.replaceChildren(
    ...options.map(([value, label]) => new Option(label, value)),
  );
}

function fillGroupedSelect(
  select: HTMLSelectElement,
  groups: [string, [string, string][]][],
) {
  select.replaceChildren(
    ...groups.map(([groupLabel, options]) => {
      const group = document.createElement("optgroup");
      group.label = groupLabel;
      group.append(...options.map(([value, label]) => new Option(label, value)));
      return group;
    }),
  );
}

/** Keep a saved value selectable even if it predates the current option list. */
function selectWithFallback(select: HTMLSelectElement, value: string) {
  const known = Array.from(select.options).some(
    (option) => option.value === value,
  );
  if (!known && value) {
    const group = document.createElement("optgroup");
    group.label = "保存済み";
    group.append(new Option(value, value));
    select.append(group);
  }
  select.value = value;
}

function setStatus(
  node: HTMLElement,
  message: string,
  kind: "" | "ok" | "error" = "",
) {
  node.textContent = message;
  node.classList.toggle("is-ok", kind === "ok");
  node.classList.toggle("is-error", kind === "error");
}

/**
 * A one-shot squash-and-stretch. Restarting it means clearing the class and
 * forcing a reflow first, otherwise two results in a row only wobble once.
 */
function jiggle(node: HTMLElement) {
  node.classList.remove("is-jiggle");
  void node.offsetWidth;
  node.classList.add("is-jiggle");
}

document.addEventListener("animationend", (event) => {
  if (event.animationName === "jiggle") {
    (event.target as HTMLElement).classList.remove("is-jiggle");
  }
});

let elapsedTimer: number | undefined;

/**
 * Nothing has arrived yet at this point — the CLI spends a couple of seconds on
 * process startup before the model says a word — so the wait needs something
 * that visibly moves rather than a static word: a spinner, which model is being
 * asked, and the seconds spent so far.
 */
function setBusy(next: boolean) {
  busy = next;
  el.btnTranslate.disabled = next;
  el.btnTranslate.textContent = next ? "翻訳中" : "翻訳";
  el.btnTranslate.classList.toggle("is-busy", next);
  // The result overwrites this box, so keep edits out until it has landed.
  el.output.readOnly = next;
  el.loading.classList.toggle("hidden", !next);
  el.loading.classList.remove("loading--inline");

  window.clearInterval(elapsedTimer);
  elapsedTimer = undefined;
  if (!next) return;

  el.loadingLabel.textContent = `${el.model.value} で翻訳しています…`;
  const started = performance.now();
  const tick = () => {
    const seconds = (performance.now() - started) / 1000;
    el.loadingElapsed.textContent = `${seconds.toFixed(1)}s`;
  };
  tick();
  elapsedTimer = window.setInterval(tick, 100);
}

/**
 * Once text starts landing, the overlay has to get out of the way of the thing
 * it was covering for: it shrinks to a corner pill that keeps the spinner and
 * the clock visible while the rest of the translation streams in underneath.
 */
function setStreaming() {
  el.loading.classList.add("loading--inline");
  el.loadingLabel.textContent = "受信中";
}

const writeClipboard = (text: string) =>
  invoke<void>("write_clipboard", { text });

/**
 * Says nothing until the text is actually over the limit for the model that is
 * selected right now — so it has to be re-run when the model changes, not only
 * when the text does.
 */
function syncOverflow() {
  const model = el.model.value;
  const limit = charLimit(model);
  const count = el.input.value.length;

  el.inputOverflow.classList.toggle("hidden", count <= limit);
  if (count <= limit) return;

  el.inputOverflowCount.textContent = `${count.toLocaleString()} / ${limit.toLocaleString()} 字`;
  el.inputOverflowNote.textContent = ` — ${model} の上限を超えています。長すぎると訳文の先頭が欠けたまま返ることがあります。`;
}

// ---------------------------------------------------------------- settings

function applySettingsToUi() {
  el.sourceLang.value = settings.source_lang;
  el.targetLang.value = settings.target_lang;
  el.tone.value = settings.tone;
  selectWithFallback(el.model, settings.model);

  el.setClaudeBin.value = settings.claude_bin;
  el.setDoubleCopy.checked = settings.double_copy_enabled;
  el.setDoubleCopyWindow.value = String(settings.double_copy_window_ms);
  el.setAutoCopy.checked = settings.auto_copy_result;
  el.setTimeout.value = String(settings.timeout_secs);

  syncTriggerFields();
  // The limit depends on the model, so a restored or swapped model can put the
  // text that is already in the box over (or back under) the line.
  syncOverflow();
}

function syncTriggerFields() {
  const showDoubleCopy = doubleCopySupported && el.setDoubleCopy.checked;
  el.setDoubleCopy.disabled = !doubleCopySupported;
  el.fieldDoubleCopyWindow.classList.toggle("hidden", !showDoubleCopy);
  el.doubleCopyGesture.classList.toggle("hidden", !showDoubleCopy);
  el.doubleCopyDiag.classList.toggle("hidden", !showDoubleCopy);
  el.doubleCopyUnsupported.classList.toggle("hidden", doubleCopySupported);
  if (!showDoubleCopy) {
    el.permissionPrompt.classList.add("hidden");
  }
}

// ---------------------------------------------------------------- diagnostics

let diagTimer: number | undefined;

/**
 * Which presses actually work depends on the detector in use, and only the
 * running app knows which one that is — so the gesture is described from the
 * live status rather than spelled out in the markup.
 */
const GESTURE_TEXT: Record<WatchStatus["source"], string> = {
  // Keyboard monitoring is macOS-only, so this one can name ⌘ outright.
  keyboard:
    "キーボード監視中。⌘ を押したまま C を 2 回でも、一度離してから ⌘C ⌘C でも反応する。",
  clipboard: `クリップボード監視中。${MOD_KEY} を一度離してから、もう一度 ${COPY_KEY}。${MOD_KEY} を押したまま C を 2 回は反応しない（2 回目がキーリピート扱いになり、コピー元アプリがクリップボードに書き込まないため）。`,
  none: `本来は ${COPY_KEY} を 2 回だが、いまは検出器が動いていないので反応しない。`,
};

/**
 * "It doesn't fire" has several possible stages of failure, so show the raw
 * counters: whether the watcher is polling, whether the OS counter moves at
 * all, and whether presses are being paired up.
 */
async function refreshDiagnostics() {
  let status: WatchStatus;
  try {
    status = await invoke<WatchStatus>("clipboard_status");
  } catch {
    return;
  }

  const keyboard = status.source === "keyboard";
  el.diagRunning.textContent = {
    keyboard: "キーボード監視",
    clipboard: "クリップボード監視",
    none: "停止中",
  }[status.source];
  el.diagRunning.classList.toggle("is-ok", keyboard);
  el.diagRunning.classList.toggle("is-error", status.source === "none");

  el.doubleCopyGesture.textContent = GESTURE_TEXT[status.source];

  // The counter is what the clipboard detector reads; under keyboard monitoring
  // it is not consulted at all, so the rows would only be a permanent dash.
  el.diagRowCount.classList.toggle("hidden", keyboard);
  el.diagRowBursts.classList.toggle("hidden", keyboard);
  el.diagCount.textContent = String(status.changeCount);
  el.diagCopies.textContent = String(status.copiesSeen);
  el.diagBursts.textContent = String(status.burstsIgnored);
  el.diagDoubles.textContent = String(status.doublesFired);

  // Only offer the permission path where it exists and is not already granted.
  el.permissionPrompt.classList.toggle(
    "hidden",
    !status.needsPermission || !el.setDoubleCopy.checked,
  );

  // The main pane asks off the saved setting rather than the checkbox: it is
  // read while the settings pane is closed, where an unsaved tick means nothing.
  el.permissionBanner.classList.toggle(
    "hidden",
    !status.needsPermission || !status.enabled || permissionDismissed,
  );
  el.permissionBannerText.textContent =
    status.burstsIgnored > 0
      ? `他のアプリ（音声入力ソフトなど）がクリップボードを書き換えていて、${status.burstsIgnored} 回それを無視した。取りこぼしや誤爆があるなら、アクセシビリティを許可するとキー入力そのものを見るようになるので起きなくなる。`
      : `いまはクリップボード監視。${MOD_KEY} を押したまま C を 2 回は反応しない。アクセシビリティを許可するとキーボード監視に切り替わり、押したままでも反応する。`;

  if (status.source === "none") {
    el.diagHint.textContent = "検出器が動いていない。起動直後なら数秒待つ。";
  } else if (status.copiesSeen === 0 && status.burstsIgnored > 0) {
    el.diagHint.textContent = `クリップボードは動いているが、すべて他アプリの一括書き込みとして無視した（音声入力ソフトなど）。手で ${COPY_KEY} を押すと検出回数が増える。`;
  } else if (status.copiesSeen === 0) {
    el.diagHint.textContent = keyboard
      ? `この画面を開いたまま他のアプリで ${COPY_KEY} を押すと、検出回数が増える。`
      : `この画面を開いたまま ${COPY_KEY} を押すと、検出回数が増える。増えないならコピー元アプリがクリップボードに書き込んでいない。`;
  } else if (status.doublesFired === 0) {
    el.diagHint.textContent =
      "コピーは見えているが 2 回目として繋がっていない。猶予を延ばす。";
  } else {
    el.diagHint.textContent = "2 回目まで検出できている。";
  }
}

/**
 * How often the counters are re-read, per pane. The settings pane puts the raw
 * numbers on screen and they are meant to move as you press keys; the main pane
 * only needs the permission banner to turn up, which can take its time. The
 * setup pane shows neither.
 */
const DIAG_INTERVAL: Partial<Record<Pane, number>> = {
  settings: 300,
  translate: 2000,
};

function setDiagnosticsPolling(pane: Pane) {
  window.clearInterval(diagTimer);
  diagTimer = undefined;

  const interval = doubleCopySupported ? DIAG_INTERVAL[pane] : undefined;
  if (!interval) return;

  void refreshDiagnostics();
  diagTimer = window.setInterval(refreshDiagnostics, interval);
}

function readSettingsFromUi(): Settings {
  return {
    claude_bin: el.setClaudeBin.value.trim() || "claude",
    model: el.model.value || DEFAULT_MODEL,
    source_lang: el.sourceLang.value,
    target_lang: el.targetLang.value,
    tone: el.tone.value,
    double_copy_enabled: doubleCopySupported && el.setDoubleCopy.checked,
    double_copy_window_ms: Math.min(
      2000,
      Math.max(150, Number(el.setDoubleCopyWindow.value) || 600),
    ),
    auto_copy_result: el.setAutoCopy.checked,
    timeout_secs: Math.min(600, Math.max(5, Number(el.setTimeout.value) || 30)),
  };
}

async function persist(next: Settings): Promise<void> {
  settings = await invoke<Settings>("save_settings", { settings: next });
  applySettingsToUi();
}

/** Persist a translate-pane choice without touching the settings pane. */
async function persistChoice() {
  await persist({
    ...settings,
    source_lang: el.sourceLang.value,
    target_lang: el.targetLang.value,
    tone: el.tone.value,
    model: el.model.value || settings.model,
  });
}

// ---------------------------------------------------------------- translate

async function translate(text: string) {
  const trimmed = text.trim();
  // ⌘Enter is still live while the setup pane is up, and there is no CLI to ask.
  if (!trimmed || busy || blocked) return;

  setBusy(true);
  // The spinner carries the "working on it"; a stale result underneath it would
  // only muddy which text is which.
  setStatus(el.status, "");
  el.output.classList.remove("is-error");
  el.output.value = "";

  const streamId = ++streamSeq;
  activeStream = streamId;
  streamed = "";

  try {
    const result = await invoke<TranslateResult>("translate", {
      text: trimmed,
      sourceLang: el.sourceLang.value,
      targetLang: el.targetLang.value,
      tone: el.tone.value,
      streamId,
    });
    // The box already holds the streamed fragments, but the finished text is the
    // authoritative one — it is trimmed, and it is whole even if the first
    // fragments arrived before the listener was attached.
    el.output.value = result.text;
    // The box gives a little shake as the text drops in, so a result that
    // arrives while you are looking elsewhere still announces itself.
    jiggle(el.output);
    setStatus(
      el.status,
      `${result.model} · ${(result.elapsed_ms / 1000).toFixed(1)}s`,
      "ok",
    );
    if (settings.auto_copy_result) {
      await writeClipboard(result.text);
    }
  } catch (err) {
    el.output.classList.add("is-error");
    el.output.value = String(err);
    setStatus(el.status, "失敗", "error");
  } finally {
    activeStream = 0;
    setBusy(false);
  }
}

// ---------------------------------------------------------------- panes

type Pane = "translate" | "settings" | "setup";

function showPane(pane: Pane) {
  el.paneTranslate.classList.toggle("hidden", pane !== "translate");
  el.paneSettings.classList.toggle("hidden", pane !== "settings");
  el.paneSetup.classList.toggle("hidden", pane !== "setup");
  // The counters are only worth polling while something reads them.
  setDiagnosticsPolling(pane);
  if (pane === "settings") {
    el.setClaudeBin.focus();
  } else if (pane === "translate") {
    el.input.focus();
  }
}

/**
 * Where dismissing a pane lands. With no usable CLI the translate pane has
 * nothing to offer, so setup takes its place as the app's resting state.
 */
const homePane = (): Pane => (blocked ? "setup" : "translate");

// ------------------------------------------------------------------ cli state

/** Why translation is impossible right now, or null when it is fine. */
interface CliBlock {
  head: string;
  lead: string;
  /** Raw detail — a path, an error string — kept out of the main wording. */
  detail: string;
  /** Whether installing is the fix, as opposed to updating. */
  install: boolean;
}

let blocked: CliBlock | null = null;

/**
 * Probes the CLI and works out whether it can translate. Only updates state and
 * wording; moving to a pane is the caller's decision, so re-checking from the
 * settings pane does not yank the user out of it.
 */
async function probeCli(candidate?: Settings): Promise<CliBlock | null> {
  let status: CliStatus;
  try {
    status = await invoke<CliStatus>("check_cli", {
      settings: candidate ?? settings,
    });
  } catch (err) {
    el.backendBadge.textContent = "claude 未検出";
    el.apiKeyWarning.classList.add("hidden");
    return {
      head: "Claude Code が必要です",
      lead:
        "翻訳は手元の claude CLI に投げているので、Claude Code が入っていて" +
        "ログイン済みである必要があります。API キーは要りません。",
      detail: String(err),
      install: true,
    };
  }

  el.apiKeyWarning.classList.toggle("hidden", !status.apiKeyInEnv);

  if (status.missingFlags.length) {
    el.backendBadge.textContent = `claude ${status.version} は古い`;
    return {
      head: "Claude Code が古すぎます",
      lead:
        `見つかった claude ${status.version} には、このアプリが渡している` +
        `オプションがありません（${status.missingFlags.join(" ")}）。` +
        "更新すれば使えます。",
      detail: status.path,
      install: false,
    };
  }

  el.backendBadge.textContent = `claude ${status.version}`;
  return null;
}

function renderSetup() {
  if (!blocked) return;
  el.setupHead.textContent = blocked.head;
  el.setupLead.textContent = blocked.lead;
  el.setupStepInstall.textContent = blocked.install
    ? "Claude Code をインストールする"
    : "Claude Code を更新する";
  el.setupDetail.textContent = blocked.detail;
  el.setupDetail.classList.toggle("hidden", !blocked.detail);
}

/** Re-probes and repaints the setup pane, leaving the current pane alone. */
async function revalidate(candidate?: Settings): Promise<CliBlock | null> {
  blocked = await probeCli(candidate);
  renderSetup();
  return blocked;
}

async function checkCli() {
  setStatus(el.settingsStatus, "確認中…");
  const problem = await revalidate(readSettingsFromUi());
  if (problem) {
    setStatus(el.settingsStatus, `${problem.head} — ${problem.detail}`, "error");
  } else {
    setStatus(el.settingsStatus, `${el.backendBadge.textContent} を検出`, "ok");
  }
}

// ---------------------------------------------------------------- wiring

fillSelect(el.sourceLang, LANGS);
fillSelect(el.targetLang, LANGS.filter(([value]) => value !== "auto"));
fillSelect(el.tone, TONES);
fillGroupedSelect(el.model, MODEL_GROUPS);

el.btnTranslate.addEventListener("click", () => translate(el.input.value));

el.input.addEventListener("input", syncOverflow);

el.btnCopy.addEventListener("click", async () => {
  // Copies whatever is in the box now, edits included.
  const text = el.output.value;
  if (!text) return;
  await writeClipboard(text);
  jiggle(el.output);
  setStatus(el.status, "コピーしました", "ok");
});

el.btnSwap.addEventListener("click", async () => {
  const from = el.sourceLang.value;
  const to = el.targetLang.value;
  // "auto" has no slot in the target list, so swapping into it is a no-op.
  if (from !== "auto") el.targetLang.value = from;
  el.sourceLang.value = to;
  jiggle(el.btnSwap);
  await persistChoice();
});

for (const control of [el.sourceLang, el.targetLang, el.tone, el.model]) {
  control.addEventListener("change", persistChoice);
}

// persistChoice repaints this too, but only after a round trip to disk — the
// warning should track the dropdown, not the save.
el.model.addEventListener("change", syncOverflow);

el.btnOpenAccessibility.addEventListener("click", () =>
  invoke("open_accessibility_settings"),
);

el.btnRecheckAccessibility.addEventListener("click", async () => {
  await invoke<WatchStatus>("recheck_accessibility");
  await refreshDiagnostics();
});

el.btnBannerAccessibility.addEventListener("click", () =>
  invoke("open_accessibility_settings"),
);

el.btnBannerDismiss.addEventListener("click", () => {
  permissionDismissed = true;
  el.permissionBanner.classList.add("hidden");
});

el.setDoubleCopy.addEventListener("change", () => {
  syncTriggerFields();
  if (el.setDoubleCopy.checked) void refreshDiagnostics();
});

el.btnSettings.addEventListener("click", () =>
  showPane(el.paneSettings.classList.contains("hidden") ? "settings" : homePane()),
);

el.btnSetupRecheck.addEventListener("click", async () => {
  setStatus(el.setupStatus, "確認中…");
  const problem = await revalidate();
  if (problem) {
    setStatus(el.setupStatus, "まだ見つかりません。", "error");
  } else {
    setStatus(el.setupStatus, "");
    showPane("translate");
  }
});

el.btnSetupDocs.addEventListener("click", () => invoke("open_setup_docs"));

el.btnSetupSettings.addEventListener("click", () => showPane("settings"));

el.btnSetupCopy.addEventListener("click", async () => {
  await writeClipboard(el.setupCommand.textContent ?? "");
  setStatus(el.setupStatus, "コマンドをコピーしました", "ok");
});
// Minimize parks the window in the taskbar/Dock, where it is still visible and
// clickable; ✕ hides it outright and leaves the tray icon as the way back.
el.btnMinimize.addEventListener("click", () => appWindow.minimize());
el.btnClose.addEventListener("click", () => appWindow.hide());
el.btnCheck.addEventListener("click", checkCli);

el.btnSave.addEventListener("click", async () => {
  try {
    await persist(readSettingsFromUi());
    setStatus(el.settingsStatus, "保存しました", "ok");
    // A newly saved path is the usual fix for a CLI that was not found, so the
    // block is re-evaluated against it rather than left stale.
    await revalidate();
  } catch (err) {
    setStatus(el.settingsStatus, String(err), "error");
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    if (!el.paneSettings.classList.contains("hidden")) {
      showPane(homePane());
    } else {
      appWindow.hide();
    }
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    translate(el.input.value);
  }
});

// The translation as the model writes it. Waiting for the whole thing before
// showing anything is the difference between "2 seconds" and "20 seconds" on a
// long paste, so fragments go straight into the output box.
listen<DeltaPayload>("translate-delta", (event) => {
  // A run that has already been given up on (timed out, errored) must not keep
  // writing into the box behind the next one.
  if (event.payload.id !== activeStream) return;
  if (!streamed) setStreaming();
  streamed += event.payload.text;
  el.output.value = streamed;
  // Long results outgrow the box; follow the text rather than stranding the view
  // at the top.
  el.output.scrollTop = el.output.scrollHeight;
});

// The Rust side watches for the Accessibility permission being granted and
// promotes the detector by itself, so the switch can happen between two ticks of
// the poll above — or while the pane that is asking for it sits on screen.
listen("watch-source-changed", () => {
  void refreshDiagnostics();
});

// Fired by the Rust side when the ⌘C ⌘C gesture is detected. That gesture is an
// explicit "translate this", so it always does, unlike opening from the tray.
listen<TriggerPayload>("trigger-activated", async (event) => {
  // With no usable CLI the gesture still raises the window, but onto the setup
  // pane — there is nothing to paste the clipboard into.
  showPane(homePane());
  // The window arrives unasked-for over whatever you were doing, so the slab
  // lands with a wobble rather than just appearing. True of the setup pane too.
  jiggle(document.body);
  if (blocked) return;

  el.input.focus();
  el.input.select();

  const text = event.payload.text;
  if (!text || !text.trim()) return;

  el.input.value = text;
  // Assigning `value` fires no input event, so the warning has to be asked for.
  syncOverflow();
  await translate(text);
});

// ---------------------------------------------------------------- boot

(async () => {
  doubleCopySupported = await invoke<boolean>("platform_supports_double_copy");
  settings = await invoke<Settings>("get_settings");
  applySettingsToUi();

  // Two CLI probes have to come back before this resolves, so the window is
  // already up and the badge reads "…" while it happens.
  await revalidate();
  showPane(homePane());
})();
