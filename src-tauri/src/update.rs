//! Whether this build is out of date, and whether it is one people must stop
//! using.
//!
//! Deliberately not an auto-updater. Installing a new build in the background
//! would mean holding a signing key that can push arbitrary code onto every
//! machine running this app — an app that asks for Accessibility permission, so
//! that code would land already able to watch the keyboard. That is a larger
//! hole than the one an updater is usually reached for to close.
//!
//! What is here instead is the half that actually shortens an incident: the app
//! asks GitHub what the newest release is, says so, and — if a published
//! advisory names a minimum version above this one — stops translating and
//! points at the download. Nothing is installed; the user goes and gets it.
//! Publishing the advisory takes one commit, so the vulnerable path can be shut
//! before the fixed build has even finished building.
//!
//! The comparison lives here rather than in the frontend because it is what
//! decides whether the app refuses to run. The frontend does the fetching (the
//! webview already has an HTTP stack, and the CSP pins which hosts it may talk
//! to), then hands the two strings it found to [`verdict`].

use std::cmp::Ordering;

/// Where both the update notice and the advisory send someone to get a fixed
/// build. A constant rather than an argument: the frontend asks for this page
/// to be opened, it does not get to say what "this page" is.
pub const RELEASES_PAGE_URL: &str = "https://github.com/hashibadaiki/konjac/releases/latest";

/// An advisory's "read the details" link comes out of a file fetched over the
/// network, so unlike [`RELEASES_PAGE_URL`] it is not ours by construction —
/// [`is_advisory_url`] is what makes it safe to hand to the platform's opener.
const ADVISORY_URL_PREFIX: &str = "https://github.com/hashibadaiki/konjac/";

/// What this build is, against what the network said.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Verdict {
    /// This build's version, so the frontend can put it on screen without a
    /// second round trip.
    pub current: String,
    /// A newer release exists. Worth a notice, nothing more.
    pub outdated: bool,
    /// This build is below the minimum a published advisory allows, so it must
    /// stop translating.
    pub blocked: bool,
}

/// Splits a version into comparable numbers, or gives up.
///
/// Giving up matters as much as succeeding: an unparseable version means the
/// caller cannot say this build is too old, and [`verdict`] turns that into
/// "carry on" rather than "stop". A malformed advisory must not brick an
/// install.
fn parts(version: &str) -> Option<Vec<u64>> {
    // Releases are tagged `v0.2.0` while the app knows itself as `0.2.0`, so
    // one side or the other always has the `v` on it.
    let trimmed = version.trim().trim_start_matches('v');
    // `0.2.0-beta.1` compares as `0.2.0`. Pre-releases are not published from
    // this repository; if one ever is, being treated as the release it precedes
    // errs towards leaving the app running.
    let core = trimmed.split(['-', '+']).next().unwrap_or(trimmed);
    if core.is_empty() {
        return None;
    }
    core.split('.').map(|part| part.parse::<u64>().ok()).collect()
}

/// `None` when either side is not a version this can read.
fn compare(current: &str, other: &str) -> Option<Ordering> {
    let (current, other) = (parts(current)?, parts(other)?);
    // Zero-extend the shorter one, so `0.2` and `0.2.0` are the same version.
    for index in 0..current.len().max(other.len()) {
        let mine = current.get(index).copied().unwrap_or(0);
        let theirs = other.get(index).copied().unwrap_or(0);
        match mine.cmp(&theirs) {
            Ordering::Equal => continue,
            other => return Some(other),
        }
    }
    Some(Ordering::Equal)
}

/// `latest` is the newest release's tag and `minimum` the floor an advisory
/// sets; either is `None` when the frontend could not get it, which is the
/// ordinary case offline.
pub fn verdict(current: &str, latest: Option<&str>, minimum: Option<&str>) -> Verdict {
    Verdict {
        current: current.to_owned(),
        outdated: latest
            .and_then(|latest| compare(current, latest))
            .is_some_and(Ordering::is_lt),
        blocked: minimum
            .and_then(|minimum| compare(current, minimum))
            .is_some_and(Ordering::is_lt),
    }
}

