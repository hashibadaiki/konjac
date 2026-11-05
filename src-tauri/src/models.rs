//! The PLaMo 3 Translate weights: which ones exist, where they are kept, and
//! fetching them from Hugging Face.
//!
//! Nothing ships inside the app. The smallest model is half a gigabyte and the
//! largest about twenty, and which one suits a machine is the user's call, so
//! the app downloads the one they pick the first time it is needed. After that
//! translation never touches the network.
//!
//! Every model is PFN's own GGUF at Q4_K_M — the quantization PFN's client
//! defaults to, because Q4_0 measured 0.9 chrF++ lower than BF16 on FLORES+ —
//! or at Q4_0 where a repository has no Q4_K_M.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// The model a fresh install offers first: the smallest, so the first download
/// is half a gigabyte and the first translation is quick on any machine. A
/// bigger one is a choice in the settings once the app has earned the space.
pub const DEFAULT_SIZE: &str = "0.8b";

/// Where to read the licence before downloading. A constant, so the command
/// that opens it has nothing to inject.
pub const LICENSE_URL: &str = "https://plamo.preferredai.jp/info/plamo-community-license-en";

const HF: &str = "https://huggingface.co";
/// Quantizations to take, best first. Q4_K_M is PFN's default; Q4_0 is the
/// fallback for a repository that does not ship it — PFN's own client is only
/// known to fetch the 0.8B model as Q4_0.
const QUANTS: [&str; 2] = ["Q4_K_M", "Q4_0"];

/// How often progress goes to the frontend. Every chunk would be thousands of
/// events a second for nothing anyone can read.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Model {
    /// As stored in `settings.json` and in the repository name: `0.8b`, `2b`…
    pub size: &'static str,
    pub label: &'static str,
    /// Roughly what the download weighs, for the picker before anyone has asked
    /// Hugging Face. The real figure comes with the download.
    pub approx_bytes: u64,
}

pub const MODELS: [Model; 4] = [
    Model {
        size: "0.8b",
        label: "0.8B — 最軽量",
        approx_bytes: 600_000_000,
    },
    Model {
        size: "2b",
        label: "2B — 標準",
        approx_bytes: 1_810_000_000,
    },
    Model {
        size: "8b",
        label: "8B — 高品質",
        approx_bytes: 5_200_000_000,
    },
    Model {
        size: "31b",
        label: "31B — 最高品質",
        approx_bytes: 19_000_000_000,
    },
];

pub fn find(size: &str) -> Option<&'static Model> {
    MODELS.iter().find(|model| model.size == size)
}

impl Model {
    pub fn repository(&self) -> String {
        format!("pfnet/plamo-3-translate-{}-GGUF", self.size)
    }

    /// What the file is called on disk here — fixed, whatever the repository
    /// names it or whichever quantization it turned out to be, so finding it
    /// again needs no network.
    pub fn file_name(&self) -> String {
        format!("plamo-3-translate-{}.gguf", self.size)
    }

    pub fn path(&self, dir: &Path) -> PathBuf {
        dir.join(self.file_name())
    }

    fn partial_path(&self, dir: &Path) -> PathBuf {
        dir.join(format!("{}.part", self.file_name()))
    }
}

/// One model as the settings pane and the setup pane see it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub size: &'static str,
    pub label: &'static str,
    pub approx_bytes: u64,
    pub installed: bool,
    /// On disk, when installed.
    pub bytes: Option<u64>,
    /// Bytes of an interrupted download waiting to be resumed.
    pub partial_bytes: Option<u64>,
}

pub fn statuses(dir: &Path) -> Vec<ModelStatus> {
    MODELS
        .iter()
        .map(|model| {
            let bytes = std::fs::metadata(model.path(dir)).ok().map(|m| m.len());
            let partial_bytes = std::fs::metadata(model.partial_path(dir))
                .ok()
                .map(|m| m.len());
            ModelStatus {
                size: model.size,
                label: model.label,
                approx_bytes: model.approx_bytes,
                installed: bytes.is_some(),
                bytes,
                partial_bytes,
            }
        })
        .collect()
}

