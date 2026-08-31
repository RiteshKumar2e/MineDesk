import clsx from 'clsx';

export function StatusDot({ online }: { online: boolean }) {
  return (
    <span
      className={clsx('inline-block h-2.5 w-2.5 rounded-full', online ? 'bg-emerald-500' : 'bg-slate-400')}
      aria-hidden
    />
  );
}
