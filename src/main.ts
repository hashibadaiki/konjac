import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  dismiss,
  fetchAdvisory,
  fetchLatestTag,
  isDismissed,
  type Advisory,
} from "./update";

// ---------------------------------------------------------------- types

interface Settings {
  google_translate_enabled: boolean;
  claude_bin: string;
  model: string;
  source_lang: string;
  target_lang: string;
  tone: string;
  double_copy_enabled: boolean;
  double_copy_window_ms: number;
  clipboard_auto_translate: boolean;
  auto_copy_result: boolean;
  timeout_secs: number;
  check_for_updates: boolean;
}

/** What the Rust side makes of the versions the frontend fetched. */
interface Verdict {
  current: string;
  /** A newer release exists. */
  outdated: boolean;
  /** This build is below the floor a published advisory sets. */
  blocked: boolean;
}

interface TranslateResult {
  text: string;
  provider: "google" | "claude";
  model: string;
  elapsed_ms: number;
  fallback_reason: string | null;
}

interface GoogleApiKeyStatus {
  configured: boolean;
  source: "environment" | "keychain" | "none";
  canStore: boolean;
}

interface TriggerPayload {
  text: string | null;
  /** Which detector fired — see `TRIGGER_KEYBOARD` / `TRIGGER_CLIPBOARD`. */
  source: "keyboard" | "clipboard";
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
  /** `null` when the CLI is too old to be asked whether it has a session. */
  loggedIn: boolean | null;
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
const RUN_KEY = IS_MAC ? "⌘Enter" : "Ctrl+Enter";

// ---------------------------------------------------------------- dom

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element: #${id}`);
  return el as T;
};

const el = {
  backendBadge: $<HTMLSpanElement>("backend-badge"),
  btnHome: $<HTMLButtonElement>("btn-home"),
  btnSettings: $<HTMLButtonElement>("btn-settings"),
  btnMinimize: $<HTMLButtonElement>("btn-minimize"),
  btnClose: $<HTMLButtonElement>("btn-close"),

  paneTranslate: $<HTMLElement>("pane-translate"),
  paneSettings: $<HTMLElement>("pane-settings"),
  paneSetup: $<HTMLElement>("pane-setup"),
  paneAdvisory: $<HTMLElement>("pane-advisory"),
  paneWelcome: $<HTMLElement>("pane-welcome"),

  welcomeGesture: $<HTMLSpanElement>("welcome-gesture"),
  welcomeStatus: $<HTMLParagraphElement>("welcome-status"),
  btnWelcomeEnable: $<HTMLButtonElement>("btn-welcome-enable"),
  btnWelcomeSkip: $<HTMLButtonElement>("btn-welcome-skip"),

  apiKeyWarning: $<HTMLParagraphElement>("api-key-warning"),
  loginWarning: $<HTMLParagraphElement>("login-warning"),

  updateBanner: $<HTMLDivElement>("update-banner"),
  updateBannerText: $<HTMLParagraphElement>("update-banner-text"),
  btnUpdateGet: $<HTMLButtonElement>("btn-update-get"),
  btnUpdateDismiss: $<HTMLButtonElement>("btn-update-dismiss"),

  advisoryLead: $<HTMLParagraphElement>("advisory-lead"),
  advisoryMessage: $<HTMLParagraphElement>("advisory-message"),
  advisoryStatus: $<HTMLParagraphElement>("advisory-status"),
  btnAdvisoryGet: $<HTMLButtonElement>("btn-advisory-get"),
  btnAdvisoryDetails: $<HTMLButtonElement>("btn-advisory-details"),

  permissionBanner: $<HTMLDivElement>("permission-banner"),
  permissionBannerText: $<HTMLParagraphElement>("permission-banner-text"),
  permissionBannerDup: $<HTMLParagraphElement>("permission-banner-dup"),
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
  confirmHint: $<HTMLParagraphElement>("confirm-hint"),
  confirmHintKey: $<HTMLSpanElement>("confirm-hint-key"),
  output: $<HTMLTextAreaElement>("output"),
  status: $<HTMLSpanElement>("status"),

  loading: $<HTMLDivElement>("loading"),
  loadingLabel: $<HTMLSpanElement>("loading-label"),
  loadingElapsed: $<HTMLSpanElement>("loading-elapsed"),

  btnTranslate: $<HTMLButtonElement>("btn-translate"),
  btnCopy: $<HTMLButtonElement>("btn-copy"),

  setGoogleEnabled: $<HTMLInputElement>("set-google-enabled"),
  googleApiKey: $<HTMLInputElement>("google-api-key"),
  btnGoogleSave: $<HTMLButtonElement>("btn-google-save"),
  btnGoogleDelete: $<HTMLButtonElement>("btn-google-delete"),
  googleKeyStatus: $<HTMLSpanElement>("google-key-status"),
  setClaudeBin: $<HTMLInputElement>("set-claude-bin"),
  setDoubleCopy: $<HTMLInputElement>("set-double-copy"),
  consentPrompt: $<HTMLDivElement>("consent-prompt"),
  btnConsentAgree: $<HTMLButtonElement>("btn-consent-agree"),
  btnConsentDecline: $<HTMLButtonElement>("btn-consent-decline"),
  doubleCopyPrivacy: $<HTMLParagraphElement>("double-copy-privacy"),
  setClipboardAuto: $<HTMLInputElement>("set-clipboard-auto"),
  fieldClipboardAuto: $<HTMLLabelElement>("field-clipboard-auto"),
  clipboardAutoNote: $<HTMLParagraphElement>("clipboard-auto-note"),
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
  appVersion: $<HTMLSpanElement>("app-version"),
  setUpdateCheck: $<HTMLInputElement>("set-update-check"),
  btnCheckUpdate: $<HTMLButtonElement>("btn-check-update"),
  updateStatus: $<HTMLSpanElement>("update-status"),
  btnCheck: $<HTMLButtonElement>("btn-check"),
  settingsStatus: $<HTMLSpanElement>("settings-status"),
};

