//! `spec §5 (F)` — hallucinated import check.
//!
//! Resolves each `import` against the lockfile(s) present in the workspace.
//! Supported lockfiles v1:
//! - Python: `requirements.txt`, `pyproject.toml`, `poetry.lock`, `uv.lock`, `Pipfile.lock`
//! - JavaScript/TypeScript: `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`
//!
//! An import is considered hallucinated if its top-level module/package is
//! absent from every applicable lockfile **and** not a stdlib name. Stdlib
//! lists are embedded — see `PYTHON_STDLIB` and `NODE_BUILTINS`.

use crate::contracts::{Diagnostic, DiagnosticSource, Location, Range, Severity};
use crate::parser::Language;
use crate::scanner::{ImportEntry, ScannedFile};
use regex::Regex;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default)]
pub struct LockfileIndex {
    pub python: HashSet<String>,
    pub js: HashSet<String>,
    /// `true` if we found at least one lockfile for that ecosystem.
    pub python_present: bool,
    pub js_present: bool,
}

impl LockfileIndex {
    pub fn from_workspace(root: &Path) -> Self {
        let mut idx = Self::default();
        read_requirements(root, &mut idx);
        read_pyproject(root, &mut idx);
        read_poetry_lock(root, &mut idx);
        read_uv_lock(root, &mut idx);
        read_pipfile_lock(root, &mut idx);
        read_package_json(root, &mut idx);
        read_package_lock(root, &mut idx);
        read_pnpm_lock(root, &mut idx);
        read_yarn_lock(root, &mut idx);
        idx
    }

    pub fn python_has(&self, name: &str) -> bool {
        let lower = name.to_ascii_lowercase().replace('_', "-");
        self.python.contains(&lower) || self.python.contains(name)
    }

    pub fn js_has(&self, name: &str) -> bool {
        self.js.contains(name)
    }
}

fn read_requirements(root: &Path, idx: &mut LockfileIndex) {
    let p = root.join("requirements.txt");
    if let Ok(text) = std::fs::read_to_string(&p) {
        idx.python_present = true;
        for line in text.lines() {
            let line = line.split('#').next().unwrap_or("").trim();
            if line.is_empty() || line.starts_with('-') {
                continue;
            }
            let name = line
                .split(|c: char| matches!(c, '=' | '<' | '>' | '!' | ';' | '[' | ' '))
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
                .replace('_', "-");
            if !name.is_empty() {
                idx.python.insert(name);
            }
        }
    }
}

fn read_pyproject(root: &Path, idx: &mut LockfileIndex) {
    let p = root.join("pyproject.toml");
    let Ok(text) = std::fs::read_to_string(&p) else {
        return;
    };
    idx.python_present = true;
    let value: toml::Value = match toml::from_str(&text) {
        Ok(v) => v,
        Err(_) => return,
    };
    // PEP 621 `[project] dependencies = [...]`
    if let Some(deps) = value
        .get("project")
        .and_then(|p| p.get("dependencies"))
        .and_then(|d| d.as_array())
    {
        for item in deps {
            if let Some(s) = item.as_str() {
                let name = extract_pep508_name(s);
                idx.python.insert(name);
            }
        }
    }
    // Poetry-style `[tool.poetry.dependencies]`
    if let Some(tab) = value
        .get("tool")
        .and_then(|t| t.get("poetry"))
        .and_then(|p| p.get("dependencies"))
        .and_then(|d| d.as_table())
    {
        for k in tab.keys() {
            idx.python.insert(k.to_ascii_lowercase().replace('_', "-"));
        }
    }
}

fn extract_pep508_name(s: &str) -> String {
    s.chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect::<String>()
        .to_ascii_lowercase()
        .replace('_', "-")
}

