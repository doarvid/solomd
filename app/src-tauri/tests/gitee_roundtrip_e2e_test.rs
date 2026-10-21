//! Gitee as a sync remote, both directions: device A pushes a note, device B
//! pulls it, edits it and pushes, and device A pulls B's edit — all through
//! the real `github_push_inner` / `github_pull_inner` (our credential
//! callback, not the system git's helper).
//!
//! `#[ignore]`d — needs network + a Gitee repo you can push to. Run with:
//!   SOLOMD_GITEE_URL=https://gitee.com/<user>/<repo>.git \
//!   SOLOMD_GITEE_TOKEN=<token> \
//!   cargo test --test gitee_roundtrip_e2e_test -- --ignored --nocapture

use std::fs;
use std::path::Path;
use std::process::Command;

use app_lib::github_sync::{github_pull_inner, github_push_inner};

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git").args(args).current_dir(dir).output().unwrap();
    assert!(out.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
}

/// A workspace that tracks the remote's master, with `origin` set to the bare
/// URL so later push/pull go through our credential callback.
fn device(name: &str, url: &str, auth_url: &str) -> std::path::PathBuf {
    let ws = std::env::temp_dir().join(format!("solomd-gitee-rt-{}-{}", name, std::process::id()));
    let _ = fs::remove_dir_all(&ws);
    let out = Command::new("git").args(["clone", "-q", auth_url, ws.to_str().unwrap()]).output().unwrap();
    assert!(out.status.success(), "clone failed: {}", String::from_utf8_lossy(&out.stderr));
    git(&ws, &["config", "user.email", "e2e@example.com"]);
    git(&ws, &["config", "user.name", name]);
    // SoloMD syncs `main` (it renames a local master before the first push),
    // so a second device starts from origin/main once one exists.
    let has_main = Command::new("git").args(["rev-parse", "--verify", "-q", "origin/main"])
        .current_dir(&ws).output().unwrap().status.success();
    if has_main {
        git(&ws, &["checkout", "-q", "-B", "main", "origin/main"]);
    }
    git(&ws, &["remote", "set-url", "origin", url]);
    ws
}

#[test]
#[ignore]
fn gitee_push_pull_roundtrip() {
    let (url, token) = match (env("SOLOMD_GITEE_URL"), env("SOLOMD_GITEE_TOKEN")) {
        (Some(u), Some(t)) => (u, t),
        _ => {
            eprintln!("skipped: set SOLOMD_GITEE_URL and SOLOMD_GITEE_TOKEN");
            return;
        }
    };
    let owner = url.split('/').nth(3).unwrap_or_default().to_string();
    let auth_url = url.replacen("https://", &format!("https://{}:{}@", owner, token), 1);
    let stamp = std::process::id();
    let note = format!("roundtrip-{stamp}.md");

    let a = device("a", &url, &auth_url);
    let b = device("b", &url, &auth_url);

    // A writes and pushes.
    fs::write(a.join(&note), "# 来自 A\n").unwrap();
    github_push_inner(a.to_string_lossy().into(), token.clone(), Some("A adds a note".into()))
        .expect("A push");

    // B pulls, sees it, edits it, pushes.
    let r = github_pull_inner(b.to_string_lossy().into(), token.clone()).expect("B pull");
    assert_eq!(r.kind, "fast_forward", "B pull: {:?}", r.kind);
    assert_eq!(fs::read_to_string(b.join(&note)).unwrap(), "# 来自 A\n");
    fs::write(b.join(&note), "# 来自 A\n\nB 改了一行\n").unwrap();
    github_push_inner(b.to_string_lossy().into(), token.clone(), Some("B edits".into()))
        .expect("B push");

    // A pulls B's edit.
    let r = github_pull_inner(a.to_string_lossy().into(), token.clone()).expect("A pull");
    assert_eq!(r.kind, "fast_forward", "A pull: {:?}", r.kind);
    assert_eq!(fs::read_to_string(a.join(&note)).unwrap(), "# 来自 A\n\nB 改了一行\n");

    let _ = fs::remove_dir_all(&a);
    let _ = fs::remove_dir_all(&b);
}