pub fn delete(dir: &Path, model: &Model) -> Result<(), String> {
    for path in [model.path(dir), model.partial_path(dir)] {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(format!("モデルを削除できません: {err}\n{}", path.display())),
        }
    }
    Ok(())
}

// ------------------------------------------------------------------ remote

/// An entry of `GET /api/models/{repo}/tree/main`.
#[derive(Debug, Deserialize)]
struct TreeEntry {
    path: String,
    size: u64,
    lfs: Option<Lfs>,
}

#[derive(Debug, Deserialize)]
struct Lfs {
    /// The SHA-256 of the file's contents.
    oid: String,
    size: u64,
}

/// The file to fetch, and what it must hash to.
#[derive(Debug, PartialEq, Eq)]
struct Remote {
    path: String,
    size: u64,
    sha256: String,
}

/// Picks the GGUF to fetch out of a repository listing: the first of [`QUANTS`]
/// the repository has.
///
/// Exactly one of that quantization, and not a shard: a model split over several files would need
/// every one of them, and the official repositories ship each quantization
/// whole. Anything else means the repository is not laid out the way this app
/// expects, which is worth an error rather than a guess.
fn pick(entries: Vec<TreeEntry>) -> Result<Remote, String> {
    let quant_of = |entry: &TreeEntry| {
        let path = entry.path.to_ascii_lowercase();
        if path.contains("-of-") {
            return None;
        }
        QUANTS
            .iter()
            .position(|quant| path.ends_with(&format!("-{}.gguf", quant.to_ascii_lowercase())))
    };
    let Some(best) = entries.iter().filter_map(quant_of).min() else {
        return Err(format!(
            "{} の GGUF が見つかりません",
            QUANTS.join(" / ")
        ));
    };
    let mut matches: Vec<TreeEntry> = entries
        .into_iter()
        .filter(|entry| quant_of(entry) == Some(best))
        .collect();
    if matches.len() != 1 {
        let found: Vec<&str> = matches.iter().map(|entry| entry.path.as_str()).collect();
        return Err(format!(
            "{} の GGUF が 1 つに定まりません（見つかったもの: {}）",
            QUANTS[best],
            found.join(", ")
        ));
    }
    let entry = matches.remove(0);
    let lfs = entry
        .lfs
        .ok_or_else(|| format!("{} にハッシュがありません", entry.path))?;
    Ok(Remote {
        size: if lfs.size > 0 { lfs.size } else { entry.size },
        sha256: lfs.oid.to_ascii_lowercase(),
        path: entry.path,
    })
}

async fn resolve(client: &reqwest::Client, model: &Model) -> Result<Remote, String> {
    let url = format!("{HF}/api/models/{}/tree/main", model.repository());
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Hugging Face に接続できません: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Hugging Face がモデルの一覧を返しませんでした（HTTP {}）: {}",
            response.status().as_u16(),
            model.repository()
        ));
    }
    let entries: Vec<TreeEntry> = response
        .json()
        .await
        .map_err(|e| format!("モデルの一覧を読めません: {e}"))?;
    pick(entries)
}

// ------------------------------------------------------------------ download

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub size: &'static str,
    pub received: u64,
    pub total: u64,
}

/// At most one download at a time, and a way to stop it.
#[derive(Default)]
pub struct Downloads {
    active: Mutex<Option<&'static str>>,
    cancel: AtomicBool,
}

impl Downloads {
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    pub fn active(&self) -> Option<&'static str> {
        self.active.lock().ok().and_then(|active| *active)
    }

    fn begin(&self, size: &'static str) -> Result<ActiveGuard<'_>, String> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "ダウンロードの状態を読めません".to_string())?;
        if let Some(running) = *active {
            return Err(format!("{running} のダウンロードが進行中です"));
        }
        *active = Some(size);
        self.cancel.store(false, Ordering::SeqCst);
        Ok(ActiveGuard(self))
    }
}

