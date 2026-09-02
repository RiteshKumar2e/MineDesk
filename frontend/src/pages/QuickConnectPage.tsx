import { formatDeviceId, normalizeCode } from '../vendor/shared/idFormat';
import { parseServerMessage, PROTOCOL_VERSION, type ServerMessage } from '../vendor/protocol/index';
import type { IceServerConfig } from '../vendor/types/index';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { API_URL, ApiError } from '../lib/apiClient';
import { useAuth } from '../lib/AuthContext';
import { useCreateSession } from '../lib/sessionQueries';

const WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:4000';

// Set only when this page is rendered inside the MineDesk desktop app's
// webview (see frontend/src-tauri), never in an ordinary browser tab.
// window.__TAURI_INTERNALS__ is injected by the Tauri runtime itself, so
// this is a reliable way to tell the two hosts apart without an env var
// baked in at build time (the same web build runs in both places).
const isTauriApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function InfoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-5M12 8h.01" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="11" width="16" height="9" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2.5l2.9 6.1 6.6.7-4.9 4.6 1.3 6.6-5.9-3.3-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.7 2.9-6.1z" />
    </svg>
  );
}

/**
 * "Recent" and "Favorites", AnyDesk's other two home-screen tabs - kept in
 * this browser's localStorage rather than the account, since a guest here
 * gets a brand new disposable account every visit (see guestConnect) and so
 * has no server-side history to show. "Discovered" (LAN broadcast scanning)
 * and "Invitations" (team sharing) are deliberately not built - neither has
 * anything real behind it in this product yet, and a tab that does nothing
 * when clicked is worse than no tab at all.
 */
interface SavedAddress {
  deviceId: string;
  lastConnectedAt: number;
}
const RECENT_KEY = 'minedesk:recentAddresses';
const FAVORITES_KEY = 'minedesk:favoriteAddresses';
const MAX_RECENT = 8;

