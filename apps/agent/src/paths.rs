//! Path validation for file transfer - a Rust port of
//! `packages/shared/src/paths.rs`'s TypeScript sibling
//! (`packages/shared/src/paths.ts`). There is no cross-language schema
//! generation in this repo, so the two are kept in lockstep by hand; the rule
//! list and reasoning below must match that file's doc comment exactly.
//!
//! The controller is authenticated but not trusted to send a well-formed
//! path: every path arriving over the file-transfer data channel is hostile
//! input until proven otherwise. A path is accepted only if it resolves,
//! after canonicalization, inside one of the folders the device owner
//! explicitly shared - never "cleaned up and allowed through."

use std::path::{Component, Path, PathBuf};

#[derive(Debug, PartialEq, Eq)]
pub enum PathRejection {
    Empty,
    Traversal,
    Absolute,
    NullByte,
    UncPath,
    ReservedName,
    TooLong,
    OutsideRoot,
    IllegalCharacter,
}

const MAX_PATH_LENGTH: usize = 4096;
const MAX_SEGMENT_LENGTH: usize = 255;

const RESERVED_WINDOWS_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn has_illegal_character(segment: &str) -> bool {
    segment.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') || (c as u32) < 0x20)
}

/// Validates a client-supplied relative path fragment. Returns the
/// normalized, forward-slash-joined form on success.
pub fn check_relative_path(input: &str) -> Result<String, PathRejection> {
    if input.trim().is_empty() {
        return Err(PathRejection::Empty);
    }
    if input.len() > MAX_PATH_LENGTH {
        return Err(PathRejection::TooLong);
    }
    if input.contains('\0') || input.contains("%00") {
        return Err(PathRejection::NullByte);
    }

    let unified = input.replace('\\', "/");

    if unified.starts_with("//") {
        return Err(PathRejection::UncPath);
    }
    // C:/Windows or C:Windows (drive-absolute or drive-relative) - both are
    // an attempt to reference an absolute filesystem location.
    let bytes = unified.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Err(PathRejection::Absolute);
    }
    if unified.starts_with('/') {
        return Err(PathRejection::Absolute);
    }

    let mut segments: Vec<String> = Vec::new();
    for raw_segment in unified.split('/') {
        let segment = raw_segment.trim();
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            // Rejected outright, never resolved against the accumulated
            // prefix - "a/../../b" must not be allowed to first descend and
            // then escape.
            return Err(PathRejection::Traversal);
        }
        if segment.len() > MAX_SEGMENT_LENGTH {
            return Err(PathRejection::TooLong);
        }
        if has_illegal_character(segment) {
            return Err(PathRejection::IllegalCharacter);
        }
        let stem = segment.split('.').next().unwrap_or("").to_uppercase();
        if RESERVED_WINDOWS_NAMES.contains(&stem.as_str()) {
            return Err(PathRejection::ReservedName);
        }
        // Win32 silently strips trailing dots/spaces, which would otherwise
        // make "secret.txt." and "secret.txt" resolve to the same file after
        // this check already treated them as different names.
        if raw_segment.ends_with('.') || raw_segment.ends_with(' ') {
            return Err(PathRejection::IllegalCharacter);
        }
        segments.push(segment.to_string());
    }

    if segments.is_empty() {
        return Err(PathRejection::Empty);
    }
    Ok(segments.join("/"))
}

/// Containment check for two already-canonicalized absolute paths. Windows
/// paths are case-insensitive, so comparison is too.
pub fn is_inside_root(root: &Path, candidate: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase();
    let root_norm = norm(root);
    let candidate_norm = norm(candidate);
    if root_norm.is_empty() {
        return false;
    }
    candidate_norm == root_norm || candidate_norm.starts_with(&format!("{root_norm}/"))
}

/// Joins a validated relative path onto a shared root, canonicalizes the
/// result (resolving `..`, symlinks and junctions the OS actually honors),
/// and re-asserts containment against the *canonicalized* root. This is the
/// step that a purely lexical check (like `check_relative_path` alone)
/// cannot provide: a symlink that lives inside the root but points outside it
/// would pass a lexical check and only be caught here.
pub fn resolve_within_root(root: &Path, relative: &str) -> Result<PathBuf, PathRejection> {
    let normalized = check_relative_path(relative)?;
    let joined = root.join(normalized.replace('/', std::path::MAIN_SEPARATOR_STR));

    // canonicalize() requires the path to exist, which is correct for reads
    // (list/download/rename/delete all operate on something that must
    // already be there). Callers creating something new (mkdir, the final
    // destination of an upload) canonicalize the *parent* directory instead
    // and join the new, already-validated leaf name back on afterward.
    let canonical_root = root.canonicalize().map_err(|_| PathRejection::OutsideRoot)?;
    let canonical_joined = joined.canonicalize().map_err(|_| PathRejection::OutsideRoot)?;

    if is_inside_root(&canonical_root, &canonical_joined) {
        Ok(canonical_joined)
    } else {
        Err(PathRejection::OutsideRoot)
    }
}

/// Same as `resolve_within_root`, but for a path that is about to be created
/// (upload destination, new folder) and therefore cannot be canonicalized
/// itself yet - only its parent can.
pub fn resolve_new_path_within_root(root: &Path, relative: &str) -> Result<PathBuf, PathRejection> {
    let normalized = check_relative_path(relative)?;
    let rel_path = Path::new(&normalized);

    let parent_relative: PathBuf = rel_path.components().rev().skip(1).collect::<Vec<_>>().into_iter().rev().collect();
    let leaf = rel_path
        .file_name()
        .ok_or(PathRejection::Empty)?
        .to_str()
        .ok_or(PathRejection::IllegalCharacter)?;

    let parent_absolute = if parent_relative.as_os_str().is_empty() {
        root.canonicalize().map_err(|_| PathRejection::OutsideRoot)?
    } else {
        resolve_within_root(root, &parent_relative.to_string_lossy())?
    };

    if !is_inside_root(&root.canonicalize().map_err(|_| PathRejection::OutsideRoot)?, &parent_absolute) {
        return Err(PathRejection::OutsideRoot);
    }

    Ok(parent_absolute.join(leaf))
}

/// Strips any directory components from an upload's client-supplied file
/// name, leaving a bare, already-validated leaf name. Mirrors
/// `sanitizeFileName` in the TypeScript sibling: a traversal attempt in the
/// name is neutralized by discarding the path around it, not by rejecting
/// the upload outright, since the remaining bare name is harmless.
pub fn sanitize_file_name(name: &str) -> Option<String> {
    let base = name.replace('\\', "/");
    let base = base.rsplit('/').next().unwrap_or("");
    match check_relative_path(base) {
        Ok(normalized) if !normalized.contains('/') => Some(normalized),
        _ => None,
    }
}

/// True if `path`, once normalized, is a plain filename with no separators -
/// used to validate the `newName` argument of a rename request, which must
/// never itself smuggle a directory change.
pub fn is_bare_name(name: &str) -> bool {
    matches!(Path::new(name).components().collect::<Vec<_>>().as_slice(), [Component::Normal(_)])
        && sanitize_file_name(name).as_deref() == Some(name)
}
