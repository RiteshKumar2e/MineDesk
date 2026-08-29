import {
  channelForInput,
  INPUT_CHANNEL_MOTION,
  INPUT_CHANNEL_RELIABLE,
  parseServerMessage,
  PROTOCOL_VERSION,
  type InputMessage,
  type ServerMessage,
} from '@minedesk/protocol';
import type { IceServerConfig } from '@minedesk/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, getAccessToken } from '../lib/apiClient';

type SessionPhase =
  | 'loading'
  | 'connecting'
  | 'waiting-for-approval'
  | 'active'
  | 'reconnecting'
  | 'denied'
  | 'ended'
  | 'failed';

const WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:4000';

const PHASE_LABEL: Record<SessionPhase, string> = {
  loading: 'Loading session...',
  connecting: 'Connecting...',
  'waiting-for-approval': 'Waiting for approval on the remote computer...',
  active: 'Connected',
  reconnecting: 'Network interrupted - reconnecting...',
  denied: 'Connection declined',
  ended: 'Session ended',
  failed: 'Connection failed',
};

/**
 * Maps a click/move position within the rendered <video> element to a
 * normalized [0,1] coordinate over the video's actual pixel content, not the
 * element's box - `object-fit: contain` can letterbox the video, and clicks
 * in the letterbox bars must not be sent at all (there is no remote pixel
 * under them to click).
 */
function normalizedVideoCoordinates(
  video: HTMLVideoElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const rect = video.getBoundingClientRect();
  const videoW = video.videoWidth;
  const videoH = video.videoHeight;
  if (!videoW || !videoH || rect.width === 0 || rect.height === 0) return null;

  const elementAspect = rect.width / rect.height;
  const videoAspect = videoW / videoH;

  let contentWidth = rect.width;
  let contentHeight = rect.height;
  let offsetX = 0;
  let offsetY = 0;

  if (videoAspect > elementAspect) {
    contentHeight = rect.width / videoAspect;
    offsetY = (rect.height - contentHeight) / 2;
  } else {
    contentWidth = rect.height * videoAspect;
    offsetX = (rect.width - contentWidth) / 2;
  }

  const localX = clientX - rect.left - offsetX;
  const localY = clientY - rect.top - offsetY;
  if (localX < 0 || localY < 0 || localX > contentWidth || localY > contentHeight) return null;

  return { x: localX / contentWidth, y: localY / contentHeight };
}

function mouseButtonName(button: number): 'left' | 'right' | 'middle' | null {
  if (button === 0) return 'left';
  if (button === 1) return 'middle';
  if (button === 2) return 'right';
  return null;
}

