import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-zinc-50 to-brand-50/40 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 font-display text-sm font-bold text-white shadow-sm">
            M
          </div>
          <span className="font-display text-xl font-bold tracking-tight text-zinc-900">MineDesk</span>
        </div>
        <div className="card p-7">
          <h1 className="mb-1 text-lg font-bold text-zinc-900">{title}</h1>
          {subtitle && <p className="mb-5 text-sm text-zinc-500">{subtitle}</p>}
          {children}
        </div>
        <p className="mt-5 text-center text-xs text-zinc-400">
          <Link to="/login" className="font-medium hover:text-brand-600 hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

export function ErrorNotice({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mb-4 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">{message}</div>
  );
}

export function SuccessNotice({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mb-4 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
      {message}
    </div>
  );
}
