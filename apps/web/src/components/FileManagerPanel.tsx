import {
  FILE_CHUNK_SIZE,
  parseFileControlMessage,
  type FileControlMessage,
  type FileEntry,
} from '@minedesk/protocol';
import { formatBytes, formatEta, formatSpeed } from '@minedesk/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

interface FileManagerPanelProps {
  channel: RTCDataChannel | null;
  canUpload: boolean;
  canDownload: boolean;
  canDelete: boolean;
  onClose: () => void;
  /** Called once a transfer actually starts, so the session's access history
   * can record that file transfer was used - the API has no other way to
   * see this, since transfers happen entirely over the peer-to-peer channel. */
  onTransferStarted?: () => void;
}

type TransferDirection = 'upload' | 'download';

interface TransferState {
  id: string;
  direction: TransferDirection;
  fileName: string;
  size: number;
  transferredBytes: number;
  startedAt: number;
  status: 'active' | 'done' | 'error' | 'cancelled';
  error?: string;
}

/**
 * Self-contained file browser and transfer UI, wired directly to the
 * `md-files` DataChannel. One transfer at a time, matching the agent - see
 * `packages/protocol/src/filetransfer.ts` for why that constraint exists.
 */
export function FileManagerPanel({ channel, canUpload, canDownload, canDelete, onClose, onTransferStarted }: FileManagerPanelProps) {
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<TransferState | null>(null);

  const requestIdRef = useRef<string | null>(null);
  const transferRef = useRef<TransferState | null>(null);
  const downloadChunksRef = useRef<Uint8Array[]>([]);
  const uploadFileRef = useRef<File | null>(null);
  const uploadOffsetRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    transferRef.current = transfer;
  }, [transfer]);

  const send = useCallback(
    (message: FileControlMessage) => {
      if (channel && channel.readyState === 'open') channel.send(JSON.stringify(message));
    },
    [channel],
  );

  const listPath = useCallback(
    (target: string) => {
      const requestId = crypto.randomUUID();
      requestIdRef.current = requestId;
      setError(null);
      send({ type: 'file:list', requestId, path: target });
    },
    [send],
  );

  useEffect(() => {
    if (!channel) return;
    channel.binaryType = 'arraybuffer';

    function handleMessage(event: MessageEvent) {
      if (typeof event.data === 'string') {
        const message = parseFileControlMessage(event.data);
        if (!message) return;
        handleControlMessage(message);
      } else {
        handleChunk(event.data as ArrayBuffer);
      }
    }

    function handleControlMessage(message: FileControlMessage) {
      switch (message.type) {
        case 'file:list:result':
          if (message.requestId === requestIdRef.current) {
            setPath(message.path);
            setEntries(message.entries);
          }
          return;

        case 'file:error':
          setError(message.message);
          if (message.transferId && transferRef.current?.id === message.transferId) {
            setTransfer((t) => (t ? { ...t, status: 'error', error: message.message } : t));
          }
          return;

        case 'file:ok':
          listPath(path);
          return;

        case 'upload:ready':
          startSendingChunks();
          return;

        case 'upload:finished':
          setTransfer((t) => (t && t.id === message.transferId ? { ...t, status: 'done', transferredBytes: t.size } : t));
          listPath(path);
          return;

        case 'download:info':
          downloadChunksRef.current = [];
          setTransfer({
            id: message.transferId,
            direction: 'download',
            fileName: message.fileName,
            size: message.size,
            transferredBytes: 0,
            startedAt: Date.now(),
            status: 'active',
          });
          return;

        case 'download:complete': {
          const t = transferRef.current;
          if (t?.id === message.transferId) {
            finishDownload(t.fileName);
            setTransfer({ ...t, status: 'done', transferredBytes: t.size });
          }
          return;
        }

        case 'transfer:progress':
          setTransfer((t) => (t && t.id === message.transferId ? { ...t, transferredBytes: message.transferredBytes } : t));
          return;

        default:
          return;
      }
    }

    function handleChunk(buffer: ArrayBuffer) {
      const t = transferRef.current;
      if (!t || t.direction !== 'download') return;
      downloadChunksRef.current.push(new Uint8Array(buffer));
      setTransfer((current) =>
        current ? { ...current, transferredBytes: current.transferredBytes + buffer.byteLength } : current,
      );
    }

    function finishDownload(fileName: string) {
      const blob = new Blob(downloadChunksRef.current as BlobPart[]);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);
      downloadChunksRef.current = [];
    }

    function startSendingChunks() {
      const selectedFile = uploadFileRef.current;
      if (!selectedFile || !channel) return;
      // Rebound to a definitely-non-null local: TypeScript's narrowing of the
      // ref read above does not carry into the nested closure below.
      const file: File = selectedFile;
      uploadOffsetRef.current = 0;

      function sendNextChunk() {
        if (!channel || channel.readyState !== 'open') return;
        // Backpressure: pause sending once the channel's own send buffer gets
        // large, resuming when it drains - otherwise a fast reader-less loop
        // would buffer an entire large file in browser memory at once.
        if (channel.bufferedAmount > FILE_CHUNK_SIZE * 8) {
          setTimeout(sendNextChunk, 20);
          return;
        }

        const offset = uploadOffsetRef.current;
        if (offset >= file.size) {
          const t = transferRef.current;
          if (t) send({ type: 'upload:complete', transferId: t.id });
          return;
        }

        const slice = file.slice(offset, offset + FILE_CHUNK_SIZE);
        slice.arrayBuffer().then((buffer) => {
          if (channel.readyState !== 'open') return;
          channel.send(buffer);
          uploadOffsetRef.current += buffer.byteLength;
          setTransfer((current) => (current ? { ...current, transferredBytes: uploadOffsetRef.current } : current));
          sendNextChunk();
        });
      }

      sendNextChunk();
    }

    channel.addEventListener('message', handleMessage);
    channel.addEventListener('open', () => listPath(''));
    if (channel.readyState === 'open') listPath('');

    return () => channel.removeEventListener('message', handleMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);

  function navigateTo(entry: FileEntry) {
    if (!entry.isDirectory) return;
    const next = path ? `${path}/${entry.name}` : entry.name;
    listPath(next);
  }

  function navigateUp() {
    const parts = path.split('/').filter(Boolean);
    parts.pop();
    listPath(parts.join('/'));
  }

  function handleCreateFolder() {
    const name = prompt('Folder name');
    if (!name) return;
    send({ type: 'file:mkdir', requestId: crypto.randomUUID(), path, name });
  }

  function handleRename(entry: FileEntry) {
    const newName = prompt('New name', entry.name);
    if (!newName || newName === entry.name) return;
    const entryPath = path ? `${path}/${entry.name}` : entry.name;
    send({ type: 'file:rename', requestId: crypto.randomUUID(), path: entryPath, newName });
  }

  function handleDelete(entry: FileEntry) {
    if (!confirm(`Delete ${entry.name}? This cannot be undone.`)) return;
    const entryPath = path ? `${path}/${entry.name}` : entry.name;
    send({ type: 'file:delete', requestId: crypto.randomUUID(), path: entryPath });
  }

  function handleDownload(entry: FileEntry) {
    if (transfer && transfer.status === 'active') return;
    const entryPath = path ? `${path}/${entry.name}` : entry.name;
    send({ type: 'download:start', transferId: crypto.randomUUID(), path: entryPath });
    onTransferStarted?.();
  }

  function handleUploadClick() {
    fileInputRef.current?.click();
  }

  function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || (transfer && transfer.status === 'active')) return;

    const transferId = crypto.randomUUID();
    uploadFileRef.current = file;
    setTransfer({ id: transferId, direction: 'upload', fileName: file.name, size: file.size, transferredBytes: 0, startedAt: Date.now(), status: 'active' });
    send({ type: 'upload:start', transferId, path, fileName: file.name, size: file.size });
    onTransferStarted?.();
  }

  function handleCancelTransfer() {
    if (!transfer) return;
    send({ type: 'transfer:cancel', transferId: transfer.id });
    setTransfer({ ...transfer, status: 'cancelled' });
  }

  const breadcrumbs = path.split('/').filter(Boolean);

  return (
    <div className="absolute inset-y-0 right-0 flex w-96 flex-col border-l border-zinc-800 bg-zinc-900 text-zinc-100 shadow-xl">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h2 className="text-sm font-semibold">Files</h2>
        <button type="button" className="btn-ghost !text-zinc-300" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2 text-xs text-zinc-400">
        <button type="button" className="hover:text-white disabled:opacity-30" onClick={navigateUp} disabled={breadcrumbs.length === 0}>
          &uarr; Up
        </button>
        <span className="truncate">/{breadcrumbs.join('/')}</span>
      </div>

      <div className="flex gap-2 border-b border-zinc-800 px-4 py-2">
        {canUpload && (
          <button type="button" className="btn-secondary !bg-zinc-800 !text-zinc-100" onClick={handleUploadClick}>
            Upload
          </button>
        )}
        {canUpload && (
          <button type="button" className="btn-secondary !bg-zinc-800 !text-zinc-100" onClick={handleCreateFolder}>
            New folder
          </button>
        )}
        <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileSelected} />
      </div>

      {error && <div className="border-b border-red-900 bg-red-950 px-4 py-2 text-xs text-red-300">{error}</div>}

      {transfer && (
        <div className="border-b border-zinc-800 px-4 py-3 text-xs">
          <div className="mb-1 flex items-center justify-between">
            <span className="truncate font-medium">
              {transfer.direction === 'upload' ? 'Uploading' : 'Downloading'} {transfer.fileName}
            </span>
            {transfer.status === 'active' && (
              <button type="button" className="text-red-400 hover:underline" onClick={handleCancelTransfer}>
                Cancel
              </button>
            )}
          </div>
          <div className="mb-1 h-1.5 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full bg-brand-500 transition-all"
              style={{ width: `${transfer.size ? Math.min(100, (transfer.transferredBytes / transfer.size) * 100) : 0}%` }}
            />
          </div>
          <TransferStats transfer={transfer} />
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {entries === null ? (
          <p className="p-4 text-xs text-zinc-500">Loading...</p>
        ) : entries.length === 0 ? (
          <p className="p-4 text-xs text-zinc-500">This folder is empty.</p>
        ) : (
          <ul className="divide-y divide-zinc-800">
            {entries.map((entry) => (
              <li key={entry.name} className="flex items-center justify-between px-4 py-2 text-sm">
                <button
                  type="button"
                  className="flex flex-1 items-center gap-2 truncate text-left hover:text-brand-400"
                  onClick={() => navigateTo(entry)}
                  disabled={!entry.isDirectory}
                >
                  <span aria-hidden>{entry.isDirectory ? '\u{1F4C1}' : '\u{1F4C4}'}</span>
                  <span className="truncate">{entry.name}</span>
                </button>
                <div className="flex shrink-0 items-center gap-2 text-xs text-zinc-500">
                  {!entry.isDirectory && <span>{formatBytes(entry.size)}</span>}
                  {!entry.isDirectory && canDownload && (
                    <button type="button" className="hover:text-brand-400" onClick={() => handleDownload(entry)}>
                      Download
                    </button>
                  )}
                  {canDelete && (
                    <button type="button" className="hover:text-brand-400" onClick={() => handleRename(entry)}>
                      Rename
                    </button>
                  )}
                  {canDelete && (
                    <button type="button" className="hover:text-red-400" onClick={() => handleDelete(entry)}>
                      Delete
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TransferStats({ transfer }: { transfer: TransferState }) {
  const elapsedSeconds = (Date.now() - transfer.startedAt) / 1000;
  const speed = elapsedSeconds > 0 ? transfer.transferredBytes / elapsedSeconds : 0;
  const remaining = speed > 0 ? (transfer.size - transfer.transferredBytes) / speed : 0;

  return (
    <div className="flex justify-between text-zinc-400">
      <span>
        {formatBytes(transfer.transferredBytes)} / {formatBytes(transfer.size)}
      </span>
      {transfer.status === 'active' ? (
        <span>
          {formatSpeed(speed)} &middot; {formatEta(remaining)} left
        </span>
      ) : (
        <span className="capitalize">{transfer.status}</span>
      )}
    </div>
  );
}
