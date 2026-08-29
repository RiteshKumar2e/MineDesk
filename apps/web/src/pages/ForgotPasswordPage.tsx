import { useState, type FormEvent } from 'react';
import { AuthShell, SuccessNotice } from '../components/AuthShell';
import { api } from '../lib/apiClient';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      // The API always returns ok, whether or not the address exists, so the
      // UI cannot become an account-enumeration oracle either.
      await api.post('/api/v1/auth/forgot-password', { email });
    } finally {
      setSent(true);
      setSubmitting(false);
    }
  }

  return (
    <AuthShell title="Reset your password" subtitle="We'll email you a link if the address matches an account.">
      <SuccessNotice message={sent ? 'If that address has an account, a reset link is on its way.' : null} />
      {!sent && (
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
          <button type="submit" className="btn-primary w-full" disabled={submitting}>
            {submitting ? 'Sending...' : 'Send reset link'}
          </button>
        </form>
      )}
    </AuthShell>
  );
}
