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
  /** `0.8b` / `2b` / `8b` / `31b` — see `models.rs`. */
  model_size: string;
  source_lang: string;
  target_lang: string;
  tone: string;
  double_copy_enabled: boolean;
  double_copy_window_ms: number;
  clipboard_auto_translate: boolean;
  auto_copy_result: boolean;
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
  /** The model size that answered. */
  model: string;
  /** Language codes actually used; see `plamo::direction`. */
  source: string | null;
  target: string;
  elapsedMs: number;
}

/** One model size, as `model_statuses` reports it. */
interface ModelStatus {
  size: string;
  label: string;
  approxBytes: number;
  installed: boolean;
  bytes: number | null;
  /** An interrupted download that the next one resumes. */
  partialBytes: number | null;
}

interface ModelsReport {
  models: ModelStatus[];
  /** The size being downloaded right now, if any. */
  downloading: string | null;
  dir: string;
}

/** `model-download` events. */
interface DownloadProgress {
  size: string;
  received: number;
  total: number;
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
  ["Italian", "Italiano"],
  ["Russian", "Русский"],
  ["Vietnamese", "Tiếng Việt"],
  ["Thai", "ไทย"],
  ["Indonesian", "Bahasa Indonesia"],
  ["Arabic", "العربية"],
];

/**
 * PLaMo 3 Translate takes a register for Japanese output and nothing else, so
 * this is the whole of the choice — and it is greyed out for other targets.
 */
const TONES: [string, string][] = [
  ["default", "文体: 自動"],
  ["polite", "です・ます"],
  ["plain", "だ・である"],
];

/** Only reached if the select somehow has no value; `settings.rs` has the same. */
const DEFAULT_MODEL = "2b";

const LANGUAGE_NAMES: Record<string, string> = {
  ja: "日本語",
  en: "英語",
};

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

  setupModel: $<HTMLSelectElement>("setup-model"),
  setupModelNote: $<HTMLParagraphElement>("setup-model-note"),
  setupProgress: $<HTMLDivElement>("setup-progress"),
  setupProgressBar: $<HTMLProgressElement>("setup-progress-bar"),
  setupProgressLabel: $<HTMLSpanElement>("setup-progress-label"),
  setupStatus: $<HTMLParagraphElement>("setup-status"),
  btnSetupDownload: $<HTMLButtonElement>("btn-setup-download"),
  btnSetupCancel: $<HTMLButtonElement>("btn-setup-cancel"),
  btnSetupLicense: $<HTMLButtonElement>("btn-setup-license"),

  sourceLang: $<HTMLSelectElement>("source-lang"),
  targetLang: $<HTMLSelectElement>("target-lang"),
  tone: $<HTMLSelectElement>("tone"),
  model: $<HTMLSelectElement>("model"),
  btnSwap: $<HTMLButtonElement>("btn-swap"),

  input: $<HTMLTextAreaElement>("input"),
  confirmHint: $<HTMLParagraphElement>("confirm-hint"),
  confirmHintKey: $<HTMLSpanElement>("confirm-hint-key"),
  output: $<HTMLTextAreaElement>("output"),
  status: $<HTMLSpanElement>("status"),

  loading: $<HTMLDivElement>("loading"),
  loadingLabel: $<HTMLSpanElement>("loading-label"),
  loadingElapsed: $<HTMLSpanElement>("loading-elapsed"),

  btnTranslate: $<HTMLButtonElement>("btn-translate"),
  btnCopy: $<HTMLButtonElement>("btn-copy"),

  modelList: $<HTMLDivElement>("model-list"),
  settingsProgress: $<HTMLDivElement>("settings-progress"),
  settingsProgressBar: $<HTMLProgressElement>("settings-progress-bar"),
  settingsProgressLabel: $<HTMLSpanElement>("settings-progress-label"),
  btnSettingsCancel: $<HTMLButtonElement>("btn-settings-cancel"),
  modelsStatus: $<HTMLParagraphElement>("models-status"),
  modelsDir: $<HTMLElement>("models-dir"),
  btnLicense: $<HTMLButtonElement>("btn-license"),
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
  appVersion: $<HTMLSpanElement>("app-version"),
  setUpdateCheck: $<HTMLInputElement>("set-update-check"),
  btnCheckUpdate: $<HTMLButtonElement>("btn-check-update"),
  updateStatus: $<HTMLSpanElement>("update-status"),
  settingsStatus: $<HTMLParagraphElement>("settings-status"),
};

// ---------------------------------------------------------------- state