// ---------------------------------------------------------------- state

let settings: Settings;
let googleKeyStatus: GoogleApiKeyStatus | null = null;
let busy = false;
let doubleCopySupported = false;
/**
 * Whether the user has been shown what enabling the gesture reads and sends,
 * and agreed to it. Persisted on the Rust side, which also refuses to save the
 * flag as on without it — this copy only decides whether ticking the box has to
 * put the disclosure up first.
 */
let clipboardConsent = false;
/**
 * Whether the main pane's permission banner has been waved off. Session-only:
 * the ask is still true next launch, and dropping it for good would leave the
 * settings pane as the only place it is ever made again.
 */
let permissionDismissed = false;
/**
 * Whether the user has been sent to the permission pane at least once this
 * session. The ask that follows — which of the identically named rows to switch
 * on — only makes sense to someone who is looking at that list, and putting it
 * in front of everyone else would bury the one sentence that does.
 */
let permissionAsked = false;
/**
 * Whether the first-launch question about the gesture is still unanswered. It
 * outranks the translate pane while it is (see `homePane`), because it is the
 * one thing this app cannot decide on the user's behalf and the one thing they
 * would otherwise have to go looking for.
 */
let firstRunPending = false;

/** This build's own version, asked for once at boot. */
let appVersion = "";
/**
 * The newest published tag, once a check has found one. Kept so the "あとで"
 * button knows which version it is waving off.
 */
let latestTag: string | null = null;
/**
 * Set when a published advisory says this build must not keep being used. It
 * outranks everything else on screen: see `homePane`, and the refusal at the
 * top of `translate`.
 */
let advisory: Advisory | null = null;

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

  el.loadingLabel.textContent = googleFastPathSelected()
    ? "Google NMT で翻訳しています…"
    : `${el.model.value} で翻訳しています…`;
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
 * The note saying a gesture filled the box on purpose without sending it.
 *
 * Put up only by the clipboard detector's path, and taken down by anything that
 * answers it: translating, or typing something else into the box. The 翻訳
 * button wobbles as it appears, because the note explains where to look and the
 * button is the thing being looked for.
 */
function setConfirmHint(show: boolean) {
  el.confirmHint.classList.toggle("hidden", !show);
  if (show) jiggle(el.btnTranslate);
}

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

