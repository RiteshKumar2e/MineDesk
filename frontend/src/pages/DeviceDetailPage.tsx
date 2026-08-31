import { CAPABILITY_DESCRIPTIONS, CAPABILITY_GROUPS, CAPABILITY_LABELS, formatDuration } from '../vendor/shared/index';
import { formatDeviceId } from '../vendor/shared/idFormat';
import type { Capability } from '../vendor/types/index';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { StatusDot } from '../components/StatusDot';
import { API_URL, ApiError } from '../lib/apiClient';
import {
  useDevice,
  useDeviceAccess,
  useDeviceSessions,
  useDeleteDevice,
  useIssueEnrollmentCode,
  useRenameDevice,
  useRevokeDevice,
  useSetIncomingRequests,
  useSetUnattendedAccess,
  useUpdatePermissions,
} from '../lib/deviceQueries';
import { useCreateSession } from '../lib/sessionQueries';

const ACTIVITY_ICONS: { flag: 'usedCamera' | 'usedMicrophone' | 'usedAudio' | 'usedClipboard' | 'usedFiles'; icon: string; title: string }[] = [
  { flag: 'usedCamera', icon: '\u{1F4F7}', title: 'Camera was used' },
  { flag: 'usedMicrophone', icon: '\u{1F3A4}', title: 'Microphone was used' },
  { flag: 'usedAudio', icon: '\u{1F50A}', title: 'Remote audio was used' },
  { flag: 'usedClipboard', icon: '\u{1F4CB}', title: 'Clipboard was used' },
  { flag: 'usedFiles', icon: '\u{1F4C1}', title: 'Files were transferred' },
];

