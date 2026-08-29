import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 dark:bg-slate-950">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
            MD
          </div>
          <span className="text-xl font-semibold">MineDesk</span>
        </div>
        <div className="card p-6">
          <h1 className="mb-1 text-lg font-semibold">{title}</h1>
          {subtitle && <p className="mb-5 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}
          {children}
        </div>
        <p className="mt-4 text-center text-xs text-slate-400">
          <Link to="/login" className="hover:underline">
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
    <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
      {message}
    </div>
  );
}

export function SuccessNotice({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
      {message}
    </div>
  );
}