/** Mirrors the Rust eligibility check so the loading label names the route. */
function googleFastPathSelected() {
  const text = el.input.value.trim();
  return (
    settings?.google_translate_enabled &&
    googleKeyStatus?.configured &&
    el.tone.value === "default" &&
    Array.from(text).length <= 5_000 &&
    !text.includes("`") &&
    !text.includes("~~~") &&
    !text.includes("http://") &&
    !text.includes("https://")
  );
}

// ---------------------------------------------------------------- settings

/**
 * Writes a value back into a field, unless the user is in the middle of typing
 * in it. Saving is what repaints this pane now, and saving happens while the
 * caret is still in the box: a trimmed or clamped value going back in mid-word
 * would move the caret and eat the rest of what was being typed.
 */
function setFieldValue(input: HTMLInputElement, value: string) {
  if (document.activeElement === input) return;
  input.value = value;
}

function applySettingsToUi() {
  el.sourceLang.value = settings.source_lang;
  el.targetLang.value = settings.target_lang;
  el.tone.value = settings.tone;
  selectWithFallback(el.model, settings.model);

  el.setGoogleEnabled.checked = settings.google_translate_enabled;
  setFieldValue(el.setClaudeBin, settings.claude_bin);
  el.setDoubleCopy.checked = settings.double_copy_enabled;
  setFieldValue(el.setDoubleCopyWindow, String(settings.double_copy_window_ms));
  el.setClipboardAuto.checked = settings.clipboard_auto_translate;
  el.setAutoCopy.checked = settings.auto_copy_result;
  setFieldValue(el.setTimeout, String(settings.timeout_secs));
  el.setUpdateCheck.checked = settings.check_for_updates;

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
  // What it reads and where that goes stays on screen for as long as it is on:
  // the disclosure is shown once, but the answer has to be findable afterwards.
  el.doubleCopyPrivacy.classList.toggle("hidden", !showDoubleCopy);
  el.fieldClipboardAuto.classList.toggle("hidden", !showDoubleCopy);
  el.clipboardAutoNote.classList.toggle("hidden", !showDoubleCopy);
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
  // Granting it is one click, so someone still reading this banner after going
  // to look has most likely switched on the wrong row: the permission is
  // recorded per executable, and a machine that also builds this app has a
  // second one by the same name.
  el.permissionBannerDup.classList.toggle("hidden", !permissionAsked);

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
    google_translate_enabled: el.setGoogleEnabled.checked,
    claude_bin: el.setClaudeBin.value.trim() || "claude",
    model: el.model.value || DEFAULT_MODEL,
    source_lang: el.sourceLang.value,
    target_lang: el.targetLang.value,
    tone: el.tone.value,
    // The Rust side applies the same three conditions before it stores this —
    // supported, ticked, consented — so a stale `clipboardConsent` here cannot
    // turn the watcher on.
    double_copy_enabled:
      doubleCopySupported && el.setDoubleCopy.checked && clipboardConsent,
    double_copy_window_ms: Math.min(
      2000,
      Math.max(150, Number(el.setDoubleCopyWindow.value) || 600),
    ),
    clipboard_auto_translate: el.setClipboardAuto.checked,
    auto_copy_result: el.setAutoCopy.checked,
    timeout_secs: Math.min(600, Math.max(5, Number(el.setTimeout.value) || 30)),
    check_for_updates: el.setUpdateCheck.checked,
  };
}

async function persist(next: Settings): Promise<void> {
  settings = await invoke<Settings>("save_settings", { settings: next });
  applySettingsToUi();
}

/**
 * Commits the settings pane as it stands.
 *
 * There is no save button: every control here writes through as it is touched,
 * the way the language and model dropdowns on the translate pane always have.
 * A pane whose switches only pretend to be switches until a button is pressed
 * is the surprising one — particularly for the gesture, where an unsaved tick
 * looks exactly like a feature that has been turned on and is not working.
 */
async function commitSettings() {
  const previousBin = settings.claude_bin;
  const previousGoogle = settings.google_translate_enabled;
  try {
    await persist(readSettingsFromUi());
    setStatus(el.settingsStatus, "保存しました", "ok");
  } catch (err) {
    setStatus(el.settingsStatus, String(err), "error");
    return;
  }
  // A new path is the usual fix for a CLI that was not found, so the block is
  // re-evaluated against it — but only when it is the path that moved, since
  // probing spawns a process and every other field here saves without one.
  if (
    settings.claude_bin !== previousBin ||
    settings.google_translate_enabled !== previousGoogle
  ) {
    await revalidate();
  }
}

