import { z } from 'zod';

/**
 * File-transfer protocol carried over its own reliable, ordered DataChannel
 * (`FILE_CHANNEL`), separate from input events so a large transfer's buffered
 * bytes never delay a mouse click or keypress sitting behind it in the same
 * SCTP stream.
 *
 * Design choices that matter for correctness:
 *   - One transfer at a time per session. Binary chunks are sent as raw,
 *     untagged DataChannel messages in order - correct only because the
 *     channel is reliable/ordered *and* there is never more than one transfer
 *     in flight to interleave. `activeTransferId` on both ends enforces this;
 *     a second `upload:start`/`download:start` while one is active is
 *     rejected rather than queued, which keeps the protocol simple instead of
 *     silently correct only by accident.
 *   - All paths are relative to whatever root the device owner shared
 *     (`DevicePermission.sharedFolders`). They are validated identically on
 *     the agent using the same rules as `@minedesk/shared`'s
 *     `checkRelativePath` - see that module's doc comment for the threat
 *     model. The browser never learns the absolute path on disk.
 *   - Every request carries a `requestId` (metadata ops) or `transferId`
 *     (upload/download) so a slow response arriving after the UI moved on
 *     can still be matched to the request that caused it, or discarded.
 */

export const FILE_CHANNEL = 'md-files';

/** Maximum single chunk size sent over the data channel, in bytes. */
export const FILE_CHUNK_SIZE = 64 * 1024;

const relativePath = z.string().max(4096);

// ---------------------------------------------------------- directory ops

export const FileListRequest = z.object({
  type: z.literal('file:list'),
  requestId: z.string().uuid(),
  path: relativePath,
});

export const FileEntrySchema = z.object({
  name: z.string(),
  isDirectory: z.boolean(),
  size: z.number().nonnegative(),
  modifiedAt: z.number().int().nullable(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

export const FileListResult = z.object({
  type: z.literal('file:list:result'),
  requestId: z.string().uuid(),
  path: relativePath,
  entries: z.array(FileEntrySchema),
});

export const FileMkdirRequest = z.object({
  type: z.literal('file:mkdir'),
  requestId: z.string().uuid(),
  path: relativePath,
  name: z.string().min(1).max(255),
});

export const FileRenameRequest = z.object({
  type: z.literal('file:rename'),
  requestId: z.string().uuid(),
  path: relativePath,
  newName: z.string().min(1).max(255),
});

export const FileDeleteRequest = z.object({
  type: z.literal('file:delete'),
  requestId: z.string().uuid(),
  path: relativePath,
});

export const FileOpAck = z.object({
  type: z.literal('file:ok'),
  requestId: z.string().uuid(),
});

export const FileOpError = z.object({
  type: z.literal('file:error'),
  requestId: z.string().uuid().optional(),
  transferId: z.string().uuid().optional(),
  code: z.string(),
  message: z.string(),
});

// -------------------------------------------------------------- transfers

/** Controller -> agent: begin sending a file into `path` on the remote. */
export const UploadStart = z.object({
  type: z.literal('upload:start'),
  transferId: z.string().uuid(),
  path: relativePath,
  fileName: z.string().min(1).max(255),
  size: z.number().nonnegative(),
});

export const UploadReady = z.object({
  type: z.literal('upload:ready'),
  transferId: z.string().uuid(),
});

/** Controller -> agent, sent once all binary chunks have been transmitted. */
export const UploadComplete = z.object({
  type: z.literal('upload:complete'),
  transferId: z.string().uuid(),
});

/** Agent -> controller: the file was written successfully. */
export const UploadFinished = z.object({
  type: z.literal('upload:finished'),
  transferId: z.string().uuid(),
});

/** Controller -> agent: begin sending `path` from the remote. */
export const DownloadStart = z.object({
  type: z.literal('download:start'),
  transferId: z.string().uuid(),
  path: relativePath,
});

/** Agent -> controller, before the first binary chunk. */
export const DownloadInfo = z.object({
  type: z.literal('download:info'),
  transferId: z.string().uuid(),
  fileName: z.string(),
  size: z.number().nonnegative(),
});

/** Agent -> controller, sent once all binary chunks have been transmitted. */
export const DownloadComplete = z.object({
  type: z.literal('download:complete'),
  transferId: z.string().uuid(),
});

/** Either direction: abandon the transfer in progress. */
export const TransferCancel = z.object({
  type: z.literal('transfer:cancel'),
  transferId: z.string().uuid(),
});

/** Progress reported by whichever side is currently writing bytes. */
export const TransferProgress = z.object({
  type: z.literal('transfer:progress'),
  transferId: z.string().uuid(),
  transferredBytes: z.number().nonnegative(),
});

export const FileControlMessage = z.discriminatedUnion('type', [
  FileListRequest,
  FileListResult,
  FileMkdirRequest,
  FileRenameRequest,
  FileDeleteRequest,
  FileOpAck,
  FileOpError,
  UploadStart,
  UploadReady,
  UploadComplete,
  UploadFinished,
  DownloadStart,
  DownloadInfo,
  DownloadComplete,
  TransferCancel,
  TransferProgress,
]);
export type FileControlMessage = z.infer<typeof FileControlMessage>;

export function parseFileControlMessage(raw: string): FileControlMessage | null {
  try {
    const parsed = FileControlMessage.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
