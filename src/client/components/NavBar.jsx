import { NavLink } from 'react-router-dom';
import { useEffect, useState } from 'react';

const links = [
  { to: '/browse', label: 'Browse' },
  { to: '/queue', label: 'Queue' },
  { to: '/storage', label: 'Storage' },
  { to: '/settings', label: 'Settings' },
];

export default function NavBar() {
  const [health, setHealth] = useState(null);

  useEffect(() => {
    fetch('/health').then((r) => r.json()).then(setHealth).catch(() => {});
    const id = setInterval(() => {
      fetch('/health').then((r) => r.json()).then(setHealth).catch(() => {});
    }, 30000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="bg-panel border-b border-border sticky top-0 z-50">
      <div className="container mx-auto px-4 max-w-7xl flex items-center gap-6 h-14">
        <span className="font-bold text-white tracking-tight flex items-center gap-2">
          🚐 RV Showrunner
        </span>
        <nav className="flex gap-1">
          {links.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `px-3 py-1.5 rounded text-sm transition-colors ${
                  isActive ? 'bg-accent text-white' : 'text-gray-400 hover:text-white hover:bg-surface'
                }`
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2 text-xs">
          {health && (
            <span className={`flex items-center gap-1 ${health.ok ? 'text-green-400' : 'text-yellow-400'}`}>
              <span className={`w-2 h-2 rounded-full ${health.ok ? 'bg-green-400' : 'bg-yellow-400'}`} />
              {health.checks?.hwAccelMode || health.checks?.gpu?.hwAccelMode || 'hw: ?'}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
