import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/apiClient';

interface AuditEntry {
  id: string;
  action: string;
  label: string;
  createdAt: string;
  ipAddress: string | null;
  deviceName: string | null;
  sessionId: string | null;
}

export default function ActivityPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['audit'],
    queryFn: () => api.get<{ entries: AuditEntry[] }>('/api/v1/audit?limit=100'),
  });

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold">Activity</h1>
      <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">
        A record of security-relevant events on your account: sign-ins, device changes, and sessions.
      </p>

      {isLoading && <p className="text-sm text-slate-500">Loading...</p>}

      <div className="card divide-y divide-slate-100 dark:divide-slate-800">
        {data?.entries.map((entry) => (
          <div key={entry.id} className="flex items-center justify-between px-5 py-3">
            <div>
              <div className="text-sm font-medium">{entry.label}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {entry.deviceName ? `${entry.deviceName} · ` : ''}
                {entry.ipAddress ?? 'unknown IP'}
                {entry.sessionId ? ` · ${entry.sessionId}` : ''}
              </div>
            </div>
            <div className="whitespace-nowrap text-xs text-slate-400">
              {new Date(entry.createdAt).toLocaleString()}
            </div>
          </div>
        ))}
        {data?.entries.length === 0 && (
          <div className="px-5 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
            No activity recorded yet.
          </div>
        )}
      </div>
    </div>
  );
}