function loadAddresses(key: string): SavedAddress[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAddresses(key: string, list: SavedAddress[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* storage blocked (private mode, quota) - not fatal, just no history */
  }
}

function recordRecentConnection(deviceId: string): void {
  const existing = loadAddresses(RECENT_KEY).filter((a) => a.deviceId !== deviceId);
  const next = [{ deviceId, lastConnectedAt: Date.now() }, ...existing].slice(0, MAX_RECENT);
  saveAddresses(RECENT_KEY, next);
}

/**
 * The AnyDesk-style home screen: "Your Address" and "Remote Address" side by
 * side, both usable with no account.
 *
 * "Your Address" registers this tab as a screen-only, single-use device the
 * moment the page loads - no click needed for the id itself to appear, same
 * as AnyDesk's own client. What *does* need a click, unavoidably, is the
 * screen-share permission prompt: browsers refuse to grant
 * getDisplayMedia() outside a direct user gesture, so it cannot fire
 * automatically when a viewer connects. That works out to the same UX
 * AnyDesk has anyway - someone has to accept the incoming request - so the
 * accept button below doubles as that gesture. Closing this tab (or losing
 * the connection) deletes the address for good; reopening always gets a new
 * one - see backend/src/modules/agent/routes.ts's `/register` and
 * signaling/routes.ts's close handler.
 */
export default function QuickConnectPage() {
  const { user, guestConnect } = useAuth();
  const createSession = useCreateSession();
  const navigate = useNavigate();

  // ---- Remote Address (connect to someone else) ----
  const [deviceId, setDeviceId] = useState('');
  const [password, setPassword] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [wakingUp, setWakingUp] = useState(false);

  // ---- Recent / Favorites (localStorage - see the block above) ----
  const [listTab, setListTab] = useState<'recent' | 'favorites'>('recent');
  const [recent, setRecent] = useState<SavedAddress[]>([]);
  const [favorites, setFavorites] = useState<SavedAddress[]>([]);

  useEffect(() => {
    setRecent(loadAddresses(RECENT_KEY));
    setFavorites(loadAddresses(FAVORITES_KEY));
  }, []);

  function toggleFavorite(id: string) {
    const isFavorite = favorites.some((a) => a.deviceId === id);
    const next = isFavorite
      ? favorites.filter((a) => a.deviceId !== id)
      : [{ deviceId: id, lastConnectedAt: Date.now() }, ...favorites];
    setFavorites(next);
    saveAddresses(FAVORITES_KEY, next);
  }

  // ---- Your Address (share this tab's screen) ----
  const [myAddress, setMyAddress] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [incoming, setIncoming] = useState<{ sessionId: string; from: string } | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [autostartEnabled, setAutostartEnabled] = useState<boolean | null>(null);
  const remoteAddressInputRef = useRef<HTMLInputElement>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Set when `session:ready` arrives before the human has clicked Accept -
  // getDisplayMedia() needs a real user gesture, so unlike the native
  // agent's auto-accept path, there can be a real, human-timescale gap
  // between the controller joining (which is what triggers session:ready)
  // and streamRef actually having a stream. Without remembering this, the
  // dropped session:ready is never retried once accept finally happens,
  // and the controller sits at "waiting for approval" forever even though
  // the screen share was, in fact, approved.
  const pendingReadyRef = useRef<string | null>(null);
  const iceServersRef = useRef<IceServerConfig[]>([]);
  const heartbeatRef = useRef<number | null>(null);
  const closingRef = useRef(false);

  const sendSignal = useCallback((sessionId: string, message: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, sessionId, ...message }));
    }
  }, []);

  const teardownShare = useCallback(() => {
    closingRef.current = true;
    if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
    pcRef.current?.close();
    pcRef.current = null;
    wsRef.current?.close();
    wsRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setMyAddress(null);
    setIncoming(null);
    setSharing(false);
  }, []);

  const createAndSendOffer = useCallback(
    async (sessionId: string) => {
      const stream = streamRef.current;
      if (!stream) {
        pendingReadyRef.current = sessionId;
        return;
      }
      const pc = new RTCPeerConnection({
        iceServers: iceServersRef.current.map((s) => ({ urls: s.urls, username: s.username, credential: s.credential })),
      });
      pcRef.current = pc;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignal(sessionId, {
            type: 'webrtc:ice',
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
          });
        }
      };
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
          pc.close();
          if (pcRef.current === pc) pcRef.current = null;
          setSharing(false);
        }
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal(sessionId, { type: 'webrtc:offer', sdp: offer.sdp ?? '' });
    },
    [sendSignal],
  );

  const handleShareMessage = useCallback(
    (message: ServerMessage | null) => {
      if (!message) return;
      switch (message.type) {
        case 'hello:ack':
          if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
          heartbeatRef.current = window.setInterval(() => {
            wsRef.current?.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'heartbeat', sentAt: Date.now() }));
          }, message.heartbeatIntervalMs);
          return;

        case 'session:invite':
          // This is the click AnyDesk would show as "Someone wants to
          // connect" - and, not incidentally, the only place a browser will
          // actually let us ask for screen-share permission.
          setIncoming({ sessionId: message.sessionId, from: message.controller.name });
          return;

        case 'session:ready':
          void createAndSendOffer(message.sessionId);
          return;

        case 'webrtc:answer':
          void pcRef.current?.setRemoteDescription({ type: 'answer', sdp: message.sdp });
          return;

        case 'webrtc:ice':
          void pcRef.current
            ?.addIceCandidate({ candidate: message.candidate, sdpMid: message.sdpMid, sdpMLineIndex: message.sdpMLineIndex })
            .catch(() => undefined);
          return;

        case 'session:end':
          pcRef.current?.close();
          pcRef.current = null;
          setSharing(false);
          return;

        default:
          return;
      }
    },
    [createAndSendOffer],
  );

  // Register "Your Address" the moment the page loads - no click needed for
  // the id itself, only for actually granting screen access later.
  //
  // Inside the desktop app this page does not register anything itself: the
  // bundled minedesk-agent sidecar (frontend/src-tauri/src/lib.rs) already
  // self-registers a real, full-control device and keeps its identity in
  // %ProgramData%\MineDesk\agent.toml, which is what should persist across
  // launches (see backend/agent/src/config.rs). Registering a second,
  // ephemeral "os: browser" device here as well - as this effect does for a
  // plain browser tab - would just show the wrong, view-only, throwaway
  // address as "Your Address" and leave the real one invisible.
  useEffect(() => {
    if (isTauriApp) {
      let cancelled = false;
      let attempts = 0;

      async function pollSidecarIdentity() {
        const { invoke } = await import('@tauri-apps/api/core');
        while (!cancelled && attempts < 30) {
          attempts += 1;
          try {
            const identity = await invoke<{ device_id: string | null }>('get_device_identity');
            if (identity.device_id) {
              if (!cancelled) setMyAddress(identity.device_id);
              return;
            }
          } catch {
            // sidecar not reachable yet - keep retrying below
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        if (!cancelled) {
          setShareError('Could not reach the MineDesk agent - try restarting the app.');
        }
      }

      void pollSidecarIdentity();
      return () => {
        cancelled = true;
      };
    }

    closingRef.current = false;
    let cancelled = false;

    async function register() {
      try {
        const registerRes = await fetch(`${API_URL}/api/v1/agent/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hostname: 'Browser', os: 'browser' }),
        });
        if (!registerRes.ok) throw new Error();
        const registered: { deviceId: string; agentSecret: string } = await registerRes.json();
        if (cancelled) return;

        const authRes = await fetch(`${API_URL}/api/v1/agent/auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: registered.deviceId, secret: registered.agentSecret }),
        });
        if (!authRes.ok) throw new Error();
        const auth: { token: string } = await authRes.json();
        if (cancelled) return;

        const configRes = await fetch(`${API_URL}/api/v1/agent/config`, {
          headers: { Authorization: `Bearer ${auth.token}` },
        });
        const config: { iceServers: IceServerConfig[] } = configRes.ok ? await configRes.json() : { iceServers: [] };
        iceServersRef.current = config.iceServers;
        if (cancelled) return;

        const ws = new WebSocket(`${WS_URL}/signal?token=${encodeURIComponent(auth.token)}&role=agent`);
        wsRef.current = ws;
        ws.onopen = () => ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello', role: 'agent' }));
        ws.onmessage = (event) => handleShareMessage(parseServerMessage(String(event.data)));
        ws.onclose = () => {
          if (!closingRef.current) teardownShare();
        };

        setMyAddress(registered.deviceId);
      } catch {
        if (!cancelled) setShareError('Could not get an address - try reloading the page.');
      }
    }

    void register();
    return () => {
      cancelled = true;
      teardownShare();
    };
    // Intentionally runs once per mount - a fresh address every time this
    // page loads, never reused.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The tray's "Settings" menu item (frontend/src-tauri/src/lib.rs) has no
  // window of its own - it just asks this page to open the same panel the
  // header's gear icon does.
  useEffect(() => {
    if (!isTauriApp) return;
    const unlisteners: Array<() => void> = [];
    void import('@tauri-apps/api/event').then(({ listen }) => {
      void listen('tray:settings', () => setShowSettings(true)).then((fn) => unlisteners.push(fn));
      void listen('tray:new-session', () => remoteAddressInputRef.current?.focus()).then((fn) => unlisteners.push(fn));
    });
    return () => unlisteners.forEach((fn) => fn());
  }, []);

  async function openSettings() {
    setShowSettings(true);
    if (!isTauriApp) return;
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      setAutostartEnabled(await invoke<boolean>('is_autostart_enabled'));
    } catch {
      setAutostartEnabled(null);
    }
  }

  async function toggleAutostart(enabled: boolean) {
    setAutostartEnabled(enabled);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_autostart_enabled', { enabled });
    } catch {
      setAutostartEnabled(!enabled);
    }
  }

  async function acceptIncoming() {
    if (!incoming) return;
    const sessionId = incoming.sessionId;
    setIncoming(null);
    setShareError(null);
    try {
      // The click handling this button is the user gesture that makes this
      // call valid - it cannot be triggered from the WS message handler above.
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        sendSignal(sessionId, { type: 'session:end', reason: 'local_user_terminated' });
        pcRef.current?.close();
        pcRef.current = null;
        streamRef.current = null;
        setSharing(false);
      });
      sendSignal(sessionId, { type: 'session:accept', screens: [] });
      setSharing(true);
      // The controller may already have joined and been told
      // session:ready while we were waiting on the human to click Accept -
      // that event was dropped (see createAndSendOffer) since there was no
      // stream yet. Don't wait for a session:ready that already happened.
      if (pendingReadyRef.current === sessionId) {
        pendingReadyRef.current = null;
        void createAndSendOffer(sessionId);
      }
    } catch {
      sendSignal(sessionId, { type: 'session:deny', reason: 'user_declined' });
      setShareError('Screen-share permission was not granted.');
    }
  }

  function declineIncoming() {
    if (!incoming) return;
    sendSignal(incoming.sessionId, { type: 'session:deny', reason: 'user_declined' });
    setIncoming(null);
  }

  async function copyAddress() {
    if (!myAddress) return;
    try {
      await navigator.clipboard.writeText(myAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked - the id is on screen anyway */
    }
  }

  // The free (Render) API host sleeps after inactivity and can take up to
  // ~45s to wake on the next request - a guest-account request landing in
  // that window can fail even though the exact same request would succeed a
  // few seconds later, once the server has finished booting. Retried
  // transparently here rather than surfaced as a hard error on the very
  // first click, since from the user's perspective nothing is actually
  // wrong - the server is just still waking up.
  async function guestConnectWithRetry() {
    const delaysMs = [2000, 4000, 8000, 15000, 15000];
    for (let attempt = 0; ; attempt++) {
      try {
        await guestConnect('Guest');
        return;
      } catch (err) {
        if (attempt >= delaysMs.length) throw err;
        setWakingUp(true);
        await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
      }
    }
  }

  async function connectTo(rawDeviceId: string, unattendedPassword: string | undefined) {
    setConnectError(null);
    setConnecting(true);
    setWakingUp(false);
    try {
      const normalized = normalizeCode(rawDeviceId);
      if (!user) await guestConnectWithRetry();
      const res = await createSession.mutateAsync({ deviceId: normalized, unattendedPassword });
      recordRecentConnection(normalized);
      navigate(`/remote/${res.sessionId}`);
    } catch (err) {
      setConnectError(err instanceof ApiError ? err.message : 'Could not start a session.');
      if (isTauriApp) {
        void import('@tauri-apps/api/core').then(({ invoke }) =>
          invoke('debug_log', {
            message: `[connectTo ${new Date().toISOString()}] isApiError=${err instanceof ApiError} name=${err instanceof Error ? err.name : typeof err} message=${err instanceof Error ? err.message : String(err)} code=${err instanceof ApiError ? err.code : 'n/a'} status=${err instanceof ApiError ? err.status : 'n/a'} stack=${err instanceof Error ? err.stack : 'n/a'}`,
          }).catch(() => {}),
        );
      }
    } finally {
      setConnecting(false);
      setWakingUp(false);
    }
  }

  async function handleConnect(e: FormEvent) {
    e.preventDefault();
    await connectTo(deviceId, password || undefined);
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-50 to-brand-50/40 px-4 py-10">
      <div className="relative mx-auto mb-8 flex max-w-3xl items-center justify-center gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 font-display text-sm font-bold text-white shadow-sm">
          M
        </div>
        <span className="font-display text-xl font-bold tracking-tight text-zinc-900">MineDesk</span>
        {isTauriApp && (
          <button
            type="button"
            className="absolute right-0 rounded-full p-2 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
            aria-label="Settings"
            onClick={openSettings}
          >
            <GearIcon />
          </button>
        )}
      </div>

      {showSettings && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-zinc-900/40 px-4" onClick={() => setShowSettings(false)}>
          <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold text-zinc-900">Settings</h2>

            <label className="mt-4 flex items-center justify-between gap-4">
              <span className="text-sm text-zinc-700">Start MineDesk when Windows starts</span>
              <input
                type="checkbox"
                checked={autostartEnabled ?? false}
                disabled={autostartEnabled === null}
                onChange={(e) => void toggleAutostart(e.target.checked)}
                className="h-4 w-4 accent-brand-600"
              />
            </label>

            <p className="mt-4 text-xs text-zinc-500">
              Closing this window keeps MineDesk running in the background so this computer stays
              reachable. Use <span className="font-medium">Quit MineDesk</span> from the tray icon to
              exit completely.
            </p>

            <button type="button" className="btn-secondary mt-5 w-full" onClick={() => setShowSettings(false)}>
              Close
            </button>
          </div>
        </div>
      )}

      <div className="mx-auto grid max-w-3xl gap-4 md:grid-cols-2">
        <div className="card p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Your Address</h2>

          {shareError && <p className="mt-3 text-sm text-red-600">{shareError}</p>}

          {!myAddress && !shareError && <p className="mt-3 text-sm text-zinc-500">Getting your address...</p>}

          {myAddress && (
            <>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <span className="font-mono text-4xl font-semibold tabular-nums tracking-tight text-brand-700">
                  {formatDeviceId(myAddress)}
                </span>
                <div className="relative flex items-center gap-1 text-zinc-400">
                  <button
                    type="button"
                    className="rounded-full p-1.5 hover:bg-zinc-100 hover:text-zinc-600"
                    aria-label="What is this address?"
                    onClick={() => setShowInfo((v) => !v)}
                    onBlur={() => setShowInfo(false)}
                  >
                    <InfoIcon />
                  </button>
                  {showInfo && (
                    <div className="absolute left-0 top-full z-10 mt-2 w-64 rounded-lg border border-zinc-200 bg-white p-3 text-xs text-zinc-600 shadow-lg">
                      {isTauriApp
                        ? 'Anyone with this address can request to connect to this computer. This is your permanent MineDesk address - it stays the same every time you open the app.'
                        : 'Anyone with this address can request to view your screen. You will get a prompt to approve it - this address stops working the moment you close this tab.'}
                    </div>
                  )}
                  <LockIcon />
                </div>
                <button type="button" className="btn-secondary" onClick={copyAddress}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className="mt-2 text-xs text-zinc-400">
                {isTauriApp
                  ? 'Share this so someone can connect to this computer. Incoming requests are handled by the MineDesk agent running in the background.'
                  : 'Share this so someone can view your screen. This address only lasts as long as this tab stays open.'}
              </p>

              {!isTauriApp && incoming && (
                <div className="mt-4 rounded-xl border border-brand-200 bg-brand-50 p-4">
                  <p className="text-sm font-medium text-zinc-900">{incoming.from || 'Someone'} wants to view your screen.</p>
                  <div className="mt-3 flex gap-2">
                    <button type="button" className="btn-primary" onClick={acceptIncoming}>
                      Accept
                    </button>
                    <button type="button" className="btn-ghost" onClick={declineIncoming}>
                      Decline
                    </button>
                  </div>
                </div>
              )}

              {!isTauriApp && sharing && (
                <>
                  <p className="mt-4 text-xs font-medium text-emerald-600">● Sharing your screen</p>
                  <video ref={videoRef} autoPlay muted playsInline className="mt-2 w-full rounded-lg bg-zinc-900" />
                </>
              )}
            </>
          )}
        </div>

        <div className="card p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Remote Address</h2>
          <p className="mt-1 text-sm text-zinc-500">Enter the address someone shared with you.</p>
          <form onSubmit={handleConnect} className="mt-4 space-y-3">
            <input
              ref={remoteAddressInputRef}
              className="input font-mono text-lg tabular-nums"
              placeholder="552 246 274"
              inputMode="numeric"
              autoFocus
              required
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
            />
            <input
              type="password"
              className="input"
              placeholder="Access password (only for unattended access)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {wakingUp && (
              <p className="text-sm text-amber-600">Waking up the server, please wait - this can take up to a minute...</p>
            )}
            {connectError && <p className="text-sm text-red-600">{connectError}</p>}
            <button type="submit" className="btn-primary w-full" disabled={connecting}>
              {wakingUp ? 'Waking up server...' : connecting ? 'Connecting...' : 'Connect'}
            </button>
          </form>
        </div>
      </div>

      {!isTauriApp && (
        <div className="mx-auto mt-4 flex max-w-3xl items-center justify-between gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3">
          <p className="text-sm text-zinc-700">
            Browser connections are view-only. Install the MineDesk app for full control - mouse, keyboard,
            files and a permanent address for this computer.
          </p>
          <a href={`${API_URL}/api/v1/agent/download-desktop`} className="btn-primary shrink-0 whitespace-nowrap">
            Download for Windows
          </a>
        </div>
      )}

      <div className="mx-auto mt-6 max-w-3xl">
        <div className="mb-3 flex gap-1 border-b border-zinc-200">
          {(['recent', 'favorites'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setListTab(tab)}
              className={
                listTab === tab
                  ? 'border-b-2 border-brand-600 px-3 py-2 text-sm font-semibold text-brand-700'
                  : 'border-b-2 border-transparent px-3 py-2 text-sm font-medium text-zinc-500 hover:text-zinc-800'
              }
            >
              {tab === 'recent' ? 'Recent Sessions' : 'Favorites'}
            </button>
          ))}
        </div>

        {(listTab === 'recent' ? recent : favorites).length === 0 ? (
          <p className="px-1 py-4 text-sm text-zinc-400">
            {listTab === 'recent'
              ? 'Addresses you connect to will show up here for quick reconnecting.'
              : 'Star an address after connecting to it to pin it here.'}
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {(listTab === 'recent' ? recent : favorites).map((entry) => (
              <li key={entry.deviceId} className="flex items-center gap-3 px-1 py-2.5">
                <button
                  type="button"
                  className="text-amber-400 hover:text-amber-500"
                  aria-label={favorites.some((a) => a.deviceId === entry.deviceId) ? 'Remove from favorites' : 'Add to favorites'}
                  onClick={() => toggleFavorite(entry.deviceId)}
                >
                  <StarIcon filled={favorites.some((a) => a.deviceId === entry.deviceId)} />
                </button>
                <button
                  type="button"
                  className="flex-1 text-left font-mono text-sm tabular-nums text-zinc-700 hover:text-brand-700"
                  onClick={() => setDeviceId(formatDeviceId(entry.deviceId))}
                >
                  {formatDeviceId(entry.deviceId)}
                </button>
                <span className="text-xs text-zinc-400">
                  {new Date(entry.lastConnectedAt).toLocaleDateString()}
                </span>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={connecting}
                  onClick={() => void connectTo(entry.deviceId, undefined)}
                >
                  Connect
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
