//! Git churn for the novelty component of health (`spec §6`).
//!
//! We shell out to `git log --since=14.days --numstat` from the workspace
//! root, parse the output, and return a per-file sum of lines
//! added + deleted. No libgit2 dependency — a shelled `git` is fine for v1.
//!
//! If `git` isn't on PATH or the workspace isn't a repo, every file gets 0
//! churn. This is the degraded but correct behaviour.

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

pub type ChurnMap = HashMap<String, u32>;

pub fn collect_churn(root: &Path, days: u32) -> ChurnMap {
    let mut out = ChurnMap::new();
    // Short-circuit if we're not inside a git working tree. This avoids a
    // multi-second timeout on systems where `git` does discovery up the
    // filesystem. We walk up looking for `.git/` — worst case a handful of
    // stat() calls.
    if !is_in_git_repo(root) {
        return out;
    }
    let arg_since = format!("--since={days}.days");
    let result = Command::new("git")
        .arg("-C")
        .arg(root)
        .args([
            "log",
            "--numstat",
            "--no-merges",
            "--pretty=format:",
            "--no-renames",
            "-1000", // cap traversal — good enough for a 14-day window
            &arg_since,
        ])
        .arg("--")
        .arg(".")
        .output();
    let Ok(output) = result else {
        return out;
    };
    if !output.status.success() {
        return out;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    parse_numstat(&text, &mut out);
    out
}

fn is_in_git_repo(root: &Path) -> bool {
    let mut cur: Option<&Path> = Some(root);
    while let Some(p) = cur {
        if p.join(".git").exists() {
            return true;
        }
        cur = p.parent();
    }
    false
}

fn parse_numstat(text: &str, out: &mut ChurnMap) {
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // <added>\t<deleted>\t<path>
        let mut parts = line.splitn(3, '\t');
        let added = parts.next().unwrap_or("0");
        let deleted = parts.next().unwrap_or("0");
        let path = parts.next().unwrap_or("").trim();
        if path.is_empty() {
            continue;
        }
        // Binary files show `-\t-\t…`; skip.
        let (a, d) = match (added.parse::<u32>(), deleted.parse::<u32>()) {
            (Ok(a), Ok(d)) => (a, d),
            _ => continue,
        };
        // Handle `{old => new}` rename paths: keep the new.
        let path = if let Some(idx) = path.find("=>") {
            let tail = &path[idx + 2..];
            let end = tail.find('}').unwrap_or(tail.len());
            tail[..end].trim().to_string()
        } else {
            path.replace('\\', "/")
        };
        *out.entry(path).or_insert(0) += a + d;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numstat_sums_adds_and_deletes() {
        let raw = "3\t1\tfoo/bar.py\n0\t0\tbaz.rs\n5\t5\tfoo/bar.py\n";
        let mut out = ChurnMap::new();
        parse_numstat(raw, &mut out);
        assert_eq!(out.get("foo/bar.py"), Some(&14));
        assert_eq!(out.get("baz.rs"), Some(&0));
    }

    #[test]
    fn numstat_skips_binary_dashes() {
        let raw = "-\t-\tfoo.bin\n4\t2\tsrc/a.ts\n";
        let mut out = ChurnMap::new();
        parse_numstat(raw, &mut out);
        assert!(!out.contains_key("foo.bin"));
        assert_eq!(out.get("src/a.ts"), Some(&6));
    }

    #[test]
    fn numstat_normalises_rename_syntax() {
        let raw = "10\t2\tsrc/{old.rs => new.rs}\n";
        let mut out = ChurnMap::new();
        parse_numstat(raw, &mut out);
        assert_eq!(out.get("new.rs").copied(), Some(12));
    }
}
