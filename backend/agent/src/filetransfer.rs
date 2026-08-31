//! File transfer over the `md-files` DataChannel.
//!
//! One transfer (upload or download) is active at a time per session, by
//! design - see the protocol doc comment in
//! `backend/src/vendor/protocol/filetransfer.ts`. This module owns that
//! constraint: a second `upload:start`/`download:start` while one is running
//! is rejected with `file:error`, not queued.
//!
//! Every path the controller sends is validated by `paths.rs` before it ever
//! reaches a filesystem call - see that module for the threat model. Nothing
//! here trusts a path just because it "looks fine" after light cleanup.

use crate::paths::{self, PathRejection};
use crate::protocol::{FileControlIn, FileControlOut, FileEntry, FILE_CHUNK_SIZE};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tracing::warn;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;

/// Which operations this session is authorized to perform. Checked on every
/// request, independently of whatever the controller's own UI does or does
/// not let a person click - a permission the owner disabled must be refused
/// here even if a client were modified to ask anyway.
#[derive(Clone, Copy)]
pub struct FilePermissions {
    pub upload: bool,
    pub download: bool,
    pub delete: bool,
}

enum ActiveTransfer {
    Upload { transfer_id: String, file: File, destination: PathBuf, expected_size: u64, written: u64 },
    Download { transfer_id: String, task: JoinHandle<()> },
}

struct Inner {
    /// Basename -> canonical absolute path, one entry per configured shared
    /// folder. The controller only ever sees the basename-rooted virtual
    /// path, never the real absolute path on disk.
    roots: HashMap<String, PathBuf>,
    permissions: FilePermissions,
    active: Option<ActiveTransfer>,
}

pub struct FileTransferHandler {
    inner: Arc<Mutex<Inner>>,
}

impl FileTransferHandler {
    pub fn new(channel: Arc<RTCDataChannel>, shared_folders: &[String], permissions: FilePermissions) -> Self {
        let mut roots = HashMap::new();
        for folder in shared_folders {
            let path = PathBuf::from(folder);
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| folder.clone());
            roots.insert(name, path);
        }

        let inner = Arc::new(Mutex::new(Inner { roots, permissions, active: None }));
        let handler = Self { inner: inner.clone() };

        // A clone dedicated to the closure: `channel.on_message(...)` needs
        // `channel` itself as its receiver, which conflicts with a `move`
        // closure that also wants to consume a binding named `channel` from
        // the enclosing scope in the same expression. The handler itself
        // never needs the channel again after wiring this up - every reply
        // it sends is scoped to one message and gets its own channel clone
        // via `dispatch`.
        let channel_for_handler = channel.clone();
        channel.on_message(Box::new(move |msg: DataChannelMessage| {
            let inner = inner.clone();
            let channel = channel_for_handler.clone();
            Box::pin(async move {
                if let Err(err) = dispatch(inner, channel, msg).await {
                    warn!(error = %err, "file transfer message handling failed");
                }
            })
        }));

        handler
    }

    /// Called when the session ends, so an in-progress download's background
    /// task doesn't keep reading and sending after the channel is gone.
    pub async fn abort_active_transfer(&self) {
        let mut inner = self.inner.lock().await;
        if let Some(ActiveTransfer::Download { task, .. }) = inner.active.take() {
            task.abort();
        }
    }
}

async fn dispatch(inner: Arc<Mutex<Inner>>, channel: Arc<RTCDataChannel>, msg: DataChannelMessage) -> anyhow::Result<()> {
    if msg.is_string {
        let text = String::from_utf8(msg.data.to_vec())?;
        let Ok(control) = serde_json::from_str::<FileControlIn>(&text) else {
            warn!(raw = %text, "could not parse file control message");
            return Ok(());
        };
        handle_control(inner, channel, control).await
    } else {
        handle_chunk(inner, msg.data.to_vec()).await
    }
}

async fn send(channel: &RTCDataChannel, message: &FileControlOut) -> anyhow::Result<()> {
    let json = serde_json::to_string(message)?;
    channel.send_text(json).await?;
    Ok(())
}

fn error_code(rejection: &PathRejection) -> &'static str {
    match rejection {
        PathRejection::OutsideRoot | PathRejection::Traversal | PathRejection::Absolute | PathRejection::UncPath => {
            "PATH_NOT_ALLOWED"
        }
        _ => "VALIDATION_ERROR",
    }
}

/// Splits a virtual path (`"<shared-folder-basename>/rest/of/path"`) into the
/// real root it refers to and the remainder to resolve inside it. The empty
/// path resolves to `None`, meaning "list the shared folders themselves."
fn split_virtual_path<'a>(roots: &'a HashMap<String, PathBuf>, virtual_path: &str) -> Option<(&'a Path, String)> {
    let trimmed = virtual_path.trim_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let mut parts = trimmed.splitn(2, '/');
    let root_name = parts.next()?;
    let rest = parts.next().unwrap_or("").to_string();
    roots.get(root_name).map(|root| (root.as_path(), rest))
}

