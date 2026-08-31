import { formatDeviceId, normalizeCode } from '../vendor/shared/idFormat';
import { parseServerMessage, PROTOCOL_VERSION, type ServerMessage } from '../vendor/protocol/index';
import type { IceServerConfig } from '../vendor/types/index';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { API_URL, ApiError } from '../lib/apiClient';
import { useAuth } from '../lib/AuthContext';
import { useCreateSession } from '../lib/sessionQueries';

const WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:4000';

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

  // ---- Your Address (share this tab's screen) ----
  const [myAddress, setMyAddress] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [incoming, setIncoming] = useState<{ sessionId: string; from: string } | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
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
      if (!stream) return;
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
  useEffect(() => {
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

  async function handleConnect(e: FormEvent) {
    e.preventDefault();
    setConnectError(null);
    setConnecting(true);
    try {
      if (!user) await guestConnect('Guest');
      const res = await createSession.mutateAsync({
        deviceId: normalizeCode(deviceId),
        unattendedPassword: password || undefined,
      });
      navigate(`/remote/${res.sessionId}`);
    } catch (err) {
      setConnectError(err instanceof ApiError ? err.message : 'Could not start a session.');
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-50 to-brand-50/40 px-4 py-10">
      <div className="mx-auto mb-8 flex max-w-3xl items-center justify-center gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 font-display text-sm font-bold text-white shadow-sm">
          M
        </div>
        <span className="font-display text-xl font-bold tracking-tight text-zinc-900">MineDesk</span>
      </div>

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
                <button type="button" className="btn-secondary" onClick={copyAddress}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className="mt-2 text-xs text-zinc-400">
                Share this so someone can view your screen. This address only lasts as long as this tab
                stays open.
              </p>

              {incoming && (
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

              {sharing && (
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
            {connectError && <p className="text-sm text-red-600">{connectError}</p>}
            <button type="submit" className="btn-primary w-full" disabled={connecting}>
              {connecting ? 'Connecting...' : 'Connect'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
