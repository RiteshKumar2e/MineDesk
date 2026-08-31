import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/apiClient';
import { useAuth } from '../lib/AuthContext';

export default function SettingsPage() {
  const { user, refreshUser } = useAuth();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="mb-1 text-xl font-semibold">Settings</h1>
        <p className="text-sm text-zinc-500 ">Manage your account and its security options.</p>
      </div>

      <ChangePasswordCard />
      <TwoFactorCard enabled={user?.twoFactorEnabled ?? false} onChange={refreshUser} />
    </div>
  );
}

function ChangePasswordCard() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setStatus('saving');
    try {
      await api.post('/api/v1/auth/change-password', {
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      setStatus('done');
      setCurrentPassword('');
      setNewPassword('');
    } catch (err) {
      setStatus('idle');
      setError(err instanceof ApiError ? err.message : 'Could not change the password.');
    }
  }

  return (
    <section className="card p-5">
      <h2 className="mb-3 font-medium">Change password</h2>
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      {status === 'done' && (
        <p className="mb-3 text-sm text-emerald-600">Password changed. Other browsers were signed out.</p>
      )}
      <form onSubmit={handleSubmit} className="max-w-sm space-y-3">
        <div>
          <label className="label" htmlFor="current-password">
            Current password
          </label>
          <input
            id="current-password"
            type="password"
            required
            className="input"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="new-password">
            New password
          </label>
          <input
            id="new-password"
            type="password"
            required
            className="input"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </div>
        <button type="submit" className="btn-primary" disabled={status === 'saving'}>
          {status === 'saving' ? 'Saving...' : 'Change password'}
        </button>
      </form>
    </section>
  );
}

function TwoFactorCard({ enabled, onChange }: { enabled: boolean; onChange: () => Promise<void> }) {
  const [setupData, setSetupData] = useState<{ qrCode: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function startSetup() {
    setError(null);
    try {
      const res = await api.post<{ qrCode: string; secret: string }>('/api/v1/auth/2fa/setup');
      setSetupData(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start setup.');
    }
  }

  async function confirmSetup(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await api.post<{ backupCodes: string[] }>('/api/v1/auth/2fa/enable', { code });
      setBackupCodes(res.backupCodes);
      setSetupData(null);
      setCode('');
      await onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That code did not verify. Try again.');
    }
  }

  async function disable(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/api/v1/auth/2fa/disable', { password: disablePassword, code: disableCode });
      setDisablePassword('');
      setDisableCode('');
      await onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not disable two-factor authentication.');
    }
  }

  return (
    <section className="card p-5">
      <h2 className="mb-3 font-medium">Two-factor authentication</h2>
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      {backupCodes ? (
        <div>
          <p className="mb-2 text-sm">
            Two-factor authentication is enabled. Save these backup codes somewhere safe - each works once if you
            lose access to your authenticator app.
          </p>
          <div className="grid grid-cols-2 gap-2 rounded-lg bg-zinc-900 p-4 font-mono text-sm text-emerald-300">
            {backupCodes.map((c) => (
              <div key={c}>{c}</div>
            ))}
          </div>
        </div>
      ) : enabled ? (
        <div>
          <p className="mb-3 text-sm text-zinc-500 ">
            Two-factor authentication is currently enabled on your account.
          </p>
          <form onSubmit={disable} className="max-w-sm space-y-3">
            <div>
              <label className="label" htmlFor="disable-password">
                Password
              </label>
              <input
                id="disable-password"
                type="password"
                required
                className="input"
                value={disablePassword}
                onChange={(e) => setDisablePassword(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="disable-code">
                Authenticator code
              </label>
              <input
                id="disable-code"
                required
                className="input"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
              />
            </div>
            <button type="submit" className="btn-danger">
              Disable two-factor authentication
            </button>
          </form>
        </div>
      ) : setupData ? (
        <form onSubmit={confirmSetup} className="max-w-sm space-y-3">
          <p className="text-sm text-zinc-500 ">
            Scan this QR code with your authenticator app, then enter the six-digit code it shows.
          </p>
          <img src={setupData.qrCode} alt="Two-factor QR code" className="h-40 w-40 rounded-lg border" />
          <p className="text-xs text-zinc-400">Or enter this key manually: {setupData.secret}</p>
          <div>
            <label className="label" htmlFor="totp-code">
              Verification code
            </label>
            <input
              id="totp-code"
              required
              className="input tracking-widest"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          <button type="submit" className="btn-primary">
            Enable two-factor authentication
          </button>
        </form>
      ) : (
        <div>
          <p className="mb-3 text-sm text-zinc-500 ">
            Add an authenticator app as a second factor when signing in.
          </p>
          <button type="button" className="btn-primary" onClick={() => void startSetup()}>
            Set up two-factor authentication
          </button>
        </div>
      )}
    </section>
  );
}