fn read_poetry_lock(root: &Path, idx: &mut LockfileIndex) {
    let p = root.join("poetry.lock");
    let Ok(text) = std::fs::read_to_string(&p) else {
        return;
    };
    idx.python_present = true;
    let re = Regex::new(r#"(?m)^name\s*=\s*"([^"]+)""#).unwrap();
    for cap in re.captures_iter(&text) {
        idx.python
            .insert(cap[1].to_ascii_lowercase().replace('_', "-"));
    }
}

fn read_uv_lock(root: &Path, idx: &mut LockfileIndex) {
    let p = root.join("uv.lock");
    let Ok(text) = std::fs::read_to_string(&p) else {
        return;
    };
    idx.python_present = true;
    let re = Regex::new(r#"(?m)^name\s*=\s*"([^"]+)""#).unwrap();
    for cap in re.captures_iter(&text) {
        idx.python
            .insert(cap[1].to_ascii_lowercase().replace('_', "-"));
    }
}

fn read_pipfile_lock(root: &Path, idx: &mut LockfileIndex) {
    let p = root.join("Pipfile.lock");
    let Ok(text) = std::fs::read_to_string(&p) else {
        return;
    };
    idx.python_present = true;
    let value: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return,
    };
    for section in ["default", "develop"] {
        if let Some(obj) = value.get(section).and_then(|v| v.as_object()) {
            for k in obj.keys() {
                idx.python.insert(k.to_ascii_lowercase().replace('_', "-"));
            }
        }
    }
}

fn read_package_json(root: &Path, idx: &mut LockfileIndex) {
    let p = root.join("package.json");
    let Ok(text) = std::fs::read_to_string(&p) else {
        return;
    };
    idx.js_present = true;
    let value: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return,
    };
    for section in [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
    ] {
        if let Some(obj) = value.get(section).and_then(|v| v.as_object()) {
            for k in obj.keys() {
                idx.js.insert(k.clone());
            }
        }
    }
}

fn read_package_lock(root: &Path, idx: &mut LockfileIndex) {
    let p = root.join("package-lock.json");
    let Ok(text) = std::fs::read_to_string(&p) else {
        return;
    };
    idx.js_present = true;
    let value: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return,
    };
    if let Some(packages) = value.get("packages").and_then(|v| v.as_object()) {
        for key in packages.keys() {
            if let Some(idx_node) = key.rfind("node_modules/") {
                let name = &key[idx_node + "node_modules/".len()..];
                idx.js.insert(name.to_string());
            }
        }
    }
    if let Some(deps) = value.get("dependencies").and_then(|v| v.as_object()) {
        for k in deps.keys() {
            idx.js.insert(k.clone());
        }
    }
}

fn read_pnpm_lock(root: &Path, idx: &mut LockfileIndex) {
    let p = root.join("pnpm-lock.yaml");
    let Ok(text) = std::fs::read_to_string(&p) else {
        return;
    };
    idx.js_present = true;
    // pnpm lock v6+ lists specifiers under `/@scope/name@version`. We extract the name.
    let re = Regex::new(r"(?m)^\s{2}/([^:\s]+?)@[^:]+:").unwrap();
    for cap in re.captures_iter(&text) {
        let full = &cap[1];
        let name = if let Some(at_idx) = full.find('@') {
            if full.starts_with('@') {
                full.to_string()
            } else {
                full[..at_idx].to_string()
            }
        } else {
            full.to_string()
        };
        idx.js.insert(name);
    }
    // Older pnpm (and direct deps) live under `importers:`, list `specifiers`.
    let re2 = Regex::new(r"(?m)^\s{2,4}([A-Za-z0-9_@/\-.]+):").unwrap();
    for cap in re2.captures_iter(&text) {
        let s = &cap[1];
        if s.contains('/') || !s.contains(' ') {
            idx.js.insert(s.to_string());
        }
    }
}

fn read_yarn_lock(root: &Path, idx: &mut LockfileIndex) {
    let p = root.join("yarn.lock");
    let Ok(text) = std::fs::read_to_string(&p) else {
        return;
    };
    idx.js_present = true;
    // Entries start with `"pkg@range":` or `pkg@range:` — extract the pkg name.
    let re = Regex::new(r#"(?m)^"?([A-Za-z0-9_@/\-.]+)@[^:]+:"?$"#).unwrap();
    for cap in re.captures_iter(&text) {
        let full = &cap[1];
        idx.js.insert(full.to_string());
    }
}

pub fn find_lockfiles(root: &Path) -> Vec<PathBuf> {
    let candidates = [
        "requirements.txt",
        "pyproject.toml",
        "poetry.lock",
        "uv.lock",
        "Pipfile.lock",
        "package.json",
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
    ];
    candidates
        .iter()
        .map(|n| root.join(n))
        .filter(|p| p.exists())
        .collect()
}

pub fn check_file(file: &ScannedFile, idx: &LockfileIndex) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for imp in &file.imports {
        let (is_hallucinated, _ecosystem) = match file.language {
            Language::Python => (
                idx.python_present
                    && !PYTHON_STDLIB.contains(&imp.module.as_str())
                    && !idx.python_has(&imp.module)
                    && !is_relative_python(&imp.module),
                "python",
            ),
            Language::TypeScript | Language::Tsx => (
                idx.js_present
                    && !is_node_builtin(&imp.module)
                    && !is_relative_js(&imp.module)
                    && !idx.js_has(&top_js_package(&imp.module)),
                "js",
            ),
        };
        if is_hallucinated {
            out.push(make_diagnostic(&file.relative_path, imp, &file.language));
        }
    }
    out
}