let saveTimer: number | undefined;

/**
 * `delay` is what separates a checkbox from a text field: a tick is a finished
 * decision, whereas a half-typed path would otherwise be saved a character at a
 * time (and probed for, at that).
 */
function scheduleSave(delay = 0) {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void commitSettings(), delay);
}

/** How long a field has to sit still before a keystroke counts as a decision. */
const TYPING_SETTLE_MS = 600;

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
  // ⌘Enter is still live while the setup pane is up, and there is no route to ask.
  // A withdrawn build refuses here too: the pane is what says so, this is what
  // makes it true — including for the ⌘C ⌘C path, which never sees a pane.
  if (!trimmed || busy || blocked || advisory) return;

  setBusy(true);
  // The spinner carries the "working on it"; a stale result underneath it would
  // only muddy which text is which.
  setStatus(el.status, "");
  el.status.title = "";
  // Whatever it was waiting to be asked, it has now been asked.
  setConfirmHint(false);
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
      `${result.provider === "google" ? "Google NMT" : result.model}${
        result.fallback_reason ? "（Google から切替）" : ""
      } · ${(result.elapsed_ms / 1000).toFixed(1)}s`,
      "ok",
    );
    // The compact status line names the switch; the full reason remains
    // available without crowding the translation pane.
    el.status.title = result.fallback_reason ?? "";
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

type Pane = "translate" | "settings" | "setup" | "advisory" | "welcome";

function showPane(pane: Pane) {
  el.paneTranslate.classList.toggle("hidden", pane !== "translate");
  el.paneSettings.classList.toggle("hidden", pane !== "settings");
  el.paneSetup.classList.toggle("hidden", pane !== "setup");
  el.paneAdvisory.classList.toggle("hidden", pane !== "advisory");
  el.paneWelcome.classList.toggle("hidden", pane !== "welcome");
  // The counters are only worth polling while something reads them.
  setDiagnosticsPolling(pane);
  if (pane === "settings") {
    // Leaving the pane is an answer of sorts: the disclosure comes back the
    // next time the box is ticked, rather than sitting there half-answered.
    el.consentPrompt.classList.add("hidden");
    el.setClaudeBin.focus();
  } else if (pane === "translate") {
    el.input.focus();
  }
}

/**
 * Where dismissing a pane lands. With no usable translation route the pane has
 * nothing to offer, so setup takes its place as the app's resting state — and a
 * withdrawn build has less to offer still, so the advisory outranks even that.
 *
 * The first-launch question sits above both of those but below the advisory: it
 * is asked before the app has been used at all, and answering it is two clicks,
 * whereas installing Claude Code is a trip to a terminal that the answer does
 * not depend on.
 */
const homePane = (): Pane =>
  advisory
    ? "advisory"
    : firstRunPending
      ? "welcome"
      : blocked
        ? "setup"
        : "translate";

/**
 * Records that the first-launch question has been put to the user, whichever
 * way they answered it — including by way of the settings pane's own consent
 * prompt, which is the same question asked somewhere else.
 */
async function answerFirstRun() {
  if (!firstRunPending) return;
  firstRunPending = false;
  await invoke("mark_first_run_answered").catch(() => {});
}

// ------------------------------------------------------------------ cli state

/** Why the Claude route is impossible right now, or null when it is fine. */
interface CliBlock {
  head: string;
  lead: string;
  /** Raw detail — a path, an error string — kept out of the main wording. */
  detail: string;
  /** Whether installing is the fix, as opposed to updating. */
  install: boolean;
}

let blocked: CliBlock | null = null;

