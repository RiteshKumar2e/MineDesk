import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/AppLayout';
import { RequireAuth } from './components/RequireAuth';
import { useAuth } from './lib/AuthContext';
import ActivityPage from './pages/ActivityPage';
import DeviceDetailPage from './pages/DeviceDetailPage';
import DevicesPage from './pages/DevicesPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import LoginPage from './pages/LoginPage';
import QuickConnectPage from './pages/QuickConnectPage';
import RegisterPage from './pages/RegisterPage';
import RemoteSessionPage from './pages/RemoteSessionPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import SecurityPage from './pages/SecurityPage';
import SettingsPage from './pages/SettingsPage';
import VerifyEmailPage from './pages/VerifyEmailPage';

export default function App() {
  const { loading } = useAuth();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-slate-400">
        Loading MineDesk...
      </div>
    );
  }

  return (
    <Routes>
      {/* The AnyDesk-style front door: whoever opens the site lands here, no
          login wall in the way - see QuickConnectPage's doc comment. */}
      <Route path="/" element={<QuickConnectPage />} />
      <Route path="/connect" element={<QuickConnectPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />

      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route path="/dashboard" element={<Navigate to="/devices" replace />} />
        <Route path="/devices" element={<DevicesPage />} />
        <Route path="/devices/:id" element={<DeviceDetailPage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/security" element={<SecurityPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>

      {/* Full-screen: no dashboard chrome while a remote-control session is up. */}
      <Route
        path="/remote/:sessionId"
        element={
          <RequireAuth>
            <RemoteSessionPage />
          </RequireAuth>
        }
      />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
