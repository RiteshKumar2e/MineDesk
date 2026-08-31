import { normalizeCode } from '@minedesk/shared/idFormat';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ErrorNotice } from '../components/AuthShell';
import { ApiError } from '../lib/apiClient';
import { useAuth } from '../lib/AuthContext';
import { useCreateSession } from '../lib/sessionQueries';

/**
 * The AnyDesk-style front door: no account, just a device ID. This is what
 * makes MineDesk usable by someone the device owner shares an ID with, not
 * only by other MineDesk accounts - see createGuestUser's doc comment (API
 * side) for why that still goes through a real, disposable account rather
 * than a special-cased anonymous path.
 */
export default function QuickConnectPage() {
  const { user, guestConnect } = useAuth();
  const createSession = useCreateSession();
  const navigate = useNavigate();

  const [deviceId, setDeviceId] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      // Someone already signed in (a real account, or an earlier guest
      // session still valid) keeps using that identity - minting a fresh
      // guest here would silently replace it out from under them.
      if (!user) await guestConnect(name);
      const res = await createSession.mutateAsync({
        deviceId: normalizeCode(deviceId),
        unattendedPassword: password || undefined,
      });
      navigate(`/remote/${res.sessionId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start a session.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-zinc-50 to-brand-50/40 px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center justify-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 font-display text-sm font-bold text-white shadow-sm">
            M
          </div>
          <span className="font-display text-xl font-bold tracking-tight text-zinc-900">MineDesk</span>
        </div>

        <div className="card p-7">
          <h1 className="mb-1 text-lg font-bold text-zinc-900">Connect to a device</h1>
          <p className="mb-5 text-sm text-zinc-500">
            Enter the device ID someone shared with you. No account needed - they will get a prompt on
            their computer and have to approve it before you see anything.
          </p>

          <ErrorNotice message={error} />

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label" htmlFor="qc-device-id">
                Device ID
              </label>
              <input
                id="qc-device-id"
                className="input font-mono text-lg tracking-wide"
                placeholder="552 246 274"
                inputMode="numeric"
                autoFocus
                required
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="qc-name">
                Your name <span className="font-normal text-zinc-400">(shown to the other person)</span>
              </label>
              <input
                id="qc-name"
                className="input"
                placeholder="Guest"
                maxLength={60}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="qc-password">
                Access password <span className="font-normal text-zinc-400">(only for unattended access)</span>
              </label>
              <input
                id="qc-password"
                type="password"
                className="input"
                placeholder="Leave blank to ask for approval instead"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <button type="submit" className="btn-primary w-full" disabled={submitting}>
              {submitting ? 'Connecting...' : 'Connect'}
            </button>
          </form>
        </div>

        <p className="mt-5 text-center text-xs text-zinc-400">
          {user ? (
            <Link to="/devices" className="font-medium hover:text-brand-600 hover:underline">
              Go to my devices
            </Link>
          ) : (
            <>
              Own devices to manage?{' '}
              <Link to="/login" className="font-medium hover:text-brand-600 hover:underline">
                Sign in
              </Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
