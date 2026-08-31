import type { PublicAuthSession } from '../vendor/types/index';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../lib/apiClient';

export default function SecurityPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['auth-sessions'],
    queryFn: () => api.get<{ sessions: PublicAuthSession[] }>('/api/v1/auth/sessions'),
  });

  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function revoke(id: string) {
    setError(null);
    setRevoking(id);
    try {
      await api.delete(`/api/v1/auth/sessions/${id}`);
      await queryClient.invalidateQueries({ queryKey: ['auth-sessions'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not revoke that session.');
    } finally {
      setRevoking(null);
    }
  }

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold">Security</h1>
      <p className="mb-6 text-sm text-zinc-500 ">
        Browsers currently signed in to your account. Revoke any you don&apos;t recognize.
      </p>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}
      {isLoading && <p className="text-sm text-zinc-500">Loading...</p>}

      <div className="card divide-y divide-zinc-100 ">
        {data?.sessions.map((session) => (
          <div key={session.id} className="flex items-center justify-between px-5 py-3">
            <div>
              <div className="text-sm font-medium">
                {session.userAgent ?? 'Unknown browser'}
                {session.current && (
                  <span className="badge ml-2 bg-brand-50 text-brand-700  ">
                    This device
                  </span>
                )}
              </div>
              <div className="text-xs text-zinc-500 ">
                {session.ipAddress ?? 'unknown IP'} &middot; last active{' '}
                {new Date(session.lastUsedAt).toLocaleString()}
              </div>
            </div>
            <button
              type="button"
              className="btn-ghost text-red-600"
              disabled={revoking === session.id}
              onClick={() => void revoke(session.id)}
            >
              {revoking === session.id ? 'Revoking...' : 'Revoke'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
