import { CAPABILITY_DESCRIPTIONS, CAPABILITY_GROUPS, CAPABILITY_LABELS } from '@minedesk/shared';
import type { Capability } from '@minedesk/types';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { StatusDot } from '../components/StatusDot';
import { ApiError } from '../lib/apiClient';
import {
  useDevice,
  useDeviceSessions,
  useDeleteDevice,
  useIssueEnrollmentCode,
  useRenameDevice,
  useRevokeDevice,
  useSetUnattendedAccess,
  useUpdatePermissions,
} from '../lib/deviceQueries';
import { useCreateSession } from '../lib/sessionQueries';

export default function DeviceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading, error } = useDevice(id);
  const { data: sessionsData } = useDeviceSessions(id);

  const renameDevice = useRenameDevice(id ?? '');
  const deleteDevice = useDeleteDevice();
  const updatePermissions = useUpdatePermissions(id ?? '');
  const setUnattended = useSetUnattendedAccess(id ?? '');
  const revokeDevice = useRevokeDevice(id ?? '');
  const issueCode = useIssueEnrollmentCode(id ?? '');
  const createSession = useCreateSession();

  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [unattendedPassword, setUnattendedPassword] = useState('');
  const [showUnattendedForm, setShowUnattendedForm] = useState(false);
  const [newCode, setNewCode] = useState<{ code: string; command: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (isLoading) return <p className="text-sm text-slate-500">Loading device...</p>;
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
      <Link to="/devices" className="mb-4 inline-block text-sm text-slate-500 hover:underline">
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
                className="text-xs text-slate-400 hover:text-slate-600"
                onClick={() => {
                  setNameDraft(device.name);
                  setRenaming(true);
                }}
              >
                Rename
              </button>
            )}
          </div>
          <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            ID: {device.deviceId} &middot; <span className="capitalize">{device.os}</span>
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
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
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
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                    {group.label}
                  </h3>
                  <div className="space-y-2">
                    {group.capabilities.map((capability) => (
                      <label key={capability} className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 rounded border-slate-300"
                          checked={device.permissions[capability]}
                          onChange={(e) => void togglePermission(capability, e.target.checked)}
                        />
                        <span>
                          <span className="block text-sm font-medium">{CAPABILITY_LABELS[capability]}</span>
                          <span className="block text-xs text-slate-500 dark:text-slate-400">
                            {CAPABILITY_DESCRIPTIONS[capability]}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="card p-5">
            <h2 className="mb-3 font-medium">Recent sessions</h2>
            {!sessionsData || sessionsData.sessions.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">No sessions yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {sessionsData.sessions.map((session) => (
                  <li key={session.id} className="flex items-center justify-between py-2 text-sm">
                    <div>
                      <div className="font-medium">{session.sessionId}</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {session.userEmail} &middot; {new Date(session.startedAt).toLocaleString()}
                      </div>
                    </div>
                    <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {session.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="space-y-6">
          <section className="card p-5">
            <h2 className="mb-3 font-medium">Unattended access</h2>
            <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
              Allow connecting to this device without someone present to approve each session.
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
              <div className="space-y-2 border-t border-slate-100 pt-3 dark:border-slate-800">
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
            <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
              Reinstalling the agent, or moving it to a new machine, needs a fresh one-time code.
            </p>
            <button type="button" className="btn-secondary w-full" onClick={() => void handleIssueCode()}>
              Generate new code
            </button>
            {newCode && (
              <code className="mt-3 block rounded-lg bg-slate-900 px-3 py-2 text-xs text-emerald-300">
                {newCode.command}
              </code>
            )}
          </section>

          <section className="card p-5">
            <h2 className="mb-3 font-medium text-red-600">Revoke access</h2>
            <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
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
