import { formatDeviceId, normalizeCode } from '../vendor/shared/idFormat';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { StatusDot } from '../components/StatusDot';
import { API_URL, ApiError } from '../lib/apiClient';
import { useCreateDevice, useDevices } from '../lib/deviceQueries';
import { useCreateSession } from '../lib/sessionQueries';

export default function DevicesPage() {
  const { data, isLoading, error } = useDevices();
  const createDevice = useCreateDevice();
  const createSession = useCreateSession();
  const navigate = useNavigate();

  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [enrollment, setEnrollment] = useState<{ code: string; command: string; expiresAt: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const [showConnect, setShowConnect] = useState(false);
  const [connectId, setConnectId] = useState('');
  const [connectPassword, setConnectPassword] = useState('');
  const [connectError, setConnectError] = useState<string | null>(null);

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
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">My Devices</h1>
          <p className="text-sm text-zinc-500 ">
            Computers you can remotely access once the agent is installed and authorized.
          </p>
        </div>
        <div className="flex gap-2">
          <a href={`${API_URL}/api/v1/agent/download`} className="btn-secondary">
            Download Agent
          </a>
          <button type="button" className="btn-secondary" onClick={() => setShowConnect(true)}>
            Connect to a device
          </button>
          <button type="button" className="btn-primary" onClick={() => setShowAdd(true)}>
            + Add device
          </button>
        </div>
      </div>

      {showConnect && (
        <div className="card mb-6 p-5">
          <h2 className="mb-1 font-medium">Connect to a device</h2>
          <p className="mb-3 text-sm text-zinc-500">
            Enter the device ID someone shared with you. They will get a prompt on that computer and have to
            approve the connection before you see anything. The access password is only for connecting to a
            device that has been left unattended - leave it blank otherwise.
          </p>
          <form onSubmit={handleConnect} className="flex flex-wrap items-end gap-3">
            <div>
              <label className="label" htmlFor="connect-id">
                Device ID
              </label>
              <input
                id="connect-id"
                className="input font-mono"
                placeholder="552 246 274"
                inputMode="numeric"
                required
                value={connectId}
                onChange={(e) => setConnectId(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="connect-password">
                Access password <span className="font-normal text-zinc-400">(optional)</span>
              </label>
              <input
                id="connect-password"
                type="password"
                className="input"
                placeholder="Only for unattended access"
                value={connectPassword}
                onChange={(e) => setConnectPassword(e.target.value)}
              />
            </div>
            <button type="submit" className="btn-primary" disabled={createSession.isPending}>
              {createSession.isPending ? 'Connecting...' : 'Connect'}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setShowConnect(false);
                setConnectError(null);
              }}
            >
              Cancel
            </button>
          </form>
          {connectError && <p className="mt-2 text-sm text-red-600">{connectError}</p>}
        </div>
      )}

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

      {data && data.devices.length === 0 && (
        <div className="card p-10 text-center text-sm text-zinc-500 ">
          No devices yet. Add one to get an installation command for the Remote Agent.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {data?.devices.map((device) => (
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
