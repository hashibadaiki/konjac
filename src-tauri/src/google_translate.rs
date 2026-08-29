//! Fast-path translation through Google Cloud Translation Basic (NMT).
//!
//! This is deliberately narrower than the Claude path. NMT is used for short,
//! plain text in the default register; anything whose formatting or requested
//! tone needs the prompt in `translate.rs` goes straight to Claude instead.

use std::time::Duration;

use serde::{Deserialize, Serialize};

const ENDPOINT: &str = "https://translation.googleapis.com/language/translate/v2";
const API_KEY_ENV: &str = "GOOGLE_TRANSLATE_API_KEY";
const KEYRING_SERVICE: &str = "dev.hashibadaiki.konjac";
const KEYRING_USER: &str = "google-cloud-translation-api-key";

/// A fast path that waits longer than this has stopped being a fast path. The
/// caller immediately falls back to Claude when this timer expires.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// Google accepts more, but recommends small synchronous requests. This line
/// also keeps the route focused on the short selections it is meant to improve.
pub const FAST_PATH_CHAR_LIMIT: usize = 5_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyStatus {
    pub configured: bool,
    /// `environment`, `keychain`, or `none`. Never contains the key itself.
    pub source: String,
    /// False on platforms where this build cannot write an OS credential store.
    pub can_store: bool,
}

#[derive(Serialize)]
struct TranslateRequest<'a> {
    q: &'a str,
    target: &'a str,
    format: &'static str,
    model: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<&'a str>,
}

#[derive(Deserialize)]
struct TranslateResponse {
    data: TranslateData,
}

