import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AuthShell, ErrorNotice, SuccessNotice } from '../components/AuthShell';
import { api, ApiError } from '../lib/apiClient';

export default function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [status, setStatus] = useState<'checking' | 'ok' | 'error'>('checking');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setError('This link is missing its verification token.');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        await api.post('/api/v1/auth/verify-email', { token });
        if (!cancelled) setStatus('ok');
      } catch (err) {
        if (!cancelled) {
          setStatus('error');
          setError(err instanceof ApiError ? err.message : 'That link is not valid.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <AuthShell title="Verify your email">
      {status === 'checking' && <p className="text-sm text-zinc-500">Verifying...</p>}
      {status === 'ok' && (
        <>
          <SuccessNotice message="Your email address is verified." />
          <Link to="/login" className="btn-primary mt-2 block text-center">
            Sign in
          </Link>
        </>
      )}
      {status === 'error' && <ErrorNotice message={error} />}
    </AuthShell>
  );
}
