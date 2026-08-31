import clsx from 'clsx';
import type { SVGProps } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';

function iconProps(props: SVGProps<SVGSVGElement>): SVGProps<SVGSVGElement> {
  return {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    ...props,
  };
}

function DevicesIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

function ActivityIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M3 12h4l2.5-7 4 14 2.5-7H21" />
    </svg>
  );
}

function ShieldIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
    </svg>
  );
}

function SettingsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function LogOutIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
    </svg>
  );
}

const NAV_ITEMS = [
  { to: '/devices', label: 'My Devices', Icon: DevicesIcon },
  { to: '/activity', label: 'Activity', Icon: ActivityIcon },
  { to: '/security', label: 'Security', Icon: ShieldIcon },
  { to: '/settings', label: 'Settings', Icon: SettingsIcon },
];

export function AppLayout() {
  const { user, logout } = useAuth();

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-200/80 bg-white">
        <div className="flex items-center gap-2.5 px-6 py-6">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 font-display text-sm font-bold text-white shadow-sm">
            M
          </div>
          <span className="font-display text-lg font-bold tracking-tight text-zinc-900">MineDesk</span>
        </div>

        <nav className="flex-1 space-y-1 px-4">
          {NAV_ITEMS.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  isActive ? 'bg-brand-50 text-brand-700' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900',
                )
              }
            >
              <Icon className="shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-zinc-200/80 p-4">
          <div className="mb-3 rounded-lg bg-zinc-50 px-3 py-2.5">
            <div className="truncate text-sm font-semibold text-zinc-900">{user?.name}</div>
            <div className="truncate text-xs text-zinc-500">{user?.email}</div>
          </div>
          <button type="button" className="btn-ghost w-full justify-start" onClick={() => void logout()}>
            <LogOutIcon className="shrink-0" />
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-8 py-10">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