let settings: Settings;
/** What is on disk, from the last `model_statuses`. */
let modelsReport: ModelsReport | null = null;
/** The latest progress of the download in flight, if one is. */
let downloadProgress: DownloadProgress | null = null;
/**
 * The model whose delete button has been pressed once. Deleting gigabytes is
 * not something to do on a single misclick, so the button asks again.
 */
let deleteArmed: string | null = null;
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
 * Nothing has arrived yet at this point — the first translation after launch
 * also waits for the model to be read in — so the wait needs something that
 * visibly moves rather than a static word: a spinner, which model is being
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

  el.loadingLabel.textContent = `${modelName(el.model.value)} で翻訳しています…`;
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

/** How a model is named on screen. */
const modelName = (size: string) => `PLaMo 3 ${size.toUpperCase()}`;

/**
 * The model only takes a register for Japanese output, so the dropdown is
 * greyed out for anything else rather than offering a choice that does nothing.
 */
function syncTone() {
  const japanese = el.targetLang.value === "Japanese";
  el.tone.disabled = !japanese;
  el.tone.title = japanese
    ? "訳文の文体"
    : "文体を選べるのは翻訳先が日本語のときだけ";
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
  el.model.value = settings.model_size;
  el.setupModel.value = settings.model_size;

  el.setDoubleCopy.checked = settings.double_copy_enabled;
  setFieldValue(el.setDoubleCopyWindow, String(settings.double_copy_window_ms));
  el.setClipboardAuto.checked = settings.clipboard_auto_translate;
  el.setAutoCopy.checked = settings.auto_copy_result;
  el.setUpdateCheck.checked = settings.check_for_updates;

  syncTriggerFields();
  syncTone();
  renderModels();
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
    model_size: el.model.value || DEFAULT_MODEL,
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
  try {
    await persist(readSettingsFromUi());
    setStatus(el.settingsStatus, "保存しました", "ok");
  } catch (err) {
    setStatus(el.settingsStatus, String(err), "error");
  }
}

let saveTimer: number | undefined;

/**
 * `delay` is what separates a checkbox from a text field: a tick is a finished
 * decision, whereas a half-typed number would otherwise be saved a character
 * at a time.
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
    model_size: el.model.value || settings.model_size,
  });
}

// ---------------------------------------------------------------- translate

async function translate(text: string) {
  const trimmed = text.trim();
  // ⌘Enter is still live while the setup pane is up, and there is no model to ask.
  // A withdrawn build refuses here too: the pane is what says so, this is what
  // makes it true — including for the ⌘C ⌘C path, which never sees a pane.
  if (!trimmed || busy || needsModel() || advisory) return;

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
    // Japanese text with the target on Japanese went to English instead, and
    // the status line is where that has to be said — the output box alone
    // would read as the app ignoring the dropdown.
    const flipped =
      el.targetLang.value === "Japanese" && result.target !== "ja"
        ? `（${LANGUAGE_NAMES[result.source ?? ""] ?? result.source} → ${
            LANGUAGE_NAMES[result.target] ?? result.target
          }）`
        : "";
    setStatus(
      el.status,
      `${modelName(result.model)}${flipped} · ${(result.elapsedMs / 1000).toFixed(1)}s`,
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
    deleteArmed = null;
    void refreshModels();
  } else if (pane === "translate") {
    el.input.focus();
  }
}

/**
 * Where dismissing a pane lands. With the selected model not downloaded the
 * translate pane has nothing to offer, so the download pane takes its place as
 * the app's resting state — and a withdrawn build has less to offer still, so
 * the advisory outranks even that.
 *
 * The first-launch question sits above the download but below the advisory: it
 * is asked before the app has been used at all, and answering it is two clicks,
 * whereas the download can take a while and does not depend on the answer.
 */
const homePane = (): Pane =>
  advisory
    ? "advisory"
    : firstRunPending
      ? "welcome"
      : needsModel()
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

// ------------------------------------------------------------------ models

