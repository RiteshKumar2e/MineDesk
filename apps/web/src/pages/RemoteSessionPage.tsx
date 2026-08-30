import {
  channelForInput,
  FILE_CHANNEL,
  INPUT_CHANNEL_MOTION,
  INPUT_CHANNEL_RELIABLE,
  parseInputMessage,
  parseServerMessage,
  PROTOCOL_VERSION,
  type InputMessage,
  type ServerMessage,
} from '@minedesk/protocol';
import type { IceServerConfig } from '@minedesk/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FileManagerPanel } from '../components/FileManagerPanel';
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

/** Camera/microphone go through their own request/response handshake with a
 * human at the remote machine (see PROMPTED_CAPABILITIES) - this tracks
 * where that handshake currently stands, independent of the session phase. */
type CapabilityUiState = 'idle' | 'requesting' | 'active' | 'denied';

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

let reportedConnectionTypeFor: string | null = null;

/**
 * Reports whether the media path ended up direct (peer-to-peer, possibly via
 * a NAT-traversal-assisting STUN-discovered address) or relayed through
 * TURN, by inspecting the selected candidate pair. This is the only place
 * that information exists - the API never sees the media path itself - so
 * without this call every session's connection-type history would just be
 * blank. Reported once per session; a later reconnect through a different
 * path is a nuance the access-history view does not need.
 */
async function reportConnectionType(pc: RTCPeerConnection, sessionId: string | undefined): Promise<void> {
  if (!sessionId || reportedConnectionTypeFor === sessionId) return;
  reportedConnectionTypeFor = sessionId;

  try {
    const stats = await pc.getStats();
    let connectionType: 'direct' | 'relay' | null = null;

    stats.forEach((report) => {
      if (report.type === 'transport' && report.selectedCandidatePairId) {
        const pair = stats.get(report.selectedCandidatePairId as string);
        if (pair) {
          const local = stats.get(pair.localCandidateId as string);
          const remote = stats.get(pair.remoteCandidateId as string);
          connectionType = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct';
        }
      }
    });

    if (connectionType) {
      await api.patch(`/api/v1/sessions/${sessionId}/activity`, { connectionType });
    }
  } catch {
    /* best-effort: connection-type history is a nicety, not a correctness requirement */
  }
}

function reportActivity(sessionId: string | undefined, flag: 'usedCamera' | 'usedMicrophone' | 'usedAudio' | 'usedClipboard' | 'usedFiles'): void {
  if (!sessionId) return;
  void api.patch(`/api/v1/sessions/${sessionId}/activity`, { [flag]: true }).catch(() => undefined);
}