async fn handle_control(inner: Arc<Mutex<Inner>>, channel: Arc<RTCDataChannel>, control: FileControlIn) -> anyhow::Result<()> {
    match control {
        FileControlIn::FileList { request_id, path } => {
            // The lock is held only long enough to resolve and validate the
            // target directory - never across the directory read itself,
            // which is real (if usually fast) disk I/O and would otherwise
            // block every other control message for this session, including
            // a transfer:cancel or the session teardown that runs when the
            // session ends, for as long as the read takes.
            enum Resolved {
                VirtualRoot(Vec<FileEntry>),
                Directory(PathBuf),
                NotAllowed,
            }

            let resolved = {
                let guard = inner.lock().await;
                match split_virtual_path(&guard.roots, &path) {
                    None => Resolved::VirtualRoot(
                        guard
                            .roots
                            .keys()
                            .map(|name| FileEntry { name: name.clone(), is_directory: true, size: 0, modified_at: None })
                            .collect(),
                    ),
                    Some((root, rest)) => {
                        let dir = if rest.is_empty() { root.canonicalize().ok() } else { paths::resolve_within_root(root, &rest).ok() };
                        match dir {
                            Some(dir) => Resolved::Directory(dir),
                            None => Resolved::NotAllowed,
                        }
                    }
                }
            };

            let entries = match resolved {
                Resolved::VirtualRoot(entries) => entries,
                Resolved::NotAllowed => {
                    return send(
                        &channel,
                        &FileControlOut::FileError {
                            request_id: Some(request_id),
                            transfer_id: None,
                            code: "PATH_NOT_ALLOWED".into(),
                            message: "That location is outside the folders shared with you.".into(),
                        },
                    )
                    .await;
                }
                Resolved::Directory(dir) => match list_directory(&dir).await {
                    Ok(entries) => entries,
                    Err(err) => {
                        return send(
                            &channel,
                            &FileControlOut::FileError {
                                request_id: Some(request_id),
                                transfer_id: None,
                                code: "FILE_NOT_FOUND".into(),
                                message: format!("Could not read that folder: {err}"),
                            },
                        )
                        .await;
                    }
                },
            };

            send(&channel, &FileControlOut::FileListResult { request_id, path, entries }).await
        }

        FileControlIn::FileMkdir { request_id, path, name } => {
            let guard = inner.lock().await;
            if !guard.permissions.upload {
                drop(guard);
                return permission_denied(&channel, Some(request_id), None).await;
            }
            let result = resolve_new_entry(&guard, &path, &name);
            drop(guard);

            match result {
                Ok(target) => match tokio::fs::create_dir(&target).await {
                    Ok(()) => send(&channel, &FileControlOut::FileOk { request_id }).await,
                    Err(err) => file_error(&channel, Some(request_id), "FILE_TRANSFER_FAILED", &err.to_string()).await,
                },
                Err(rejection) => file_error(&channel, Some(request_id), error_code(&rejection), "That name is not allowed.").await,
            }
        }

        FileControlIn::FileRename { request_id, path, new_name } => {
            let guard = inner.lock().await;
            if !guard.permissions.delete {
                drop(guard);
                return permission_denied(&channel, Some(request_id), None).await;
            }
            if !paths::is_bare_name(&new_name) {
                drop(guard);
                return file_error(&channel, Some(request_id), "VALIDATION_ERROR", "That name is not allowed.").await;
            }

            let source = match split_virtual_path(&guard.roots, &path).and_then(|(root, rest)| {
                paths::resolve_within_root(root, &rest).ok()
            }) {
                Some(p) => p,
                None => {
                    drop(guard);
                    return file_error(&channel, Some(request_id), "FILE_NOT_FOUND", "That file could not be found.").await;
                }
            };
            let destination = source.with_file_name(&new_name);
            drop(guard);

            match tokio::fs::rename(&source, &destination).await {
                Ok(()) => send(&channel, &FileControlOut::FileOk { request_id }).await,
                Err(err) => file_error(&channel, Some(request_id), "FILE_TRANSFER_FAILED", &err.to_string()).await,
            }
        }

        FileControlIn::FileDelete { request_id, path } => {
            let guard = inner.lock().await;
            if !guard.permissions.delete {
                drop(guard);
                return permission_denied(&channel, Some(request_id), None).await;
            }
            let target = split_virtual_path(&guard.roots, &path).and_then(|(root, rest)| paths::resolve_within_root(root, &rest).ok());
            drop(guard);

            let Some(target) = target else {
                return file_error(&channel, Some(request_id), "FILE_NOT_FOUND", "That file could not be found.").await;
            };

            let result = if tokio::fs::metadata(&target).await.map(|m| m.is_dir()).unwrap_or(false) {
                tokio::fs::remove_dir_all(&target).await
            } else {
                tokio::fs::remove_file(&target).await
            };

            match result {
                Ok(()) => send(&channel, &FileControlOut::FileOk { request_id }).await,
                Err(err) => file_error(&channel, Some(request_id), "FILE_TRANSFER_FAILED", &err.to_string()).await,
            }
        }

        FileControlIn::UploadStart { transfer_id, path, file_name, size } => {
            let mut guard = inner.lock().await;
            if !guard.permissions.upload {
                drop(guard);
                return permission_denied(&channel, None, Some(transfer_id)).await;
            }
            if guard.active.is_some() {
                drop(guard);
                return send(
                    &channel,
                    &FileControlOut::FileError {
                        request_id: None,
                        transfer_id: Some(transfer_id),
                        code: "CONFLICT".into(),
                        message: "A transfer is already in progress.".into(),
                    },
                )
                .await;
            }

            let Some(safe_name) = paths::sanitize_file_name(&file_name) else {
                drop(guard);
                return file_error(&channel, None, "VALIDATION_ERROR", "That file name is not allowed.").await;
            };

            let destination = match resolve_new_entry(&guard, &path, &safe_name) {
                Ok(dest) => dest,
                Err(rejection) => {
                    drop(guard);
                    return send(
                        &channel,
                        &FileControlOut::FileError {
                            request_id: None,
                            transfer_id: Some(transfer_id),
                            code: error_code(&rejection).into(),
                            message: "That location is not allowed.".into(),
                        },
                    )
                    .await;
                }
            };

            match File::create(&destination).await {
                Ok(file) => {
                    guard.active = Some(ActiveTransfer::Upload { transfer_id: transfer_id.clone(), file, destination, expected_size: size, written: 0 });
                    drop(guard);
                    send(&channel, &FileControlOut::UploadReady { transfer_id }).await
                }
                Err(err) => {
                    drop(guard);
                    send(
                        &channel,
                        &FileControlOut::FileError {
                            request_id: None,
                            transfer_id: Some(transfer_id),
                            code: "FILE_TRANSFER_FAILED".into(),
                            message: err.to_string(),
                        },
                    )
                    .await
                }
            }
        }

        FileControlIn::UploadComplete { transfer_id } => {
            let mut guard = inner.lock().await;
            let matches = matches!(&guard.active, Some(ActiveTransfer::Upload { transfer_id: id, .. }) if *id == transfer_id);
            if !matches {
                drop(guard);
                return Ok(());
            }

            if let Some(ActiveTransfer::Upload { file, expected_size, written, destination, .. }) = guard.active.take() {
                drop(file); // flush by drop; tokio::fs::File flushes on close
                drop(guard);

                if written != expected_size {
                    let _ = tokio::fs::remove_file(&destination).await;
                    return send(
                        &channel,
                        &FileControlOut::FileError {
                            request_id: None,
                            transfer_id: Some(transfer_id),
                            code: "FILE_TRANSFER_FAILED".into(),
                            message: format!("Expected {expected_size} bytes but received {written}."),
                        },
                    )
                    .await;
                }
                send(&channel, &FileControlOut::UploadFinished { transfer_id }).await
            } else {
                Ok(())
            }
        }

        FileControlIn::DownloadStart { transfer_id, path } => {
            let mut guard = inner.lock().await;
            if !guard.permissions.download {
                drop(guard);
                return permission_denied(&channel, None, Some(transfer_id)).await;
            }
            if guard.active.is_some() {
                drop(guard);
                return send(
                    &channel,
                    &FileControlOut::FileError {
                        request_id: None,
                        transfer_id: Some(transfer_id),
                        code: "CONFLICT".into(),
                        message: "A transfer is already in progress.".into(),
                    },
                )
                .await;
            }

            let resolved = split_virtual_path(&guard.roots, &path).and_then(|(root, rest)| paths::resolve_within_root(root, &rest).ok());
            let Some(source) = resolved else {
                drop(guard);
                return file_error(&channel, None, "FILE_NOT_FOUND", "That file could not be found.").await;
            };

            let metadata = match tokio::fs::metadata(&source).await {
                Ok(m) if m.is_file() => m,
                _ => {
                    drop(guard);
                    return file_error(&channel, None, "FILE_NOT_FOUND", "That file could not be found.").await;
                }
            };

            let file_name = source.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let size = metadata.len();
            let channel_for_task = channel.clone();
            let transfer_id_for_task = transfer_id.clone();
            let inner_for_task = inner.clone();

            let task = tokio::spawn(async move {
                if let Err(err) = stream_download(channel_for_task.clone(), transfer_id_for_task.clone(), source, size).await {
                    warn!(error = %err, "download failed");
                    let _ = send(
                        &channel_for_task,
                        &FileControlOut::FileError {
                            request_id: None,
                            transfer_id: Some(transfer_id_for_task.clone()),
                            code: "FILE_TRANSFER_FAILED".into(),
                            message: err.to_string(),
                        },
                    )
                    .await;
                }
                inner_for_task.lock().await.active = None;
            });

            guard.active = Some(ActiveTransfer::Download { transfer_id: transfer_id.clone(), task });
            drop(guard);
            send(&channel, &FileControlOut::DownloadInfo { transfer_id, file_name, size }).await
        }

        FileControlIn::TransferCancel { transfer_id } => {
            let mut guard = inner.lock().await;
            let cancel = match &guard.active {
                Some(ActiveTransfer::Upload { transfer_id: id, .. }) => *id == transfer_id,
                Some(ActiveTransfer::Download { transfer_id: id, .. }) => *id == transfer_id,
                None => false,
            };
            if cancel {
                if let Some(ActiveTransfer::Upload { destination, .. }) = guard.active.take() {
                    let _ = tokio::fs::remove_file(&destination).await;
                } else if let Some(ActiveTransfer::Download { task, .. }) = guard.active.take() {
                    task.abort();
                }
            }
            Ok(())
        }

        FileControlIn::Unhandled => Ok(()),
    }
}