fn is_node_builtin(module: &str) -> bool {
    if NODE_BUILTINS.contains(&module) {
        return true;
    }
    // `node:fs/promises` → builtin if `fs` is a builtin. Also accept
    // `fs/promises` without the explicit scheme.
    let stripped = module.strip_prefix("node:").unwrap_or(module);
    let head = stripped.split('/').next().unwrap_or(stripped);
    NODE_BUILTINS.contains(&head) || NODE_BUILTINS.contains(&format!("node:{head}").as_str())
}

fn is_relative_python(module: &str) -> bool {
    module.starts_with('.') || module.is_empty()
}

fn is_relative_js(module: &str) -> bool {
    module.starts_with('.') || module.starts_with('/')
}

fn top_js_package(module: &str) -> String {
    if let Some(stripped) = module.strip_prefix('@') {
        let mut parts = stripped.splitn(3, '/');
        let scope = parts.next().unwrap_or("");
        let name = parts.next().unwrap_or("");
        format!("@{}/{}", scope, name)
    } else {
        module.split('/').next().unwrap_or(module).to_string()
    }
}

fn make_diagnostic(file: &str, imp: &ImportEntry, lang: &Language) -> Diagnostic {
    let lockfile_hint = match lang {
        Language::Python => "requirements.txt / pyproject.toml",
        Language::TypeScript | Language::Tsx => "package.json",
    };
    let msg = format!("no package '{}' in {lockfile_hint}", imp.module);
    let id = format!(
        "hallucination:{}:{}:{}",
        file, imp.range_start[0], imp.module
    );
    Diagnostic {
        id,
        severity: Severity::Critical,
        source: DiagnosticSource::IveHallucination,
        code: "ive-hallucination/unknown-import".into(),
        message: msg,
        location: Location {
            file: file.to_string(),
            range: Range {
                start: imp.range_start,
                end: imp.range_end,
            },
        },
        symbol: None,
        related: vec![],
        fix: None,
    }
}

/// Python 3.12 stdlib top-level modules. Short list — the live environment's
/// `sys.stdlib_module_names` should eventually replace this.
pub const PYTHON_STDLIB: &[&str] = &[
    "__future__",
    "abc",
    "argparse",
    "array",
    "ast",
    "asyncio",
    "atexit",
    "base64",
    "bisect",
    "builtins",
    "bz2",
    "calendar",
    "cmath",
    "collections",
    "colorsys",
    "concurrent",
    "contextlib",
    "copy",
    "csv",
    "ctypes",
    "curses",
    "dataclasses",
    "datetime",
    "decimal",
    "difflib",
    "dis",
    "email",
    "enum",
    "errno",
    "faulthandler",
    "filecmp",
    "fileinput",
    "fnmatch",
    "fractions",
    "functools",
    "gc",
    "genericpath",
    "getopt",
    "getpass",
    "glob",
    "gzip",
    "hashlib",
    "heapq",
    "hmac",
    "html",
    "http",
    "importlib",
    "inspect",
    "io",
    "ipaddress",
    "itertools",
    "json",
    "keyword",
    "linecache",
    "locale",
    "logging",
    "lzma",
    "mailbox",
    "marshal",
    "math",
    "mimetypes",
    "multiprocessing",
    "netrc",
    "numbers",
    "operator",
    "optparse",
    "os",
    "pathlib",
    "pdb",
    "pickle",
    "pipes",
    "pkgutil",
    "platform",
    "plistlib",
    "pprint",
    "profile",
    "pstats",
    "queue",
    "quopri",
    "random",
    "re",
    "readline",
    "reprlib",
    "resource",
    "runpy",
    "secrets",
    "select",
    "selectors",
    "shelve",
    "shlex",
    "shutil",
    "signal",
    "site",
    "smtplib",
    "socket",
    "socketserver",
    "sqlite3",
    "ssl",
    "stat",
    "statistics",
    "string",
    "struct",
    "subprocess",
    "symtable",
    "sys",
    "sysconfig",
    "tarfile",
    "telnetlib",
    "tempfile",
    "textwrap",
    "threading",
    "time",
    "timeit",
    "tkinter",
    "token",
    "tokenize",
    "tomllib",
    "trace",
    "traceback",
    "tracemalloc",
    "types",
    "typing",
    "unicodedata",
    "unittest",
    "urllib",
    "uuid",
    "venv",
    "warnings",
    "wave",
    "weakref",
    "webbrowser",
    "wsgiref",
    "xml",
    "xmlrpc",
    "zipfile",
    "zipimport",
    "zlib",
    "zoneinfo",
];

