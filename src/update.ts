/**
 * Fetching half of the update notice and the kill switch. The other half — what
 * the numbers mean, and whether the app has to stop — is in `update.rs`, which
 * has the tests.
 *
 * Everything here fails open. Offline, rate limited, GitHub down, a file that
 * came back as nonsense: each of those returns null and the app carries on
 * exactly as it would have. A translator that stops working because a status
 * endpoint hiccupped would be a worse bug than the one this is here to close.
 */

/**
 * Both hosts are pinned in the CSP (`tauri.conf.json`), so this list cannot be
 * widened from here alone.
 */
const LATEST_RELEASE_URL =
  "https://api.github.com/repos/hashibadaiki/konjac/releases/latest";

/**
 * Read off the default branch rather than out of a release: publishing it has
 * to be one commit, with no build in between, or it is no use during the hours
 * that matter. The CDN in front of it caches for a few minutes.
 */
const ADVISORY_URL =
  "https://raw.githubusercontent.com/hashibadaiki/konjac/main/security.json";

/** The notice is not news often enough to be worth asking on every launch. */
const NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Long enough for a slow connection, short enough not to be felt at launch. */
const REQUEST_TIMEOUT_MS = 8000;

/** A remote string on screen is still a remote string: give it a ceiling. */
const MAX_MESSAGE_CHARS = 400;

const CACHE_KEY = "konjac.latest-release";
const DISMISSED_KEY = "konjac.update-dismissed";

/** What `security.json` says, once it has been squinted at. */
export interface Advisory {
  /** Builds below this must stop translating. */
  minimumVersion: string | null;
  /** Why, in the publisher's words. Optional. */
  message: string | null;
  /** Where the details are. Validated again on the Rust side before opening. */
  url: string | null;
}

/**
 * A response that arrived and said no. Carries the code because one of them —
 * 404 from the releases endpoint — is an answer rather than a failure.
 */
class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/**
 * `AbortSignal.timeout` would do this in one line, but the app supports macOS
 * back to 10.15 and the WebKit that ships there does not have it.
 */
async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
      // Asking GitHub twice in a session should reach GitHub, not a cache
      // entry from before the advisory was published.
      cache: "no-store",
    });
    if (!response.ok) throw new HttpError(response.status);
    return await response.json();
  } finally {
    window.clearTimeout(timer);
  }
}

/** Non-empty strings only — the file uses "" for "nothing to say". */
function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_MESSAGE_CHARS) : null;
}

/**
 * Asked on every launch, and regardless of the notice setting: this is the only
 * way to reach an install running code that has since been found to have a hole
 * in it, and the install that most needs reaching is not the one that opted in.
 * It sends nothing but a GET.
 */
export async function fetchAdvisory(): Promise<Advisory | null> {
  let raw: unknown;
  try {
    raw = await getJson(ADVISORY_URL);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;

  const fields = raw as Record<string, unknown>;
  return {
    minimumVersion: text(fields.minimum_version),
    message: text(fields.message),
    url: text(fields.url),
  };
}

interface CachedRelease {
  at: number;
  tag: string | null;
}

function readCache(): CachedRelease | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedRelease;
    return typeof parsed?.at === "number" ? parsed : null;
  } catch {
    // Unreadable or unavailable storage costs one extra request, nothing more.
    return null;
  }
}

function writeCache(entry: CachedRelease) {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    /* see readCache */
  }
}

/** What looking at the releases endpoint came back with. */
export interface LatestRelease {
  /**
   * Whether GitHub answered at all. False means offline, rate limited, or down
   * — which is why "no newer version" and "could not check" must not read the
   * same on screen.
   */
  reached: boolean;
  /** The newest published tag, or null when there is not one yet. */
  tag: string | null;
}

/**
 * The newest published tag, and whether the question got through.
 *
 * Answers from the last day's cache unless `force` says otherwise, so pressing
 * the button in the settings pane always reaches the network while launching
 * the app four times in an afternoon asks once.
 */
export async function fetchLatestTag(force: boolean): Promise<LatestRelease> {
  const cached = readCache();
  if (!force && cached && Date.now() - cached.at < NOTICE_INTERVAL_MS) {
    return { reached: true, tag: cached.tag };
  }

  let raw: unknown;
  try {
    raw = await getJson(LATEST_RELEASE_URL);
  } catch (err) {
    // A 404 here is an answer, not a failure: the endpoint skips drafts and
    // pre-releases, so a repository whose only release is still a draft has
    // nothing to report. That is worth caching like any other answer, and worth
    // saying differently to the user than "could not reach GitHub".
    if (err instanceof HttpError && err.status === 404) {
      writeCache({ at: Date.now(), tag: null });
      return { reached: true, tag: null };
    }
    // Keep whatever the last successful check found: a newer version does not
    // stop existing because this one call failed.
    return { reached: false, tag: cached?.tag ?? null };
  }

  const tag =
    raw && typeof raw === "object"
      ? text((raw as Record<string, unknown>).tag_name)
      : null;
  writeCache({ at: Date.now(), tag });
  return { reached: true, tag };
}

/**
 * Whether this exact version has already been waved off. Kept across launches
 * on purpose — being told about the same release every morning is how a notice
 * turns into something people learn to click past without reading.
 */
export function isDismissed(tag: string): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === tag;
  } catch {
    return false;
  }
}

export function dismiss(tag: string) {
  try {
    window.localStorage.setItem(DISMISSED_KEY, tag);
  } catch {
    /* see readCache */
  }
}