export default function RemoteSessionPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();

  const [phase, setPhase] = useState<SessionPhase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [deviceLabel, setDeviceLabel] = useState<string>('');

  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const reliableChannelRef = useRef<RTCDataChannel | null>(null);
  const motionChannelRef = useRef<RTCDataChannel | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const hasRemoteDescriptionRef = useRef(false);
  const endedRef = useRef(false);

  const sendSignal = useCallback((message: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, sessionId, ...message }));
    }
  }, [sessionId]);

  const teardown = useCallback((finalPhase: SessionPhase) => {
    if (endedRef.current) return;
    endedRef.current = true;
    setPhase(finalPhase);

    reliableChannelRef.current?.close();
    motionChannelRef.current?.close();
    pcRef.current?.close();
    wsRef.current?.close();
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const handleDisconnect = useCallback(() => {
    sendSignal({ type: 'session:end', reason: 'controller_disconnect' });
    if (sessionId) void api.post(`/api/v1/sessions/${sessionId}/terminate`).catch(() => undefined);
    teardown('ended');
    navigate(-1);
  }, [navigate, sendSignal, sessionId, teardown]);

  useEffect(() => {
    if (!sessionId) return;
    endedRef.current = false;
    let cancelled = false;

    async function connect() {
      setPhase('loading');
      setError(null);

      let iceServers: IceServerConfig[] = [];
      try {
        const res = await api.get<{
          session: { status: string; device: { name: string } };
          iceServers: IceServerConfig[];
        }>(`/api/v1/sessions/${sessionId}`);
        if (cancelled) return;
        setDeviceLabel(res.session.device.name);
        iceServers = res.iceServers;

        if (res.session.status === 'ended') return setPhase('ended');
        if (res.session.status === 'denied') return setPhase('denied');
        if (res.session.status === 'failed') return setPhase('failed');
      } catch {
        if (!cancelled) setError('Could not load this session.');
        return;
      }

      setPhase('connecting');

      const pc = new RTCPeerConnection({
        iceServers: iceServers.map((s) => ({ urls: s.urls, username: s.username, credential: s.credential })),
      });
      pcRef.current = pc;

      pc.ontrack = (event) => {
        if (videoRef.current && event.streams[0]) {
          videoRef.current.srcObject = event.streams[0];
        }
      };

      pc.ondatachannel = (event) => {
        const channel = event.channel;
        if (channel.label === INPUT_CHANNEL_RELIABLE) reliableChannelRef.current = channel;
        if (channel.label === INPUT_CHANNEL_MOTION) motionChannelRef.current = channel;
      };

      pc.oniceconnectionstatechange = () => {
        if (cancelled) return;
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          setPhase('active');
        } else if (pc.iceConnectionState === 'disconnected') {
          setPhase('reconnecting');
        } else if (pc.iceConnectionState === 'failed') {
          teardown('failed');
        }
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignal({
            type: 'webrtc:ice',
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
          });
        }
      };

      const token = getAccessToken();
      const ws = new WebSocket(`${WS_URL}/signal?token=${encodeURIComponent(token ?? '')}&role=controller`);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'session:join', sessionId }));
        setPhase('waiting-for-approval');
      };

      ws.onerror = () => {
        if (!cancelled) setError('Could not reach the signaling server.');
      };

      ws.onclose = () => {
        if (!cancelled && !endedRef.current) teardown('failed');
      };

      ws.onmessage = async (event) => {
        const message: ServerMessage | null = parseServerMessage(String(event.data));
        if (!message) return;

        switch (message.type) {
          case 'session:state': {
            if (message.status === 'active') setPhase((p) => (p === 'loading' ? 'active' : p));
            if (message.status === 'denied') teardown('denied');
            if (message.status === 'ended') teardown('ended');
            if (message.status === 'failed') teardown('failed');
            return;
          }

          case 'session:deny':
            teardown('denied');
            return;

          case 'session:end':
            teardown('ended');
            return;

          case 'webrtc:offer': {
            await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
            hasRemoteDescriptionRef.current = true;
            for (const candidate of pendingCandidatesRef.current.splice(0)) {
              await pc.addIceCandidate(candidate).catch(() => undefined);
            }
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendSignal({ type: 'webrtc:answer', sdp: answer.sdp });
            return;
          }

          case 'webrtc:ice': {
            const candidate: RTCIceCandidateInit = {
              candidate: message.candidate,
              sdpMid: message.sdpMid,
              sdpMLineIndex: message.sdpMLineIndex,
            };
            if (hasRemoteDescriptionRef.current) {
              await pc.addIceCandidate(candidate).catch(() => undefined);
            } else {
              pendingCandidatesRef.current.push(candidate);
            }
            return;
          }

          default:
            return;
        }
      };
    }

    void connect();

    return () => {
      cancelled = true;
      teardown('ended');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const sendInput = useCallback((input: InputMessage) => {
    const channel = channelForInput(input.type) === INPUT_CHANNEL_MOTION ? motionChannelRef.current : reliableChannelRef.current;
    if (channel && channel.readyState === 'open') {
      channel.send(JSON.stringify(input));
    }
  }, []);

  function onMouseMove(e: React.MouseEvent<HTMLVideoElement>) {
    const video = videoRef.current;
    if (!video) return;
    const point = normalizedVideoCoordinates(video, e.clientX, e.clientY);
    if (point) sendInput({ type: 'mouse:move', ...point });
  }

  function onMouseDown(e: React.MouseEvent<HTMLVideoElement>) {
    const video = videoRef.current;
    const button = mouseButtonName(e.button);
    const point = video && normalizedVideoCoordinates(video, e.clientX, e.clientY);
    if (point && button) sendInput({ type: 'mouse:down', button, ...point });
  }

  function onMouseUp(e: React.MouseEvent<HTMLVideoElement>) {
    const video = videoRef.current;
    const button = mouseButtonName(e.button);
    const point = video && normalizedVideoCoordinates(video, e.clientX, e.clientY);
    if (point && button) sendInput({ type: 'mouse:up', button, ...point });
  }

  function onDoubleClick(e: React.MouseEvent<HTMLVideoElement>) {
    const video = videoRef.current;
    const point = video && normalizedVideoCoordinates(video, e.clientX, e.clientY);
    if (point) sendInput({ type: 'mouse:dblclick', button: 'left', ...point });
  }

  function onWheel(e: React.WheelEvent<HTMLVideoElement>) {
    const video = videoRef.current;
    const point = video && normalizedVideoCoordinates(video, e.clientX, e.clientY);
    if (point) sendInput({ type: 'mouse:wheel', deltaX: e.deltaX, deltaY: e.deltaY, ...point });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Keep ordinary browser shortcuts (refresh, devtools, tab switching) out of
    // the remote session's way, but let everything else through to the agent.
    if (!['F5', 'F11', 'F12'].includes(e.key)) e.preventDefault();
    sendInput({ type: 'key:down', code: e.code });
  }

  function onKeyUp(e: React.KeyboardEvent<HTMLDivElement>) {
    sendInput({ type: 'key:up', code: e.code });
  }

  const isInteractive = phase === 'active';

  return (
    <div className="flex h-screen flex-col bg-slate-950 text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800 bg-slate-900 px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">{deviceLabel || 'Remote session'}</span>
          <span
            className={
              'badge ' +
              (phase === 'active'
                ? 'bg-emerald-950 text-emerald-300'
                : phase === 'reconnecting'
                  ? 'bg-amber-950 text-amber-300'
                  : phase === 'denied' || phase === 'failed'
                    ? 'bg-red-950 text-red-300'
                    : 'bg-slate-800 text-slate-300')
            }
          >
            {PHASE_LABEL[phase]}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-secondary"
            disabled={!isInteractive}
            onClick={() => sendInput({ type: 'shortcut', name: 'ctrl-alt-del' })}
            title="Send Ctrl+Alt+Del"
          >
            Ctrl+Alt+Del
          </button>
          <button type="button" className="btn-danger" onClick={handleDisconnect}>
            Disconnect
          </button>
        </div>
      </header>

      <div
        ref={containerRef}
        className="relative flex flex-1 items-center justify-center overflow-hidden bg-black outline-none"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
      >
        {error && <p className="text-sm text-red-400">{error}</p>}

        {!error && phase !== 'active' && phase !== 'reconnecting' && (
          <p className="text-sm text-slate-400">{PHASE_LABEL[phase]}</p>
        )}

        <video
          ref={videoRef}
          autoPlay
          playsInline
          className={phase === 'active' || phase === 'reconnecting' ? 'max-h-full max-w-full' : 'hidden'}
          onMouseMove={isInteractive ? onMouseMove : undefined}
          onMouseDown={isInteractive ? onMouseDown : undefined}
          onMouseUp={isInteractive ? onMouseUp : undefined}
          onDoubleClick={isInteractive ? onDoubleClick : undefined}
          onWheel={isInteractive ? onWheel : undefined}
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>
    </div>
  );
}