/// Node.js 22 built-in modules.
pub const NODE_BUILTINS: &[&str] = &[
    "assert",
    "async_hooks",
    "buffer",
    "child_process",
    "cluster",
    "console",
    "constants",
    "crypto",
    "dgram",
    "diagnostics_channel",
    "dns",
    "domain",
    "events",
    "fs",
    "http",
    "http2",
    "https",
    "inspector",
    "module",
    "net",
    "os",
    "path",
    "perf_hooks",
    "process",
    "punycode",
    "querystring",
    "readline",
    "repl",
    "stream",
    "string_decoder",
    "timers",
    "tls",
    "trace_events",
    "tty",
    "url",
    "util",
    "v8",
    "vm",
    "wasi",
    "worker_threads",
    "zlib",
    "node:assert",
    "node:async_hooks",
    "node:buffer",
    "node:child_process",
    "node:cluster",
    "node:console",
    "node:crypto",
    "node:dgram",
    "node:dns",
    "node:events",
    "node:fs",
    "node:http",
    "node:https",
    "node:net",
    "node:os",
    "node:path",
    "node:process",
    "node:stream",
    "node:timers",
    "node:tls",
    "node:tty",
    "node:url",
    "node:util",
    "node:worker_threads",
    "node:zlib",
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::Range;
    use crate::parser::FunctionUnit;
    use crate::scanner::ScannedFile;
    use std::io::Write;

    fn tmpdir() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "ive-lock-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn python_requirements_declared_vs_undeclared() {
        let d = tmpdir();
        let mut f = std::fs::File::create(d.join("requirements.txt")).unwrap();
        writeln!(f, "requests==2.31.0").unwrap();
        writeln!(f, "python-dateutil>=2.0").unwrap();
        let idx = LockfileIndex::from_workspace(&d);
        assert!(idx.python_has("requests"));
        assert!(idx.python_has("python_dateutil")); // snake/kebab normalised
        assert!(!idx.python_has("huggingface-utils"));
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn check_file_flags_unknown_python_import() {
        let d = tmpdir();
        let mut f = std::fs::File::create(d.join("requirements.txt")).unwrap();
        writeln!(f, "requests").unwrap();
        let idx = LockfileIndex::from_workspace(&d);
        let sf = ScannedFile {
            relative_path: "a.py".into(),
            language: Language::Python,
            loc: 3,
            functions: Vec::<FunctionUnit>::new(),
            imports: vec![ImportEntry {
                module: "huggingface_utils".into(),
                range_start: [0, 0],
                range_end: [0, 24],
            }],
            blob_sha: "x".into(),
            bytes_read: 0,
            location: Location {
                file: "a.py".into(),
                range: Range {
                    start: [0, 0],
                    end: [2, 0],
                },
            },
        };
        let diags = check_file(&sf, &idx);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].code, "ive-hallucination/unknown-import");
        assert_eq!(diags[0].severity, Severity::Critical);
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn stdlib_imports_never_flag() {
        let d = tmpdir();
        std::fs::write(d.join("requirements.txt"), "").unwrap();
        let idx = LockfileIndex::from_workspace(&d);
        let sf = ScannedFile {
            relative_path: "a.py".into(),
            language: Language::Python,
            loc: 1,
            functions: vec![],
            imports: vec![ImportEntry {
                module: "os".into(),
                range_start: [0, 0],
                range_end: [0, 8],
            }],
            blob_sha: "x".into(),
            bytes_read: 0,
            location: Location {
                file: "a.py".into(),
                range: Range {
                    start: [0, 0],
                    end: [0, 0],
                },
            },
        };
        assert!(check_file(&sf, &idx).is_empty());
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn scoped_npm_package_normalises() {
        assert_eq!(top_js_package("@scope/pkg/sub"), "@scope/pkg");
        assert_eq!(top_js_package("lodash/fp"), "lodash");
    }

    #[test]
    fn node_subpath_imports_are_builtins() {
        assert!(is_node_builtin("fs"));
        assert!(is_node_builtin("fs/promises"));
        assert!(is_node_builtin("node:fs"));
        assert!(is_node_builtin("node:fs/promises"));
        assert!(is_node_builtin("path"));
        assert!(!is_node_builtin("imaginary-package"));
    }
}