/** The last answer `check_cli` gave, for the bits `CliBlock` does not carry. */
let cliStatus: CliStatus | null = null;

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
    cliStatus = status;
  } catch (err) {
    cliStatus = null;
    el.backendBadge.textContent = "claude 未検出";
    el.apiKeyWarning.classList.add("hidden");
    el.loginWarning.classList.add("hidden");
    return {
      head: "翻訳の接続設定が必要です",
      lead:
        "Google Cloud Translation API キーを設定するか、Claude Code を入れて" +
        "ログインしてください。両方あれば Google を高速経路、Claude をフォールバックに使います。",
      detail: String(err),
      install: true,
    };
  }

  el.apiKeyWarning.classList.toggle("hidden", !status.apiKeyInEnv);
  // `null` is "could not ask", which is not the same as "signed out" and must
  // not put a warning on screen the user cannot act on.
  el.loginWarning.classList.toggle("hidden", status.loggedIn !== false);

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

  // Signed out is worth saying in the title bar too: the CLI is there and new
  // enough, so every other signal on screen reads as ready.
  el.backendBadge.textContent =
    status.loggedIn === false
      ? `claude ${status.version} · 未ログイン`
      : `claude ${status.version}`;
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
  const next = candidate ?? settings;
  const cliProblem = await probeCli(next);
  const googleReady =
    next.google_translate_enabled && !!googleKeyStatus?.configured;
  // Google is a usable primary route on its own. Claude remains valuable as a
  // fallback, but its absence must not replace a working translate pane with
  // the setup screen.
  blocked = googleReady ? null : cliProblem;
  if (googleReady) {
    el.backendBadge.textContent = cliProblem
      ? "Google NMT"
      : `Google NMT → claude ${cliStatus?.version ?? "?"}`;
  }
  renderSetup();
  return cliProblem;
}

/**
 * What the "Claude Code を確認" button reports.
 *
 * The version used to be the whole answer, which is how this could say
 * everything was fine while the session behind it had expired — the failure
 * that sends someone to press it in the first place. `loggedIn` is the part
 * worth pressing for; `null` means the CLI predates `claude auth status`, and
 * claiming either way would be worse than saying nothing.
 */
async function checkCli() {
  setStatus(el.settingsStatus, "確認中…");
  const problem = await revalidate(readSettingsFromUi());
  if (problem) {
    setStatus(el.settingsStatus, `${problem.head} — ${problem.detail}`, "error");
    return;
  }

  const found = `claude ${cliStatus?.version ?? "?"}`;
  if (cliStatus?.loggedIn === false) {
    setStatus(el.settingsStatus, `${found} · ログインしていません`, "error");
  } else if (cliStatus?.loggedIn) {
    setStatus(el.settingsStatus, `${found} · ログイン済み`, "ok");
  } else {
    setStatus(el.settingsStatus, `${found} を検出`, "ok");
  }
}

function renderGoogleKeyStatus() {
  const status = googleKeyStatus;
  if (!status?.configured) {
    setStatus(el.googleKeyStatus, "未設定");
  } else if (status.source === "environment") {
    setStatus(
      el.googleKeyStatus,
      "環境変数 GOOGLE_TRANSLATE_API_KEY から設定済み",
      "ok",
    );
  } else {
    setStatus(el.googleKeyStatus, "OS の資格情報ストアに保存済み", "ok");
  }

  el.googleApiKey.disabled = status?.canStore === false;
  el.btnGoogleSave.disabled = status?.canStore === false;
  el.btnGoogleDelete.disabled = status?.source !== "keychain";
}

async function refreshGoogleKeyStatus() {
  try {
    googleKeyStatus = await invoke<GoogleApiKeyStatus>("google_api_key_status");
    renderGoogleKeyStatus();
  } catch (err) {
    googleKeyStatus = null;
    setStatus(el.googleKeyStatus, String(err), "error");
  }
}

// ------------------------------------------------------------------ updates

/**
 * The "a newer version exists" banner. Never shown next to an advisory: being
 * told an update is available is noise beside being told to stop.
 */
function renderUpdateBanner() {
  const show = !!latestTag && !advisory && !isDismissed(latestTag);
  el.updateBanner.classList.toggle("hidden", !show);
  if (!show) return;
  el.updateBannerText.textContent = `新しいバージョン ${latestTag} が出ています（いまは ${appVersion}）。`;
}