/// Clears the active slot however the download ends.
struct ActiveGuard<'a>(&'a Downloads);

impl Drop for ActiveGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0.active.lock() {
            *active = None;
        }
    }
}

/// Hashes what an interrupted download already left behind, so resuming it
/// still ends with a check over the whole file.
async fn hash_existing(path: &Path, hasher: &mut Sha256) -> Result<u64, String> {
    let mut file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(err) => return Err(format!("途中のファイルを読めません: {err}")),
    };
    let mut buffer = vec![0; 1 << 20];
    let mut total = 0;
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("途中のファイルを読めません: {e}"))?;
        if read == 0 {
            return Ok(total);
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
}

/// Downloads `model` into `dir`, resuming an earlier attempt where there is one.
///
/// The bytes go to a `.part` file that is renamed into place only after its
/// size and SHA-256 match what Hugging Face lists, so a file under the real name
/// is always a whole, verified model. Returns its path.
pub async fn download(
    downloads: &Downloads,
    client: &reqwest::Client,
    dir: &Path,
    model: &'static Model,
    mut on_progress: impl FnMut(Progress),
) -> Result<PathBuf, String> {
    let _guard = downloads.begin(model.size)?;
    let remote = resolve(client, model).await?;

    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| format!("保存先のフォルダを作れません: {e}\n{}", dir.display()))?;
    let partial = model.partial_path(dir);

    let mut hasher = Sha256::new();
    let mut received = hash_existing(&partial, &mut hasher).await?;
    if received > remote.size {
        // Left over from a different file than the one listed now.
        received = 0;
        hasher = Sha256::new();
    }

    let url = format!("{HF}/{}/resolve/main/{}", model.repository(), remote.path);
    let mut request = client.get(&url);
    if received > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={received}-"));
    }
    let mut response = request
        .send()
        .await
        .map_err(|e| format!("ダウンロードを始められません: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("ダウンロードに失敗しました（HTTP {}）", status.as_u16()));
    }

    let resumed = received > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
    if !resumed {
        // A server that ignored the range sent the whole file again.
        received = 0;
        hasher = Sha256::new();
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed)
        .truncate(!resumed)
        .open(&partial)
        .await
        .map_err(|e| format!("保存先に書き込めません: {e}\n{}", partial.display()))?;

    on_progress(Progress {
        size: model.size,
        received,
        total: remote.size,
    });
    let mut reported = Instant::now();

    loop {
        if downloads.cancel.load(Ordering::SeqCst) {
            // Kept, so the next attempt picks up from here.
            let _ = file.flush().await;
            return Err("ダウンロードを中止しました".into());
        }
        let chunk = response
            .chunk()
            .await
            .map_err(|e| format!("ダウンロードが途切れました（続きから再開できます）: {e}"))?;
        let Some(chunk) = chunk else { break };
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("保存先に書き込めません（空き容量を確認してください）: {e}"))?;
        hasher.update(&chunk);
        received += chunk.len() as u64;

        if reported.elapsed() >= PROGRESS_INTERVAL {
            reported = Instant::now();
            on_progress(Progress {
                size: model.size,
                received,
                total: remote.size,
            });
        }
    }
    file.flush()
        .await
        .map_err(|e| format!("保存先に書き込めません: {e}"))?;
    drop(file);

    on_progress(Progress {
        size: model.size,
        received,
        total: remote.size,
    });

    if received != remote.size {
        return Err(format!(
            "ダウンロードが途中で終わりました（{received} / {} バイト）。もう一度押すと続きから再開します。",
            remote.size
        ));
    }
    let digest = format!("{:x}", hasher.finalize());
    if digest != remote.sha256 {
        // Not resumable: the bytes are wrong somewhere, and nothing says where.
        let _ = tokio::fs::remove_file(&partial).await;
        return Err("ダウンロードしたファイルのハッシュが一致しません。もう一度ダウンロードしてください。".into());
    }

    let path = model.path(dir);
    tokio::fs::rename(&partial, &path)
        .await
        .map_err(|e| format!("モデルを保存できません: {e}"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, sha: Option<&str>) -> TreeEntry {
        TreeEntry {
            path: path.into(),
            size: 10,
            lfs: sha.map(|oid| Lfs {
                oid: oid.into(),
                size: 10,
            }),
        }
    }

    #[test]
    fn picks_the_one_q4_k_m_file() {
        let remote = pick(vec![
            entry(".gitattributes", None),
            entry("README.md", None),
            entry("plamo-3-translate-2b-Q4_0.gguf", Some("aa")),
            entry("plamo-3-translate-2b-Q4_K_M.gguf", Some("BB")),
            entry("plamo-3-translate-2b-BF16.gguf", Some("cc")),
        ])
        .unwrap();
        assert_eq!(remote.path, "plamo-3-translate-2b-Q4_K_M.gguf");
        assert_eq!(remote.sha256, "bb");
    }

    /// Spelling varies between repositories; the match should not.
    #[test]
    fn the_quantization_matches_in_any_case() {
        let remote = pick(vec![entry("model.q4_k_m.gguf", Some("aa"))]);
        assert!(remote.is_err(), "needs the dash before the quantization");
        let remote = pick(vec![entry("plamo-q4_k_m.gguf", Some("aa"))]).unwrap();
        assert_eq!(remote.path, "plamo-q4_k_m.gguf");
    }

    /// A repository without Q4_K_M still gives a model, the next best one.
    #[test]
    fn falls_back_to_q4_0() {
        let remote = pick(vec![
            entry("plamo-3-translate-0.8b-Q4_0.gguf", Some("aa")),
            entry("plamo-3-translate-0.8b-BF16.gguf", Some("bb")),
        ])
        .unwrap();
        assert_eq!(remote.path, "plamo-3-translate-0.8b-Q4_0.gguf");
        // And Q4_0 does not match IQ4_0 by its suffix.
        assert!(pick(vec![entry("m-IQ4_0.gguf", Some("a"))]).is_err());
    }

    #[test]
    fn shards_and_ambiguity_are_refused() {
        assert!(pick(vec![entry("m-Q4_K_M-00001-of-00002.gguf", Some("a"))]).is_err());
        assert!(pick(vec![
            entry("a-Q4_K_M.gguf", Some("a")),
            entry("sub/b-Q4_K_M.gguf", Some("b")),
        ])
        .is_err());
        assert!(pick(vec![]).is_err());
    }

    /// Without a hash there is nothing to check the download against.
    #[test]
    fn a_file_without_a_hash_is_refused() {
        assert!(pick(vec![entry("m-Q4_K_M.gguf", None)]).is_err());
    }

    #[test]
    fn the_listing_parses_as_hugging_face_sends_it() {
        let raw = r#"[{"type":"file","oid":"x","size":1810000000,"path":"plamo-3-translate-2b-Q4_K_M.gguf",
                      "lfs":{"oid":"ABCDEF","size":1810000000,"pointerSize":135}}]"#;
        let entries: Vec<TreeEntry> = serde_json::from_str(raw).unwrap();
        let remote = pick(entries).unwrap();
        assert_eq!(remote.size, 1_810_000_000);
        assert_eq!(remote.sha256, "abcdef");
    }

    #[test]
    fn urls_and_names_follow_the_size() {
        let model = find("2b").unwrap();
        assert_eq!(model.repository(), "pfnet/plamo-3-translate-2b-GGUF");
        assert_eq!(model.file_name(), "plamo-3-translate-2b.gguf");
        assert!(find(DEFAULT_SIZE).is_some());
        assert!(find("70b").is_none());
    }

    #[test]
    fn a_fresh_directory_has_nothing_installed() {
        let dir = std::env::temp_dir().join(format!("konjac-models-{}", std::process::id()));
        let statuses = statuses(&dir);
        assert_eq!(statuses.len(), MODELS.len());
        assert!(statuses.iter().all(|status| !status.installed));
    }
}
