import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AuthShell, ErrorNotice } from '../components/AuthShell';
import { ApiError } from '../lib/apiClient';
import { useAuth } from '../lib/AuthContext';

export default function LoginPage() {
  const { login, completeTwoFactor } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/devices';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [twoFactorToken, setTwoFactorToken] = useState<string | null>(null);
  const [code, setCode] = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await login(email, password);
      if (res.twoFactorRequired && res.twoFactorToken) {
        setTwoFactorToken(res.twoFactorToken);
      } else {
        navigate(from, { replace: true });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleTwoFactorSubmit(e: FormEvent) {
    e.preventDefault();
    if (!twoFactorToken) return;
    setError(null);
    setSubmitting(true);
    try {
      await completeTwoFactor(twoFactorToken, code);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (twoFactorToken) {
    return (
      <AuthShell title="Two-factor verification" subtitle="Enter the code from your authenticator app.">
        <ErrorNotice message={error} />
        <form onSubmit={handleTwoFactorSubmit} className="space-y-4">
          <div>
            <label className="label" htmlFor="code">
              Verification code
            </label>
            <input
              id="code"
              className="input tracking-widest"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={12}
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
            />
          </div>
          <button type="submit" className="btn-primary w-full" disabled={submitting}>
            {submitting ? 'Verifying...' : 'Verify'}
          </button>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Sign in" subtitle="Access your devices and remote sessions.">
      <ErrorNotice message={error} />
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label" htmlFor="email">
            Email address
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <div className="flex items-center justify-between">
            <label className="label" htmlFor="password">
              Password
            </label>
            <Link to="/forgot-password" className="text-xs text-brand-600 hover:underline">
              Forgot password?
            </Link>
          </div>
          <input
            id="password"
            type="password"
            required
            autoComplete="current-password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <button type="submit" className="btn-primary w-full" disabled={submitting}>
          {submitting ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
      <p className="mt-5 text-center text-sm text-zinc-500">
        Don&apos;t have an account?{' '}
        <Link to="/register" className="font-medium text-brand-600 hover:underline">
          Create one
        </Link>
      </p>
      <p className="mt-2 text-center text-sm text-zinc-500">
        Just connecting to someone else&apos;s device?{' '}
        <Link to="/connect" className="font-medium text-brand-600 hover:underline">
          Connect without an account
        </Link>
      </p>
    </AuthShell>
  );
}