function renderAdvisory() {
  if (!advisory) return;
  el.advisoryLead.textContent =
    `いま入っている ${appVersion} に、使い続けないほうがよい問題が見つかりました。` +
    "翻訳は止めてあります。新しい版に入れ替えてください。";
  // `textContent`, not `innerHTML`: this wording came off the network.
  el.advisoryMessage.textContent = advisory.message ?? "";
  el.advisoryMessage.classList.toggle("hidden", !advisory.message);
  el.btnAdvisoryDetails.classList.toggle("hidden", !advisory.url);
}

/**
 * Asks GitHub what the newest release is, and whether this build has been
 * withdrawn.
 *
 * Every fetch behind this fails open (see `update.ts`), so a launch that cannot
 * reach the network behaves exactly as it did before any of this existed.
 * `manual` is the button in the settings pane, which ignores both the
 * once-a-day cache and the setting — pressing it *is* the user asking.
 */
async function runUpdateCheck(manual = false) {
  if (manual) setStatus(el.updateStatus, "確認中…");

  // The advisory is asked for on every launch and whatever the setting says.
  const published = await fetchAdvisory();
  const wantsNotice = manual || settings.check_for_updates;
  const release = wantsNotice ? await fetchLatestTag(manual) : null;
  const newest = release?.tag ?? null;

  let verdict: Verdict;
  try {
    verdict = await invoke<Verdict>("check_versions", {
      latest: newest,
      minimum: published?.minimumVersion ?? null,
    });
  } catch {
    if (manual) setStatus(el.updateStatus, "確認できませんでした", "error");
    return;
  }

  latestTag = verdict.outdated ? newest : null;

  const wasBlocked = !!advisory;
  advisory = verdict.blocked ? published : null;
  renderAdvisory();
  renderUpdateBanner();

  // Being pulled out of whatever pane you were on is the point — a stop notice
  // that can sit unread behind the pane you were using is not a stop. Only on
  // the way in, so a later re-check does not keep yanking; and on the way out,
  // so lifting an advisory hands the app back rather than stranding the pane.
  if (advisory && !wasBlocked) {
    // Refusing to translate is half a stop. The watcher is what reads the
    // clipboard at all, so it stands down too — for this run only, so lifting
    // the advisory hands the setting back rather than making the user re-tick.
    await invoke("halt_watching").catch(() => {});
    showPane("advisory");
  }
  if (!advisory && wasBlocked) showPane(homePane());

  if (!manual) return;
  if (verdict.blocked) {
    setStatus(el.updateStatus, "このバージョンは使えません", "error");
  } else if (verdict.outdated) {
    setStatus(el.updateStatus, `${newest} が出ています`, "ok");
  } else if (release?.reached && newest) {
    setStatus(el.updateStatus, `最新です（${appVersion}）`, "ok");
  } else if (release?.reached) {
    // GitHub answered and had nothing to report: no release is published yet
    // (drafts and pre-releases do not count as one). Nothing is wrong, so this
    // must not read as a failure — which is what it did before.
    setStatus(
      el.updateStatus,
      `公開された版はまだありません（${appVersion}）`,
      "ok",
    );
  } else {
    setStatus(el.updateStatus, "GitHub に接続できませんでした", "error");
  }
}

// ---------------------------------------------------------------- wiring

fillSelect(el.sourceLang, LANGS);
fillSelect(el.targetLang, LANGS.filter(([value]) => value !== "auto"));
fillSelect(el.tone, TONES);
fillGroupedSelect(el.model, MODEL_GROUPS);

el.btnTranslate.addEventListener("click", () => translate(el.input.value));

el.input.addEventListener("input", () => {
  syncOverflow();
  // The note is about the text the gesture put here; typing over it makes it
  // someone else's text, and the note stale.
  setConfirmHint(false);
});

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

/**
 * Both places that offer the permission — the banner on the main pane and the
 * settings pane's prompt — go through here, so the follow-up about which of the
 * identically named rows to switch on is armed by either of them.
 */
function openAccessibilitySettings() {
  permissionAsked = true;
  void refreshDiagnostics();
  return invoke("open_accessibility_settings");
}

el.btnOpenAccessibility.addEventListener("click", openAccessibilitySettings);

el.btnRecheckAccessibility.addEventListener("click", async () => {
  await invoke<WatchStatus>("recheck_accessibility");
  await refreshDiagnostics();
});

