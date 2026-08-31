import { formatDeviceId, normalizeCode } from '../vendor/shared/idFormat';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { StatusDot } from '../components/StatusDot';
import { API_URL, ApiError } from '../lib/apiClient';
import { useCreateDevice, useDevices } from '../lib/deviceQueries';
import { useCreateSession } from '../lib/sessionQueries';

function InfoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-5M12 8h.01" />
    </svg>
  );
}

function LockIcon({ open }: { open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="11" width="16" height="9" rx="2" />
      {open ? <path d="M7 11V8a5 5 0 0 1 9-3" /> : <path d="M7 11V7a5 5 0 0 1 10 0v4" />}
    </svg>
  );
}

export default function DevicesPage() {
  const { data, isLoading, error } = useDevices();
  const createDevice = useCreateDevice();
  const createSession = useCreateSession();
  const navigate = useNavigate();

  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [enrollment, setEnrollment] = useState<{ code: string; command: string; expiresAt: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const [connectId, setConnectId] = useState('');
  const [connectPassword, setConnectPassword] = useState('');
  const [connectError, setConnectError] = useState<string | null>(null);

  // Which of the user's own devices is shown as "Your Address". Defaults to
  // whichever is reachable right now, since that's the one worth handing out.
  const [addressDeviceId, setAddressDeviceId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showInfo, setShowInfo] = useState(false);

  const devices = data?.devices ?? [];
  const addressDevice =
    devices.find((d) => d.id === addressDeviceId) ?? devices.find((d) => d.status === 'online') ?? devices[0] ?? null;

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copyAddress() {
    if (!addressDevice) return;
    try {
      await navigator.clipboard.writeText(addressDevice.deviceId);
      setCopied(true);
    } catch {
      /* clipboard blocked (insecure origin, denied permission) - the ID is on screen anyway */
    }
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    try {
      const res = await createDevice.mutateAsync(name);
      setEnrollment(res.enrollment);
      setName('');
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Could not add the device.');
    }
  }

  async function handleConnect(e: FormEvent) {
    e.preventDefault();
    setConnectError(null);
    try {
      const res = await createSession.mutateAsync({
        deviceId: normalizeCode(connectId),
        unattendedPassword: connectPassword || undefined,
      });
      navigate(`/remote/${res.sessionId}`);
    } catch (err) {
      setConnectError(err instanceof ApiError ? err.message : 'Could not start a session.');
    }
  }

  return (
    <div>
      {/* The two directions of a remote session, side by side, the way a
          remote-desktop tool is expected to present them: the address other
          people use to reach you, and the box you type someone else's into. */}
      <div className="mb-8 grid gap-4 lg:grid-cols-2">
        <div className="card p-6">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Your Address</h2>
              <p className="mt-1 text-sm text-zinc-500">Share this so someone can request access to you.</p>
            </div>
            <a href={`${API_URL}/api/v1/agent/download`} className="btn-secondary shrink-0">
              Download Agent
            </a>
          </div>

          {isLoading && <p className="text-sm text-zinc-500">Loading...</p>}

          {!isLoading && !addressDevice && (
            <div className="rounded-xl border border-dashed border-zinc-300 p-5 text-center">
              <p className="text-sm text-zinc-500">
                No address yet - install the agent on a computer to give it one.
              </p>
              <button type="button" className="btn-primary mt-3" onClick={() => setShowAdd(true)}>
                + Add device
              </button>
            </div>
          )}

          {addressDevice && (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-4xl font-semibold tabular-nums tracking-tight text-brand-700">
                  {formatDeviceId(addressDevice.deviceId)}
                </span>
                <button type="button" className="btn-secondary" onClick={copyAddress}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <div className="relative ml-auto flex items-center gap-1 text-zinc-400">
                  <button
                    type="button"
                    className="rounded-full p-1.5 hover:bg-zinc-100 hover:text-zinc-600"
                    aria-label="What is this address?"
                    onClick={() => setShowInfo((v) => !v)}
                    onBlur={() => setShowInfo(false)}
                  >
                    <InfoIcon />
                  </button>
                  {showInfo && (
                    <div className="absolute right-0 top-full z-10 mt-2 w-64 rounded-lg border border-zinc-200 bg-white p-3 text-xs text-zinc-600 shadow-lg">
                      Anyone with this address can request to connect. You will get a prompt to approve
                      it, unless unattended access is enabled for this device.
                    </div>
                  )}
                  <Link
                    to={`/devices/${addressDevice.id}`}
                    className="rounded-full p-1.5 hover:bg-zinc-100 hover:text-zinc-600"
                    title={addressDevice.unattendedAccessEnabled ? 'Unattended access is on' : 'Approval required to connect'}
                  >
                    <LockIcon open={addressDevice.unattendedAccessEnabled} />
                  </Link>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2 text-sm text-zinc-500">
                <StatusDot online={addressDevice.status === 'online'} />
                <span className="font-medium text-zinc-700">{addressDevice.name}</span>
                <span>·</span>
                <span>{addressDevice.status === 'online' ? 'Online now' : 'Offline'}</span>
              </div>
              {devices.length > 1 && (
                <select
                  className="input mt-3"
                  value={addressDevice.id}
                  onChange={(e) => setAddressDeviceId(e.target.value)}
                  aria-label="Which of your devices to show the address for"
                >
                  {devices.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.name} - {formatDeviceId(device.deviceId)}
                    </option>
                  ))}
                </select>
              )}
            </>
          )}
        </div>

        <div className="card p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Remote Address</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Enter the ID of the device you want to control. They get a prompt and have to approve it before
            you see anything - unless you have their access password.
          </p>
          <form onSubmit={handleConnect} className="mt-4 space-y-3">
            <input
              id="connect-id"
              className="input font-mono text-lg tabular-nums"
              placeholder="552 246 274"
              inputMode="numeric"
              required
              value={connectId}
              onChange={(e) => setConnectId(e.target.value)}
            />
            <input
              id="connect-password"
              type="password"
              className="input"
              placeholder="Access password - only for unattended access"
              value={connectPassword}
              onChange={(e) => setConnectPassword(e.target.value)}
            />
            <button type="submit" className="btn-primary w-full" disabled={createSession.isPending}>
              {createSession.isPending ? 'Connecting...' : 'Connect'}
            </button>
          </form>
          {connectError && <p className="mt-2 text-sm text-red-600">{connectError}</p>}
        </div>
      </div>

      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">My Devices</h1>
          <p className="text-sm text-zinc-500">
            Computers you can remotely access once the agent is installed and authorized.
          </p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setShowAdd(true)}>
          + Add device
        </button>
      </div>

      {showAdd && (
        <div className="card mb-6 p-5">
          {!enrollment ? (
            <form onSubmit={handleAdd} className="space-y-3">
              <div>
                <label className="label" htmlFor="device-name">
                  Device name
                </label>
                <input
                  id="device-name"
                  className="input"
                  placeholder="OFFICE-PC"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              {formError && <p className="text-sm text-red-600">{formError}</p>}
              <div className="flex gap-2">
                <button type="submit" className="btn-primary" disabled={createDevice.isPending}>
                  {createDevice.isPending ? 'Creating...' : 'Create device'}
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => {
                    setShowAdd(false);
                    setFormError(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div>
              <h2 className="mb-2 font-medium">Install the Remote Agent on that computer</h2>
              <p className="mb-3 text-sm text-zinc-500">
                <a href={`${API_URL}/api/v1/agent/download`} className="font-medium text-brand-600 hover:underline">
                  Download the agent
                </a>{' '}
                on the target machine, then run this command from where you saved it. The code expires{' '}
                {new Date(enrollment.expiresAt).toLocaleTimeString()} and can only be used once.
              </p>
              <code className="mb-4 block rounded-lg bg-zinc-900 px-3 py-2 text-sm text-emerald-300">
                {enrollment.command}
              </code>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setEnrollment(null);
                  setShowAdd(false);
                }}
              >
                Done
              </button>
            </div>
          )}
        </div>
      )}

      {isLoading && <p className="text-sm text-zinc-500">Loading devices...</p>}
      {error && <p className="text-sm text-red-600">Could not load devices.</p>}

      {data && devices.length === 0 && (
        <div className="card p-10 text-center text-sm text-zinc-500 ">
          No devices yet. Add one to get an installation command for the Remote Agent.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {devices.map((device) => (
          <Link
            key={device.id}
            to={`/devices/${device.id}`}
            className="card block p-5 transition-shadow hover:shadow-md"
          >
            <div className="mb-2 flex items-center gap-2">
              <StatusDot online={device.status === 'online'} />
              <span className="font-medium">{device.name}</span>
            </div>
            <div className="space-y-0.5 text-xs text-zinc-500 ">
              <div>ID: {formatDeviceId(device.deviceId)}</div>
              <div className="capitalize">{device.os}</div>
              <div>
                {device.status === 'online'
                  ? 'Online now'
                  : device.lastSeenAt
                    ? `Last seen ${new Date(device.lastSeenAt).toLocaleString()}`
                    : 'Never connected'}
              </div>
            </div>
            {device.activeSession && (
              <div className="mt-3 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800  ">
                Session in progress
              </div>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}