export default function RemoteSessionPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();

  const [phase, setPhase] = useState<SessionPhase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [deviceLabel, setDeviceLabel] = useState<string>('');
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [showFiles, setShowFiles] = useState(false);
  const [fileChannel, setFileChannel] = useState<RTCDataChannel | null>(null);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [clipboardToast, setClipboardToast] = useState<string | null>(null);
  const [cameraState, setCameraState] = useState<CapabilityUiState>('idle');
  const [microphoneState, setMicrophoneState] = useState<CapabilityUiState>('idle');

  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraPreviewRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const reliableChannelRef = useRef<RTCDataChannel | null>(null);
  const motionChannelRef = useRef<RTCDataChannel | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const hasRemoteDescriptionRef = useRef(false);
  const endedRef = useRef(false);
  const clipboardFromRemoteRef = useRef<string | null>(null);
  // requestId -> which capability it was asking for, so a capability:response
  // can be matched to the right piece of UI state even if a second request
  // (for the other capability) is issued before the first one answers.
  const pendingCapabilityRequestsRef = useRef<Map<string, 'camera' | 'microphone'>>(new Map());

  const hasCapability = useCallback((name: string) => capabilities.includes(name), [capabilities]);

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
    if (cameraPreviewRef.current) cameraPreviewRef.current.srcObject = null;
    setFileChannel(null);
    setCameraState('idle');
    setMicrophoneState('idle');
    pendingCapabilityRequestsRef.current.clear();
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
      // Read directly rather than through the `hasCapability`/`capabilities`
      // state below: this whole function runs before React has had a chance
      // to re-render with that state, so a state-derived closure would still
      // see last render's (empty, on first connect) value further down.
      let sessionCapabilities: string[] = [];
      try {
        const res = await api.get<{
          session: { status: string; device: { name: string }; capabilities: string[] };
          iceServers: IceServerConfig[];
        }>(`/api/v1/sessions/${sessionId}`);
        if (cancelled) return;
        setDeviceLabel(res.session.device.name);
        setCapabilities(res.session.capabilities);
        sessionCapabilities = res.session.capabilities;
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
        // Track IDs are set by the agent (see session.rs) specifically so
        // they survive to here: "camera"/"microphone" share a preview
        // element separate from the main "screen"/"audio" stream, so
        // granting a camera mid-session can never clobber the screen view.
        const isCameraOrMic = event.track.id === 'camera' || event.track.id === 'microphone';
        const target = isCameraOrMic ? cameraPreviewRef.current : videoRef.current;
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        if (target) target.srcObject = stream;
      };

      pc.ondatachannel = (event) => {
        const channel = event.channel;
        if (channel.label === INPUT_CHANNEL_RELIABLE) {
          reliableChannelRef.current = channel;
          // Clipboard updates from the remote machine arrive on this same
          // channel (see channelForInput) - mouse/keyboard on it are strictly
          // outbound, so this is the only inbound traffic to expect here.
          channel.addEventListener('message', (e) => {
            const message = parseInputMessage(String(e.data));
            if (message?.type === 'clipboard:text' && message.direction === 'to-controller') {
              void navigator.clipboard
                .writeText(message.text)
                .then(() => setClipboardToast('Copied from remote clipboard.'))
                .catch(() => setClipboardToast('Remote clipboard changed - click to copy.'));
              clipboardFromRemoteRef.current = message.text;
              reportActivity(sessionId, 'usedClipboard');
            }
          });
        }
        if (channel.label === INPUT_CHANNEL_MOTION) motionChannelRef.current = channel;
        if (channel.label === FILE_CHANNEL) setFileChannel(channel);
      };

      pc.oniceconnectionstatechange = () => {
        if (cancelled) return;
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          setPhase('active');
          void reportConnectionType(pc, sessionId);
          if (sessionCapabilities.includes('audio')) reportActivity(sessionId, 'usedAudio');
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

          case 'capability:response': {
            const requested = pendingCapabilityRequestsRef.current.get(message.requestId);
            if (!requested || requested !== message.capability) return;
            pendingCapabilityRequestsRef.current.delete(message.requestId);

            const setState = requested === 'camera' ? setCameraState : setMicrophoneState;
            if (message.granted) {
              setState('active');
              reportActivity(sessionId, requested === 'camera' ? 'usedCamera' : 'usedMicrophone');
            } else {
              setState('denied');
              if (message.osDenied) {
                setError(
                  `The remote computer could not enable its ${requested} - it may be missing, in use, or blocked by the OS.`,
                );
              }
            }
            return;
          }

          case 'capability:state': {
            // Authoritative snapshot from the agent - this is how a local
            // stop (someone at the remote machine typing 'c'/'m') reaches
            // the controller's UI, since that path never goes through
            // capability:response at all.
            setCameraState((current) => (message.camera ? 'active' : current === 'active' ? 'idle' : current));
            setMicrophoneState((current) => (message.microphone ? 'active' : current === 'active' ? 'idle' : current));
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

  // Applied imperatively rather than via <video> props: mute/volume are DOM
  // element properties, not attributes React can bind directly for a stream
  // that keeps playing across re-renders.
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = muted;
      videoRef.current.volume = volume;
    }
  }, [muted, volume]);

  useEffect(() => {
    if (!clipboardToast) return;
    const timer = setTimeout(() => setClipboardToast(null), 5000);
    return () => clearTimeout(timer);
  }, [clipboardToast]);

  const sendInput = useCallback((input: InputMessage) => {
    const channel = channelForInput(input.type) === INPUT_CHANNEL_MOTION ? motionChannelRef.current : reliableChannelRef.current;
    if (channel && channel.readyState === 'open') {
      channel.send(JSON.stringify(input));
      if (input.type === 'clipboard:text' && input.direction === 'to-remote') {
        reportActivity(sessionId, 'usedClipboard');
      }
    }
  }, [sessionId]);

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

  // The native paste event gives clipboard text synchronously, without the
  // async Clipboard API's permission prompt - the natural path for Ctrl+V.
  function onPaste(e: React.ClipboardEvent<HTMLDivElement>) {
    if (!hasCapability('clipboard')) return;
    const text = e.clipboardData.getData('text');
    if (text) sendInput({ type: 'clipboard:text', direction: 'to-remote', text });
  }

  // Explicit button as a fallback for browsers/contexts where a bare paste
  // event on a non-input element doesn't fire clipboard data.
  async function handleSendClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) sendInput({ type: 'clipboard:text', direction: 'to-remote', text });
    } catch {
      setError('Could not read the clipboard. Try pasting directly (Ctrl+V) instead.');
    }
  }

  async function handleCopyReceivedClipboard() {
    if (!clipboardFromRemoteRef.current) return;
    try {
      await navigator.clipboard.writeText(clipboardFromRemoteRef.current);
      setClipboardToast(null);
    } catch {
      /* the toast stays visible so the user can retry */
    }
  }

  function requestCapability(capability: 'camera' | 'microphone') {
    const setState = capability === 'camera' ? setCameraState : setMicrophoneState;
    const requestId = crypto.randomUUID();
    pendingCapabilityRequestsRef.current.set(requestId, capability);
    setState('requesting');
    sendSignal({ type: 'capability:request', capability, requestId });
  }

  function stopCapability(capability: 'camera' | 'microphone') {
    sendSignal({ type: 'capability:revoke', capability });
    (capability === 'camera' ? setCameraState : setMicrophoneState)('idle');
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
          {hasCapability('clipboard') && isInteractive && (
            <button type="button" className="btn-secondary" onClick={() => void handleSendClipboard()} title="Send clipboard to remote">
              {'\u{1F4CB} Send clipboard'}
            </button>
          )}
          {hasCapability('camera') && isInteractive && (
            <CapabilityButton
              label="Camera"
              icon={'\u{1F4F7}'}
              state={cameraState}
              onRequest={() => requestCapability('camera')}
              onStop={() => stopCapability('camera')}
            />
          )}
          {hasCapability('microphone') && isInteractive && (
            <CapabilityButton
              label="Microphone"
              icon={'\u{1F3A4}'}
              state={microphoneState}
              onRequest={() => requestCapability('microphone')}
              onStop={() => stopCapability('microphone')}
            />
          )}
          {hasCapability('audio') && (
            <div className="flex items-center gap-1 rounded-lg bg-slate-800 px-2 py-1">
              <button type="button" className="text-sm" onClick={() => setMuted((m) => !m)} title={muted ? 'Unmute' : 'Mute'}>
                {muted ? '\u{1F507}' : '\u{1F50A}'}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
                className="w-16"
                aria-label="Remote audio volume"
              />
            </div>
          )}
          {(hasCapability('fileUpload') || hasCapability('fileDownload')) && (
            <button type="button" className="btn-secondary" onClick={() => setShowFiles((v) => !v)}>
              {'\u{1F4C1} Files'}
            </button>
          )}
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

      {clipboardToast && (
        <button
          type="button"
          onClick={() => void handleCopyReceivedClipboard()}
          className="absolute right-4 top-14 z-10 rounded-lg bg-slate-800 px-3 py-2 text-xs text-slate-100 shadow-lg hover:bg-slate-700"
        >
          {clipboardToast}
        </button>
      )}

      <div
        ref={containerRef}
        className="relative flex flex-1 items-center justify-center overflow-hidden bg-black outline-none"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onPaste={onPaste}
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

        {showFiles && (
          <FileManagerPanel
            channel={fileChannel}
            canUpload={hasCapability('fileUpload')}
            canDownload={hasCapability('fileDownload')}
            canDelete={hasCapability('fileDelete')}
            onClose={() => setShowFiles(false)}
            onTransferStarted={() => reportActivity(sessionId, 'usedFiles')}
          />
        )}

        {/* Camera and/or microphone from the remote machine. Never hidden:
            this element and its red indicator are visible any time either
            capability is active, matching the "always-on indicator, no
            covert access" requirement - there is no mode where either
            stream plays without this being on screen. */}
        <div className={cameraState === 'active' || microphoneState === 'active' ? 'absolute bottom-4 left-4 w-56' : 'hidden'}>
          <div className="overflow-hidden rounded-lg border-2 border-red-500 bg-black shadow-lg">
            <video ref={cameraPreviewRef} autoPlay playsInline className="aspect-video w-full" />
          </div>
          <div className="mt-1 flex flex-wrap gap-2 text-xs font-medium text-red-400">
            {cameraState === 'active' && <span>{'\u{1F534} Camera Active'}</span>}
            {microphoneState === 'active' && <span>{'\u{1F534} Microphone Active'}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function CapabilityButton({
  label,
  icon,
  state,
  onRequest,
  onStop,
}: {
  label: string;
  icon: string;
  state: CapabilityUiState;
  onRequest: () => void;
  onStop: () => void;
}) {
  if (state === 'active') {
    return (
      <button type="button" className="btn-secondary !bg-red-950 !text-red-300" onClick={onStop}>
        {icon} Stop {label}
      </button>
    );
  }
  if (state === 'requesting') {
    return (
      <button type="button" className="btn-secondary" disabled>
        Waiting for approval...
      </button>
    );
  }
  return (
    <button type="button" className="btn-secondary" onClick={onRequest} title={`Request ${label.toLowerCase()} access`}>
      {icon} {state === 'denied' ? `${label} declined - retry` : `Request ${label}`}
    </button>
  );
}