el.btnBannerAccessibility.addEventListener("click", openAccessibilitySettings);

el.btnBannerDismiss.addEventListener("click", () => {
  permissionDismissed = true;
  el.permissionBanner.classList.add("hidden");
});

// Ticking the box is a request to turn it on, not the act of turning it on:
// until the disclosure has been accepted the tick is undone and the disclosure
// takes its place, so there is no state in which the clipboard is being read by
// a user who has not been told so.
el.setDoubleCopy.addEventListener("change", () => {
  if (el.setDoubleCopy.checked && !clipboardConsent) {
    el.setDoubleCopy.checked = false;
    el.consentPrompt.classList.remove("hidden");
    syncTriggerFields();
    return;
  }
  el.consentPrompt.classList.add("hidden");
  syncTriggerFields();
  if (el.setDoubleCopy.checked) void refreshDiagnostics();
  scheduleSave();
});

el.btnConsentAgree.addEventListener("click", async () => {
  await invoke("grant_clipboard_consent");
  clipboardConsent = true;
  // Agreeing is only reached by ticking the box, so it is that tick being
  // answered — the gesture goes on now rather than waiting for a second act.
  await answerFirstRun();
  el.consentPrompt.classList.add("hidden");
  el.setDoubleCopy.checked = true;
  syncTriggerFields();
  void refreshDiagnostics();
  await commitSettings();
});

el.btnConsentDecline.addEventListener("click", () => {
  el.consentPrompt.classList.add("hidden");
  el.setDoubleCopy.checked = false;
  syncTriggerFields();
});

// Everything else in the pane. Checkboxes commit on the spot; the two typed
// fields wait for the typing to stop, and again when the field is left, so
// tabbing away or pressing Enter does not sit on an unsaved keystroke.
for (const box of [
  el.setGoogleEnabled,
  el.setClipboardAuto,
  el.setAutoCopy,
  el.setUpdateCheck,
]) {
  box.addEventListener("change", () => scheduleSave());
}

el.btnGoogleSave.addEventListener("click", async () => {
  const apiKey = el.googleApiKey.value.trim();
  if (!apiKey) {
    setStatus(el.googleKeyStatus, "API キーを入力してください", "error");
    return;
  }

  el.btnGoogleSave.disabled = true;
  try {
    googleKeyStatus = await invoke<GoogleApiKeyStatus>("save_google_api_key", {
      apiKey,
    });
    el.googleApiKey.value = "";
    renderGoogleKeyStatus();
    await revalidate();
  } catch (err) {
    setStatus(el.googleKeyStatus, String(err), "error");
  } finally {
    el.btnGoogleSave.disabled = googleKeyStatus?.canStore === false;
  }
});

el.btnGoogleDelete.addEventListener("click", async () => {
  try {
    googleKeyStatus = await invoke<GoogleApiKeyStatus>("delete_google_api_key");
    renderGoogleKeyStatus();
    await revalidate();
  } catch (err) {
    setStatus(el.googleKeyStatus, String(err), "error");
  }
});

for (const field of [el.setClaudeBin, el.setDoubleCopyWindow, el.setTimeout]) {
  field.addEventListener("input", () => scheduleSave(TYPING_SETTLE_MS));
  field.addEventListener("change", () => scheduleSave());
  field.addEventListener("blur", () => scheduleSave());
}

el.btnSettings.addEventListener("click", () =>
  showPane(el.paneSettings.classList.contains("hidden") ? "settings" : homePane()),
);

// The name in the titlebar is the way back, the way a site's logo is.
el.btnHome.addEventListener("click", () => showPane(homePane()));

el.btnUpdateGet.addEventListener("click", () => invoke("open_releases_page"));

el.btnUpdateDismiss.addEventListener("click", () => {
  if (latestTag) dismiss(latestTag);
  el.updateBanner.classList.add("hidden");
});

el.btnAdvisoryGet.addEventListener("click", () => invoke("open_releases_page"));

el.btnAdvisoryDetails.addEventListener("click", async () => {
  if (!advisory?.url) return;
  try {
    // The Rust side checks the URL again before opening it, and says no by
    // returning an error rather than by quietly doing nothing.
    await invoke("open_advisory", { url: advisory.url });
  } catch (err) {
    setStatus(el.advisoryStatus, String(err), "error");
  }
});