async fn handle_chunk(inner: Arc<Mutex<Inner>>, chunk: Vec<u8>) -> anyhow::Result<()> {
    let mut guard = inner.lock().await;
    if let Some(ActiveTransfer::Upload { file, written, expected_size, .. }) = &mut guard.active {
        // A client that sends more than it declared is either buggy or
        // testing the boundary; either way the transfer is rejected rather
        // than silently truncated or allowed to grow past what was agreed.
        if *written + chunk.len() as u64 > *expected_size {
            anyhow::bail!("received more data than the declared upload size");
        }
        file.write_all(&chunk).await?;
        *written += chunk.len() as u64;
    }
    Ok(())
}

async fn stream_download(channel: Arc<RTCDataChannel>, transfer_id: String, path: PathBuf, size: u64) -> anyhow::Result<()> {
    let mut file = File::open(&path).await?;
    let mut buffer = vec![0u8; FILE_CHUNK_SIZE];
    let mut sent: u64 = 0;

    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }

        // Simple poll-based backpressure: a proper implementation would use
        // RTCDataChannel's on_buffered_amount_low event instead of sleeping
        // and rechecking, but this keeps a large download from ballooning
        // the channel's send buffer without adding another callback wiring.
        while channel.buffered_amount().await > 4 * FILE_CHUNK_SIZE {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }

        channel.send(&bytes::Bytes::copy_from_slice(&buffer[..read])).await?;
        sent += read as u64;

        if sent % (FILE_CHUNK_SIZE as u64 * 16) == 0 || sent == size {
            let _ = send(&channel, &FileControlOut::TransferProgress { transfer_id: transfer_id.clone(), transferred_bytes: sent }).await;
        }
    }

    send(&channel, &FileControlOut::DownloadComplete { transfer_id }).await
}

