import { Routes, Route, Navigate } from 'react-router-dom';
import NavBar from './components/NavBar';
import Browse from './pages/Browse';
import Queue from './pages/Queue';
import Storage from './pages/Storage';
import Settings from './pages/Settings';

export default function App() {
  return (
    <div className="flex flex-col min-h-screen">
      <NavBar />
      <main className="flex-1 container mx-auto px-4 py-6 max-w-7xl">
        {/* Keep top-level routes small; page components own their data loading. */}
        <Routes>
          <Route path="/" element={<Navigate to="/browse" replace />} />
          <Route path="/browse" element={<Browse />} />
          <Route path="/queue" element={<Queue />} />
          <Route path="/storage" element={<Storage />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