el.btnCheckUpdate.addEventListener("click", () => runUpdateCheck(true));

el.btnSetupRecheck.addEventListener("click", async () => {
  setStatus(el.setupStatus, "確認中…");
  const problem = await revalidate();
  if (problem) {
    setStatus(el.setupStatus, "まだ見つかりません。", "error");
  } else {
    setStatus(el.setupStatus, "");
    showPane(homePane());
  }
});

// The one place the gesture can be turned on without the settings pane. It does
// the whole of it — consent, the flag, and the save — because a first-launch
// question that answers "yes" by sending you somewhere else to finish is not an
// answer.
el.btnWelcomeEnable.addEventListener("click", async () => {
  el.btnWelcomeEnable.disabled = true;
  try {
    await invoke("grant_clipboard_consent");
    clipboardConsent = true;
    await persist({ ...settings, double_copy_enabled: true });
  } catch (err) {
    setStatus(el.welcomeStatus, String(err), "error");
    el.btnWelcomeEnable.disabled = false;
    return;
  }
  await answerFirstRun();
  showPane(homePane());
});

el.btnWelcomeSkip.addEventListener("click", async () => {
  await answerFirstRun();
  showPane(homePane());
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

// Fired by the Rust side when the ⌘C ⌘C gesture is detected.
//
// Whether that is an explicit "translate this" depends on which detector saw
// it. The keyboard monitor watched the user press ⌘C, so it is; the clipboard
// counter watched *something* write twice and cannot say what, so by default it
// only loads the box and waits for the user to press 翻訳 — a misread that
// merely shows you your own clipboard is a nuisance, one that sends it is not.
listen<TriggerPayload>("trigger-activated", async (event) => {
  // Answered or not, the previous gesture's note is not about this one.
  setConfirmHint(false);
  // With no usable CLI the gesture still raises the window, but onto the setup
  // pane — there is nothing to paste the clipboard into.
  showPane(homePane());
  // The window arrives unasked-for over whatever you were doing, so the slab
  // lands with a wobble rather than just appearing. True of the setup pane too.
  jiggle(document.body);
  // A withdrawn build shows the advisory and stops there — nothing gets put in
  // a box it is not going to translate. The watcher is stood down when the
  // advisory lands, so in practice this only catches a gesture already in
  // flight when it did.
  if (blocked || advisory) return;

  el.input.focus();
  el.input.select();

  const text = event.payload.text;
  if (!text || !text.trim()) return;

  el.input.value = text;
  // Assigning `value` fires no input event, so the warning has to be asked for.
  syncOverflow();

  const confirmed =
    event.payload.source === "keyboard" || settings.clipboard_auto_translate;
  if (!confirmed) {
    // The note says the rest. The status line is cleared rather than reused:
    // a "失敗" left over from the last run, sitting beside a box that has just
    // silently filled itself, is the worst reading available.
    setStatus(el.status, "");
    setConfirmHint(true);
    return;
  }
  await translate(text);
});

// ---------------------------------------------------------------- boot

(async () => {
  doubleCopySupported = await invoke<boolean>("platform_supports_double_copy");
  clipboardConsent = await invoke<boolean>("clipboard_consent");
  appVersion = await invoke<string>("app_version");
  el.appVersion.textContent = appVersion;
  el.welcomeGesture.textContent = COPY_KEY;
  el.confirmHintKey.textContent = RUN_KEY;
  settings = await invoke<Settings>("get_settings");
  await refreshGoogleKeyStatus();
  applySettingsToUi();

  // Asked on the first launch only, and only where there is something to
  // answer: a platform with no detector has no gesture to offer, and a user who
  // has already been through the disclosure has already been asked.
  firstRunPending =
    doubleCopySupported &&
    !clipboardConsent &&
    !(await invoke<boolean>("first_run_answered").catch(() => true));

  // Two CLI probes have to come back before this resolves, so the window is
  // already up and the badge reads "…" while it happens.
  await revalidate();
  showPane(homePane());

  // Last, and deliberately not awaited: this one goes to the network, and the
  // app has to be usable before it answers rather than after.
  void runUpdateCheck();
})();