async fn list_directory(dir: &Path) -> std::io::Result<Vec<FileEntry>> {
    let mut entries = Vec::new();
    let mut read_dir = tokio::fs::read_dir(dir).await?;
    while let Some(entry) = read_dir.next_entry().await? {
        let metadata = entry.metadata().await?;
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);

        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            is_directory: metadata.is_dir(),
            size: if metadata.is_dir() { 0 } else { metadata.len() },
            modified_at,
        });
    }
    Ok(entries)
}

fn resolve_new_entry(guard: &Inner, path: &str, name: &str) -> Result<PathBuf, PathRejection> {
    let Some((root, rest)) = split_virtual_path(&guard.roots, path) else {
        return Err(PathRejection::OutsideRoot);
    };
    let combined = if rest.is_empty() { name.to_string() } else { format!("{rest}/{name}") };
    paths::resolve_new_path_within_root(root, &combined)
}

async fn file_error(channel: &RTCDataChannel, request_id: Option<String>, code: &str, message: &str) -> anyhow::Result<()> {
    send(channel, &FileControlOut::FileError { request_id, transfer_id: None, code: code.into(), message: message.into() }).await
}

async fn permission_denied(channel: &RTCDataChannel, request_id: Option<String>, transfer_id: Option<String>) -> anyhow::Result<()> {
    send(
        channel,
        &FileControlOut::FileError {
            request_id,
            transfer_id,
            code: "PERMISSION_DENIED".into(),
            message: "That action is not permitted for this session.".into(),
        },
    )
    .await
}