const GB = 1_000_000_000;
const formatBytes = (bytes: number) =>
  bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / 1_000_000)} MB`;

const statusOf = (size: string) =>
  modelsReport?.models.find((model) => model.size === size);

/**
 * Whether the selected model has yet to be downloaded. Unknown — the report
 * has not come back — counts as fine, so a slow first answer does not flash
 * the download pane at someone who has the model already.
 */
const needsModel = () =>
  !!modelsReport && !statusOf(settings.model_size)?.installed;

/** The dropdown wording: the size, what it is for, and whether it is here. */
function modelOptionLabel(model: ModelStatus) {
  if (model.installed) return model.label;
  return `${model.label}（未ダウンロード・約 ${formatBytes(model.approxBytes)}）`;
}

function progressText(progress: DownloadProgress) {
  const ratio = progress.total ? progress.received / progress.total : 0;
  return `${modelName(progress.size)} · ${formatBytes(progress.received)} / ${formatBytes(
    progress.total,
  )}（${Math.floor(ratio * 100)}%）`;
}

/**
 * Repaints everything that depends on what is on disk: both dropdowns, the
 * settings pane's list, the download pane, and the titlebar badge.
 */
function renderModels() {
  const report = modelsReport;
  if (!report) return;

  for (const select of [el.model, el.setupModel]) {
    select.replaceChildren(
      ...report.models.map((model) => new Option(modelOptionLabel(model), model.size)),
    );
    select.value = settings.model_size;
  }

  const selected = statusOf(settings.model_size);
  el.backendBadge.textContent = selected?.installed
    ? modelName(settings.model_size)
    : `${modelName(settings.model_size)} · 未ダウンロード`;

  const downloading = report.downloading;
  const progress = downloadProgress;

  // Download pane: always about the selected model.
  if (selected) {
    el.setupModelNote.textContent = selected.partialBytes
      ? `前回のダウンロードが ${formatBytes(
          selected.partialBytes,
        )} まで済んでいるので、続きから再開する。`
      : `ダウンロードは約 ${formatBytes(
          selected.approxBytes,
        )}。大きいほど訳は良いが、遅く、メモリを多く使う。`;
  }
  const selectedDownloading = downloading === settings.model_size;
  el.btnSetupDownload.classList.toggle("hidden", selectedDownloading);
  el.btnSetupDownload.disabled = !!downloading;
  el.btnSetupCancel.classList.toggle("hidden", !selectedDownloading);
  el.setupModel.disabled = !!downloading;
  el.setupProgress.classList.toggle("hidden", !selectedDownloading || !progress);

  // Settings pane: one row per size.
  el.modelsDir.textContent = report.dir;
  el.modelList.replaceChildren(
    ...report.models.map((model) => {
      const row = document.createElement("div");
      row.className = "models__row";

      const name = document.createElement("span");
      name.className = "models__name";
      name.classList.toggle("is-selected", model.size === settings.model_size);
      name.textContent = model.label;

      const state = document.createElement("span");
      state.className = "models__state";
      if (model.installed) {
        state.textContent = `ダウンロード済み・${formatBytes(model.bytes ?? 0)}`;
        state.classList.add("is-ok");
      } else if (downloading === model.size) {
        state.textContent = "ダウンロード中…";
      } else if (model.partialBytes) {
        state.textContent = `途中まで（${formatBytes(model.partialBytes)}）`;
      } else {
        state.textContent = `約 ${formatBytes(model.approxBytes)}`;
      }

      const button = document.createElement("button");
      button.className = "btn btn--tiny";
      if (model.installed) {
        const armed = deleteArmed === model.size;
        button.textContent = armed ? "本当に削除" : "削除";
        button.classList.toggle("btn--danger", armed);
        button.addEventListener("click", () => void deleteModel(model.size));
      } else {
        button.textContent = model.partialBytes ? "再開" : "ダウンロード";
        button.disabled = !!downloading;
        button.addEventListener("click", () => void downloadModel(model.size));
      }

      row.append(name, state, button);
      return row;
    }),
  );
  el.settingsProgress.classList.toggle("hidden", !downloading || !progress);

  if (progress) {
    const ratio = progress.total ? progress.received / progress.total : 0;
    for (const bar of [el.setupProgressBar, el.settingsProgressBar]) bar.value = ratio;
    const text = progressText(progress);
    el.setupProgressLabel.textContent = text;
    el.settingsProgressLabel.textContent = text;
  }
}

async function refreshModels() {
  try {
    modelsReport = await invoke<ModelsReport>("model_statuses");
  } catch (err) {
    setStatus(el.modelsStatus, String(err), "error");
    return;
  }
  renderModels();
}

/**
 * Fetches a model. Both the download pane and the settings list come here, and
 * both show the progress, since the download keeps going whichever is on
 * screen.
 */
async function downloadModel(size: string) {
  if (modelsReport?.downloading) return;
  setStatus(el.setupStatus, "");
  setStatus(el.modelsStatus, "");
  downloadProgress = null;
  // Marked as running before the first progress event arrives, so the buttons
  // do not stay pressable while Hugging Face is still being asked.
  if (modelsReport) modelsReport.downloading = size;
  renderModels();

  try {
    await invoke("download_model", { size });
    const done = `${modelName(size)} をダウンロードしました`;
    setStatus(el.setupStatus, done, "ok");
    setStatus(el.modelsStatus, done, "ok");
  } catch (err) {
    setStatus(el.setupStatus, String(err), "error");
    setStatus(el.modelsStatus, String(err), "error");
  } finally {
    downloadProgress = null;
    await refreshModels();
  }

  // The download pane was only ever in the way of the translate pane.
  if (!el.paneSetup.classList.contains("hidden") && !needsModel()) {
    showPane(homePane());
  }
}

async function deleteModel(size: string) {
  if (deleteArmed !== size) {
    deleteArmed = size;
    renderModels();
    return;
  }
  deleteArmed = null;
  try {
    await invoke("delete_model", { size });
    setStatus(el.modelsStatus, `${modelName(size)} を削除しました`, "ok");
  } catch (err) {
    setStatus(el.modelsStatus, String(err), "error");
  }
  await refreshModels();
}

/** A size picked in either dropdown is saved, and may need downloading. */
async function chooseModel(size: string) {
  deleteArmed = null;
  el.model.value = size;
  await persistChoice();
  // Landing on a model that is not here yet sends you to fetch it; picking one
  // that is, from the download pane, sends you back.
  const onTranslate = !el.paneTranslate.classList.contains("hidden");
  const onSetup = !el.paneSetup.classList.contains("hidden");
  if (onTranslate || onSetup) showPane(homePane());
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

el.btnTranslate.addEventListener("click", () => translate(el.input.value));

el.input.addEventListener("input", () => {
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
  syncTone();
  await persistChoice();
});

for (const control of [el.sourceLang, el.targetLang, el.tone]) {
  control.addEventListener("change", persistChoice);
}

// persistChoice repaints this too, but only after a round trip to disk — the
// dropdown should follow the target as it is picked, not the save.
el.targetLang.addEventListener("change", syncTone);

el.model.addEventListener("change", () => void chooseModel(el.model.value));
el.setupModel.addEventListener("change", () => void chooseModel(el.setupModel.value));

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
  el.setClipboardAuto,
  el.setAutoCopy,
  el.setUpdateCheck,
]) {
  box.addEventListener("change", () => scheduleSave());
}

for (const field of [el.setDoubleCopyWindow]) {
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

el.btnSetupDownload.addEventListener("click", () =>
  downloadModel(settings.model_size),
);
// Stopping keeps what has arrived; the next press resumes from there.
el.btnSetupCancel.addEventListener("click", () => invoke("cancel_download"));
el.btnSettingsCancel.addEventListener("click", () => invoke("cancel_download"));
el.btnSetupLicense.addEventListener("click", () => invoke("open_model_license"));
el.btnLicense.addEventListener("click", () => invoke("open_model_license"));

// Minimize parks the window in the taskbar/Dock, where it is still visible and
// clickable; ✕ hides it outright and leaves the tray icon as the way back.
el.btnMinimize.addEventListener("click", () => appWindow.minimize());
el.btnClose.addEventListener("click", () => appWindow.hide());

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

listen<DownloadProgress>("model-download", (event) => {
  downloadProgress = event.payload;
  renderModels();
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
  // With no model downloaded the gesture still raises the window, but onto the
  // download pane — there is nothing to translate the clipboard with.
  showPane(homePane());
  // The window arrives unasked-for over whatever you were doing, so the slab
  // lands with a wobble rather than just appearing. True of the setup pane too.
  jiggle(document.body);
  // A withdrawn build shows the advisory and stops there — nothing gets put in
  // a box it is not going to translate. The watcher is stood down when the
  // advisory lands, so in practice this only catches a gesture already in
  // flight when it did.
  if (needsModel() || advisory) return;

  el.input.focus();
  el.input.select();

  const text = event.payload.text;
  if (!text || !text.trim()) return;

  el.input.value = text;

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
  await refreshModels();
  applySettingsToUi();

  // Asked on the first launch only, and only where there is something to
  // answer: a platform with no detector has no gesture to offer, and a user who
  // has already been through the disclosure has already been asked.
  firstRunPending =
    doubleCopySupported &&
    !clipboardConsent &&
    !(await invoke<boolean>("first_run_answered").catch(() => true));

  showPane(homePane());

  // Last, and deliberately not awaited: this one goes to the network, and the
  // app has to be usable before it answers rather than after.
  void runUpdateCheck();
})();