/// Whether a URL out of an advisory may be handed to the platform's opener.
///
/// Two things have to hold. It must point into this repository, so an advisory
/// cannot send anyone somewhere else. And it must be spelled with characters
/// that mean nothing to a shell: Windows opens URLs through `cmd /C start`,
/// where an `&` would end the command and begin another one. Advisory links are
/// `…/security/advisories/GHSA-xxxx-xxxx-xxxx`, so nothing legitimate is lost.
pub fn is_advisory_url(url: &str) -> bool {
    url.starts_with(ADVISORY_URL_PREFIX)
        && url
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '/' | '.' | '-' | '_' | '~'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_newer_release_is_a_notice_not_a_block() {
        let verdict = verdict("0.1.0", Some("v0.2.0"), None);
        assert!(verdict.outdated);
        assert!(!verdict.blocked);
        assert_eq!(verdict.current, "0.1.0");
    }

    #[test]
    fn the_newest_build_is_neither() {
        let verdict = verdict("0.2.0", Some("v0.2.0"), Some("0.2.0"));
        assert!(!verdict.outdated);
        assert!(!verdict.blocked);
    }

    /// The whole point of the file: a build below the floor stops.
    #[test]
    fn a_build_below_the_minimum_is_blocked() {
        assert!(verdict("0.1.0", None, Some("0.1.1")).blocked);
        assert!(verdict("0.1.9", None, Some("0.2.0")).blocked);
    }

    /// And a build at or above it is not, so lifting the floor releases it.
    #[test]
    fn a_build_at_the_minimum_runs() {
        assert!(!verdict("0.2.0", None, Some("0.2.0")).blocked);
        assert!(!verdict("0.3.0", None, Some("0.2.0")).blocked);
    }

    /// Nothing fetched — offline, GitHub down, rate limited — has to mean the
    /// app carries on. Failing closed would make an outage look like a recall.
    #[test]
    fn nothing_fetched_changes_nothing() {
        let verdict = verdict("0.1.0", None, None);
        assert!(!verdict.outdated);
        assert!(!verdict.blocked);
    }

    /// Same for a file that arrived but says something unreadable: it must not
    /// be the thing that stops an install translating.
    #[test]
    fn an_unreadable_version_does_not_block() {
        assert!(!verdict("0.1.0", None, Some("latest")).blocked);
        assert!(!verdict("0.1.0", None, Some("")).blocked);
        assert!(!verdict("0.1.0", None, Some("1.x")).blocked);
        assert!(!verdict("nightly", None, Some("0.2.0")).blocked);
    }

    #[test]
    fn version_lengths_need_not_match() {
        assert_eq!(compare("0.2", "0.2.0"), Some(Ordering::Equal));
        assert_eq!(compare("0.2.1", "0.2"), Some(Ordering::Greater));
    }

    /// String order would put 10 before 9.
    #[test]
    fn components_compare_as_numbers() {
        assert_eq!(compare("0.10.0", "0.9.0"), Some(Ordering::Greater));
        assert_eq!(compare("v1.0.0", "0.99.99"), Some(Ordering::Greater));
    }

    #[test]
    fn advisory_urls_must_point_into_this_repository() {
        assert!(is_advisory_url(
            "https://github.com/hashibadaiki/konjac/security/advisories/GHSA-1234-abcd-5678"
        ));
        assert!(!is_advisory_url("https://github.com/someone/else/issues/1"));
        assert!(!is_advisory_url("https://evil.example/hashibadaiki/konjac/"));
        assert!(!is_advisory_url("file:///etc/passwd"));
    }

    /// The Windows opener goes through `cmd`, so a URL that means something to
    /// a shell is refused even when it does point at this repository.
    #[test]
    fn advisory_urls_may_not_carry_shell_syntax() {
        assert!(!is_advisory_url(
            "https://github.com/hashibadaiki/konjac/x&calc"
        ));
        assert!(!is_advisory_url(
            "https://github.com/hashibadaiki/konjac/x %APPDATA%"
        ));
        assert!(!is_advisory_url(
            "https://github.com/hashibadaiki/konjac/x\"|whoami"
        ));
    }
}