export default function DeviceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading, error } = useDevice(id);
  const { data: sessionsData } = useDeviceSessions(id);
  const { data: accessData } = useDeviceAccess(id);

  const renameDevice = useRenameDevice(id ?? '');
  const deleteDevice = useDeleteDevice();
  const updatePermissions = useUpdatePermissions(id ?? '');
  const setUnattended = useSetUnattendedAccess(id ?? '');
  const setIncomingRequests = useSetIncomingRequests(id ?? '');
  const revokeDevice = useRevokeDevice(id ?? '');
  const issueCode = useIssueEnrollmentCode(id ?? '');
  const createSession = useCreateSession();

  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [unattendedPassword, setUnattendedPassword] = useState('');
  const [showUnattendedForm, setShowUnattendedForm] = useState(false);
  const [newCode, setNewCode] = useState<{ code: string; command: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState('');

  if (isLoading) return <p className="text-sm text-zinc-500">Loading device...</p>;
  if (error || !data) return <p className="text-sm text-red-600">That device could not be found.</p>;

  const { device } = data;

  async function togglePermission(capability: Capability, value: boolean) {
    setActionError(null);
    try {
      await updatePermissions.mutateAsync({ [capability]: value });
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not update permissions.');
    }
  }

  async function addSharedFolder() {
    const folder = newFolder.trim();
    if (!folder) return;
    setActionError(null);
    try {
      const current = data?.sharedFolders ?? [];
      if (!current.includes(folder)) {
        await updatePermissions.mutateAsync({ sharedFolders: [...current, folder] });
      }
      setNewFolder('');
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not add that folder.');
    }
  }

  async function removeSharedFolder(folder: string) {
    setActionError(null);
    try {
      const current = data?.sharedFolders ?? [];
      await updatePermissions.mutateAsync({ sharedFolders: current.filter((f) => f !== folder) });
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not remove that folder.');
    }
  }

  async function handleRename() {
    try {
      await renameDevice.mutateAsync(nameDraft);
      setRenaming(false);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not rename the device.');
    }
  }

  async function handleDelete() {
    if (!id) return;
    if (!confirm(`Remove ${device.name}? This cannot be undone.`)) return;
    await deleteDevice.mutateAsync(id);
    navigate('/devices');
  }

  async function handleIncomingRequestsToggle() {
    setActionError(null);
    try {
      await setIncomingRequests.mutateAsync({ enabled: !device.allowIncomingRequests });
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not change that setting.');
    }
  }

  async function handleUnattendedToggle() {
    setActionError(null);
    if (device.unattendedAccessEnabled) {
      await setUnattended.mutateAsync({ enabled: false });
      return;
    }
    setShowUnattendedForm(true);
  }

  async function submitUnattended() {
    setActionError(null);
    try {
      await setUnattended.mutateAsync({ enabled: true, password: unattendedPassword });
      setShowUnattendedForm(false);
      setUnattendedPassword('');
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not enable unattended access.');
    }
  }

  async function handleIssueCode() {
    const res = await issueCode.mutateAsync();
    setNewCode(res);
  }

  async function handleConnect() {
    setActionError(null);
    try {
      const res = await createSession.mutateAsync(device.deviceId);
      navigate(`/remote/${res.sessionId}`);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not start a session.');
    }
  }

  return (
    <div>
      <Link to="/devices" className="mb-4 inline-block text-sm text-zinc-500 hover:underline">
        &larr; All devices
      </Link>

      <div className="mb-6 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <StatusDot online={device.status === 'online'} />
            {renaming ? (
              <div className="flex items-center gap-2">
                <input
                  className="input"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  autoFocus
                />
                <button type="button" className="btn-primary" onClick={() => void handleRename()}>
                  Save
                </button>
                <button type="button" className="btn-ghost" onClick={() => setRenaming(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <h1 className="text-xl font-semibold">{device.name}</h1>
            )}
            {!renaming && (
              <button
                type="button"
                className="text-xs text-zinc-400 hover:text-zinc-600"
                onClick={() => {
                  setNameDraft(device.name);
                  setRenaming(true);
                }}
              >
                Rename
              </button>
            )}
          </div>
          <div className="mt-1 text-sm text-zinc-500 ">
            ID: {formatDeviceId(device.deviceId)} &middot; <span className="capitalize">{device.os}</span>
            {device.osVersion ? ` ${device.osVersion}` : ''}
          </div>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            className="btn-primary"
            disabled={device.status !== 'online' || createSession.isPending || Boolean(device.activeSession)}
            title={device.status !== 'online' ? 'Device must be online to connect' : undefined}
            onClick={() => void handleConnect()}
          >
            {createSession.isPending ? 'Connecting...' : device.activeSession ? 'Session active' : 'Connect'}
          </button>
          <button type="button" className="btn-danger" onClick={() => void handleDelete()}>
            Remove
          </button>
        </div>
      </div>

      {actionError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700   ">
          {actionError}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <section className="card p-5">
            <h2 className="mb-4 font-medium">Permissions</h2>
            <div className="space-y-5">
              {CAPABILITY_GROUPS.map((group) => (
                <div key={group.label}>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
                    {group.label}
                  </h3>
                  <div className="space-y-2">
                    {group.capabilities.map((capability) => (
                      <label key={capability} className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 rounded border-zinc-300"
                          checked={device.permissions[capability]}
                          onChange={(e) => void togglePermission(capability, e.target.checked)}
                        />
                        <span>
                          <span className="block text-sm font-medium">{CAPABILITY_LABELS[capability]}</span>
                          <span className="block text-xs text-zinc-500 ">
                            {CAPABILITY_DESCRIPTIONS[capability]}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {(device.permissions.fileUpload || device.permissions.fileDownload || device.permissions.fileDelete) && (
              <div className="mt-5 border-t border-zinc-100 pt-4 ">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Shared folders</h3>
                <p className="mb-2 text-xs text-zinc-500 ">
                  Absolute paths on this computer the file manager is allowed to browse. Nothing outside these
                  folders is reachable from a remote session.
                </p>
                <ul className="mb-2 space-y-1">
                  {(data.sharedFolders ?? []).map((folder) => (
                    <li key={folder} className="flex items-center justify-between rounded bg-zinc-50 px-2 py-1 text-sm ">
                      <span className="truncate font-mono text-xs">{folder}</span>
                      <button type="button" className="text-xs text-red-600 hover:underline" onClick={() => void removeSharedFolder(folder)}>
                        Remove
                      </button>
                    </li>
                  ))}
                  {(data.sharedFolders ?? []).length === 0 && (
                    <li className="text-xs text-zinc-400">No folders shared yet.</li>
                  )}
                </ul>
                <div className="flex gap-2">
                  <input
                    className="input text-sm"
                    placeholder="C:\Users\name\Documents"
                    value={newFolder}
                    onChange={(e) => setNewFolder(e.target.value)}
                  />
                  <button type="button" className="btn-secondary shrink-0" onClick={() => void addSharedFolder()}>
                    Add
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="card p-5">
            <h2 className="mb-3 font-medium">Access history</h2>
            {!sessionsData || sessionsData.sessions.length === 0 ? (
              <p className="text-sm text-zinc-500 ">No sessions yet.</p>
            ) : (
              <ul className="divide-y divide-zinc-100 ">
                {sessionsData.sessions.map((session) => (
                  <li key={session.id} className="py-2.5 text-sm">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium">
                          {session.userName} <span className="font-normal text-zinc-400">({session.userEmail})</span>
                        </div>
                        <div className="text-xs text-zinc-500 ">
                          {new Date(session.startedAt).toLocaleString()}
                          {session.durationMs !== null && ` · ${formatDuration(session.durationMs)}`}
                          {session.unattended && ' · unattended'}
                          {session.connectionType && ` · ${session.connectionType}`}
                        </div>
                      </div>
                      <span className="badge bg-zinc-100 text-zinc-600  ">
                        {session.status}
                      </span>
                    </div>
                    {ACTIVITY_ICONS.some((a) => session[a.flag]) && (
                      <div className="mt-1 flex gap-1.5 text-sm" aria-label="Capabilities used during this session">
                        {ACTIVITY_ICONS.filter((a) => session[a.flag]).map((a) => (
                          <span key={a.flag} title={a.title}>
                            {a.icon}
                          </span>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {accessData && accessData.recentConnections.length > 0 && (
            <section className="card p-5">
              <h2 className="mb-1 font-medium">Connected via access password</h2>
              <p className="mb-3 text-sm text-zinc-500 ">
                These accounts are not owners of this device - they connected using the unattended access
                password. Change the password to revoke their access.
              </p>
              <ul className="divide-y divide-zinc-100 ">
                {accessData.recentConnections.map((conn) => (
                  <li key={conn.id} className="flex items-center justify-between py-2 text-sm">
                    <div>
                      <div className="font-medium">{conn.name}</div>
                      <div className="text-xs text-zinc-500 ">{conn.email}</div>
                    </div>
                    <div className="text-right text-xs text-zinc-500 ">
                      <div>{conn.sessionCount} session{conn.sessionCount === 1 ? '' : 's'}</div>
                      <div>{conn.lastConnectedAt ? new Date(conn.lastConnectedAt).toLocaleDateString() : ''}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <div className="space-y-6">
          <section className="card p-5">
            <h2 className="mb-3 font-medium">Connection requests</h2>
            <p className="mb-3 text-sm text-zinc-500">
              Let anyone who has this device's ID ask to connect. Nothing happens until someone at this
              computer approves the request, so no password is involved. Turn it off to stop unsolicited
              prompts entirely.
            </p>
            <div className="flex items-center justify-between">
              <span className="text-sm">{device.allowIncomingRequests ? 'Allowed' : 'Blocked'}</span>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void handleIncomingRequestsToggle()}
              >
                {device.allowIncomingRequests ? 'Block' : 'Allow'}
              </button>
            </div>
          </section>

          <section className="card p-5">
            <h2 className="mb-3 font-medium">Unattended access</h2>
            <p className="mb-3 text-sm text-zinc-500">
              Allow connecting to this device without someone present to approve each session. This is the
              only path that needs a password, because nobody will be there to say yes.
            </p>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm">
                {device.unattendedAccessEnabled ? 'Enabled' : 'Disabled'}
              </span>
              <button type="button" className="btn-secondary" onClick={() => void handleUnattendedToggle()}>
                {device.unattendedAccessEnabled ? 'Disable' : 'Enable'}
              </button>
            </div>
            {showUnattendedForm && (
              <div className="space-y-2 border-t border-zinc-100 pt-3 ">
                <label className="label" htmlFor="unattended-password">
                  Access password
                </label>
                <input
                  id="unattended-password"
                  type="password"
                  className="input"
                  value={unattendedPassword}
                  onChange={(e) => setUnattendedPassword(e.target.value)}
                />
                <button type="button" className="btn-primary w-full" onClick={() => void submitUnattended()}>
                  Enable unattended access
                </button>
              </div>
            )}
          </section>

          <section className="card p-5">
            <h2 className="mb-3 font-medium">Agent enrollment</h2>
            <p className="mb-3 text-sm text-zinc-500">
              Reinstalling the agent, or moving it to a new machine, needs a fresh one-time code.{' '}
              <a href={`${API_URL}/api/v1/agent/download`} className="font-medium text-brand-600 hover:underline">
                Download the agent
              </a>{' '}
              first if that machine does not already have it.
            </p>
            <button type="button" className="btn-secondary w-full" onClick={() => void handleIssueCode()}>
              Generate new code
            </button>
            {newCode && (
              <code className="mt-3 block rounded-lg bg-zinc-900 px-3 py-2 text-xs text-emerald-300">
                {newCode.command}
              </code>
            )}
          </section>

          <section className="card p-5">
            <h2 className="mb-3 font-medium text-red-600">Revoke access</h2>
            <p className="mb-3 text-sm text-zinc-500 ">
              Immediately signs the agent out and ends any active session. The device stays listed and can be
              re-enrolled with a new code.
            </p>
            <button
              type="button"
              className="btn-danger w-full"
              onClick={() => void revokeDevice.mutateAsync()}
              disabled={!device.enrolledAt}
            >
              Revoke agent access
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}