#[derive(Deserialize)]
struct TranslateData {
    translations: Vec<Translation>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Translation {
    translated_text: String,
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: GoogleError,
}

#[derive(Deserialize)]
struct GoogleError {
    #[serde(default)]
    message: String,
}

fn environment_key() -> Option<String> {
    std::env::var(API_KEY_ENV)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("OS の資格情報ストアを開けません: {e}"))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn keychain_key() -> Result<Option<String>, String> {
    match keyring_entry()?.get_password() {
        Ok(value) if !value.trim().is_empty() => Ok(Some(value.trim().to_owned())),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!(
            "Google API キーを資格情報ストアから読めません: {e}"
        )),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn keychain_key() -> Result<Option<String>, String> {
    Ok(None)
}

/// Environment wins so development and managed deployments can provide a key
/// without writing it through the UI.
pub fn api_key() -> Result<Option<String>, String> {
    match environment_key() {
        Some(key) => Ok(Some(key)),
        None => keychain_key(),
    }
}

pub fn api_key_status() -> Result<ApiKeyStatus, String> {
    if environment_key().is_some() {
        return Ok(ApiKeyStatus {
            configured: true,
            source: "environment".into(),
            can_store: cfg!(any(target_os = "macos", target_os = "windows")),
        });
    }

    let configured = keychain_key()?.is_some();
    Ok(ApiKeyStatus {
        configured,
        source: if configured {
            "keychain".into()
        } else {
            "none".into()
        },
        can_store: cfg!(any(target_os = "macos", target_os = "windows")),
    })
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub fn store_api_key(value: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("Google API キーが空です".into());
    }
    keyring_entry()?
        .set_password(value)
        .map_err(|e| format!("Google API キーを資格情報ストアへ保存できません: {e}"))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn store_api_key(_value: &str) -> Result<(), String> {
    Err(format!(
        "この OS では画面から保存できません。{API_KEY_ENV} を設定してください"
    ))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub fn delete_api_key() -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!(
            "Google API キーを資格情報ストアから削除できません: {e}"
        )),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn delete_api_key() -> Result<(), String> {
    Ok(())
}

/// NMT has no tone instruction and may rewrite source-like markup. Preserve the
/// existing Claude contract by declining text that needs either capability.
pub fn eligible(text: &str, tone: &str) -> bool {
    tone == "default"
        && text.chars().count() <= FAST_PATH_CHAR_LIMIT
        && !text.contains('`')
        && !text.contains("~~~")
        && !text.contains("http://")
        && !text.contains("https://")
}

pub fn language_code(language: &str) -> Option<&'static str> {
    match language {
        "Japanese" => Some("ja"),
        "English" => Some("en"),
        "Chinese (Simplified)" => Some("zh-CN"),
        "Chinese (Traditional)" => Some("zh-TW"),
        "Korean" => Some("ko"),
        "French" => Some("fr"),
        "German" => Some("de"),
        "Spanish" => Some("es"),
        "Portuguese" => Some("pt"),
        "Italian" => Some("it"),
        "Russian" => Some("ru"),
        "Vietnamese" => Some("vi"),
        "Thai" => Some("th"),
        "Indonesian" => Some("id"),
        "Arabic" => Some("ar"),
        _ => None,
    }
}

/// Google may HTML-escape characters in `translatedText` even for a plain-text
/// request. Decode one entity layer without treating the result as markup.
fn decode_entities(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut rest = input;

    while let Some(start) = rest.find('&') {
        output.push_str(&rest[..start]);
        let entity_start = &rest[start..];
        let Some(end) = entity_start.find(';').filter(|end| *end <= 10) else {
            output.push('&');
            rest = &entity_start[1..];
            continue;
        };

        let entity = &entity_start[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            _ if entity.starts_with("#x") || entity.starts_with("#X") => {
                u32::from_str_radix(&entity[2..], 16)
                    .ok()
                    .and_then(char::from_u32)
            }
            _ if entity.starts_with('#') => {
                entity[1..].parse::<u32>().ok().and_then(char::from_u32)
            }
            _ => None,
        };

        if let Some(ch) = decoded {
            output.push(ch);
        } else {
            output.push_str(&entity_start[..=end]);
        }
        rest = &entity_start[end + 1..];
    }
    output.push_str(rest);
    output
}

fn readable_error(status: reqwest::StatusCode, body: &str) -> String {
    let detail = serde_json::from_str::<ErrorEnvelope>(body)
        .ok()
        .map(|envelope| envelope.error.message)
        .filter(|message| !message.trim().is_empty());

    let head = match status.as_u16() {
        400 | 401 | 403 => "Google API キーまたは Cloud Translation API の設定を確認してください",
        429 => "Google Cloud Translation の利用上限に達しました",
        500..=599 => "Google Cloud Translation が一時的に利用できません",
        _ => "Google Cloud Translation がエラーを返しました",
    };

    match detail {
        Some(detail) => format!("{head}（HTTP {}: {detail}）", status.as_u16()),
        None => format!("{head}（HTTP {}）", status.as_u16()),
    }
}

pub async fn translate(
    client: &reqwest::Client,
    api_key: &str,
    text: &str,
    source_lang: &str,
    target_lang: &str,
) -> Result<String, String> {
    let target = language_code(target_lang)
        .ok_or_else(|| format!("Google NMT が未対応の翻訳先です: {target_lang}"))?;
    let source = if source_lang == "auto" {
        None
    } else {
        Some(
            language_code(source_lang)
                .ok_or_else(|| format!("Google NMT が未対応の翻訳元です: {source_lang}"))?,
        )
    };

    let response = client
        .post(ENDPOINT)
        // Keep the key out of URLs, proxy logs and error messages.
        .header("x-goog-api-key", api_key)
        .timeout(REQUEST_TIMEOUT)
        .json(&TranslateRequest {
            q: text,
            source,
            target,
            format: "text",
            model: "nmt",
        })
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "Google NMT が 5 秒以内に応答しませんでした".to_string()
            } else {
                format!("Google NMT に接続できません: {e}")
            }
        })?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Google NMT の応答を読めません: {e}"))?;

    if !status.is_success() {
        return Err(readable_error(status, &body));
    }

    let translated = serde_json::from_str::<TranslateResponse>(&body)
        .map_err(|e| format!("Google NMT の応答を解釈できません: {e}"))?
        .data
        .translations
        .into_iter()
        .next()
        .map(|translation| decode_entities(&translation.translated_text))
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| "Google NMT が翻訳結果を返しませんでした".to_string())?;

    Ok(translated.trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_ui_language_has_a_google_code() {
        for language in [
            "Japanese",
            "English",
            "Chinese (Simplified)",
            "Chinese (Traditional)",
            "Korean",
            "French",
            "German",
            "Spanish",
            "Portuguese",
            "Italian",
            "Russian",
            "Vietnamese",
            "Thai",
            "Indonesian",
            "Arabic",
        ] {
            assert!(language_code(language).is_some(), "missing {language}");
        }
        assert!(language_code("auto").is_none());
    }

    #[test]
    fn only_short_default_text_takes_the_fast_path() {
        assert!(eligible("A short sentence.", "default"));
        assert!(!eligible("A short sentence.", "formal"));
        assert!(!eligible("```rust\nfn main() {}\n```", "default"));
        assert!(!eligible("Open `settings.json`.", "default"));
        assert!(!eligible("See https://example.com/docs", "default"));
        assert!(!eligible(&"a".repeat(FAST_PATH_CHAR_LIMIT + 1), "default"));
    }

    #[test]
    fn google_entities_are_decoded_once() {
        assert_eq!(
            decode_entities("&quot;A &amp; B&quot; &lt;tag&gt; &#x65E5;&#26412;"),
            "\"A & B\" <tag> 日本"
        );
        assert_eq!(decode_entities("&amp;lt;"), "&lt;");
        assert_eq!(decode_entities("unknown &thing;"), "unknown &thing;");
    }

    #[test]
    fn successful_response_extracts_translated_text() {
        let response: TranslateResponse = serde_json::from_str(
            r#"{"data":{"translations":[{"translatedText":"こんにちは &amp; ようこそ"}]}}"#,
        )
        .unwrap();
        assert_eq!(
            decode_entities(&response.data.translations[0].translated_text),
            "こんにちは & ようこそ"
        );
    }

    #[test]
    fn api_errors_are_actionable() {
        let message = readable_error(
            reqwest::StatusCode::FORBIDDEN,
            r#"{"error":{"message":"API has not been used in project"}}"#,
        );
        assert!(message.contains("API キー"));
        assert!(message.contains("HTTP 403"));
        assert!(message.contains("API has not been used"));
    }
}
