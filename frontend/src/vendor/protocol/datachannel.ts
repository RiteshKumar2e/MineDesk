import { z } from 'zod';

/**
 * Input-event protocol carried over the WebRTC DataChannel, not the signaling
 * WebSocket.
 *
 * Design choices that matter for correctness:
 *   - Coordinates are normalized to [0, 1] over the source display, not pixels.
 *     The controller's video element and the remote display are almost never
 *     the same resolution, so sending fractions lets the agent scale to
 *     whatever display it is actually driving (and to the right one, once
 *     multi-monitor selection lands) without either side needing to know the
 *     other's screen size in advance.
 *   - The channel is created unreliable/unordered for motion events (an old,
 *     stale mouse-move is worse than a dropped one) but reliable/ordered for
 *     key and click events (dropping a keyup is how you get a stuck Ctrl).
 *     Two channel labels are defined below so the agent and browser agree on
 *     which is which without inspecting payloads.
 */
export const INPUT_CHANNEL_RELIABLE = 'md-input-reliable';
export const INPUT_CHANNEL_MOTION = 'md-input-motion';

const unitCoordinate = z.number().min(0).max(1);

export const MouseMoveEvent = z.object({
  type: z.literal('mouse:move'),
  x: unitCoordinate,
  y: unitCoordinate,
});

export const MouseButtonEvent = z.object({
  type: z.enum(['mouse:down', 'mouse:up']),
  x: unitCoordinate,
  y: unitCoordinate,
  button: z.enum(['left', 'right', 'middle']),
});

export const MouseDoubleClickEvent = z.object({
  type: z.literal('mouse:dblclick'),
  x: unitCoordinate,
  y: unitCoordinate,
  button: z.enum(['left', 'right', 'middle']),
});

export const MouseWheelEvent = z.object({
  type: z.literal('mouse:wheel'),
  x: unitCoordinate,
  y: unitCoordinate,
  /** Scroll delta in CSS pixels, matching WheelEvent.deltaY/deltaX. */
  deltaX: z.number(),
  deltaY: z.number(),
});

/**
 * Keys are identified by `KeyboardEvent.code` (a layout-independent physical
 * key, e.g. "KeyA", "ControlLeft") rather than `.key`, so a shortcut typed on
 * a French AZERTY keyboard still lands on the physical key the layout maps to
 * on the remote machine, not a character that key doesn't produce there.
 */
export const KeyEvent = z.object({
  type: z.enum(['key:down', 'key:up']),
  code: z.string().min(1).max(32),
});

/**
 * A named combination the browser cannot always synthesize as ordinary
 * key events (Ctrl+Alt+Del is intercepted by the OS before any browser sees
 * it). The agent maps this to whatever privileged mechanism the platform
 * requires (on Windows, SendSAS via the Secure Attention Sequence API) and
 * refuses silently if it isn't available - this must never fall back to
 * synthesizing three separate key events, which would not work and would be
 * indistinguishable in the log from an attempted privilege escalation.
 */
export const ShortcutEvent = z.object({
  type: z.literal('shortcut'),
  name: z.literal('ctrl-alt-del'),
});

export const ClipboardEvent = z.object({
  type: z.literal('clipboard:text'),
  /** Which side the text is moving to; the sender already has it. */
  direction: z.enum(['to-remote', 'to-controller']),
  text: z.string().max(1_000_000),
});

/**
 * Session chat - unlike mouse/keyboard, this carries no OS-level privilege,
 * so it is safe to allow even on a view-only browser-to-browser session
 * (Phase 21's "browser-to-browser is view-only" rule is about input
 * injection, not messaging). `from` is set by the receiver from its own
 * knowledge of who's on the other end, not trusted from the payload.
 */
export const ChatMessageEvent = z.object({
  type: z.literal('chat:message'),
  text: z.string().min(1).max(4000),
  sentAt: z.number(),
});

/** Requests the agent switch its captured display mid-session - `index`
 * matches one of the entries in the `screens` list from `session:accept`
 * (see vendor/protocol/signaling.ts). No permission gate beyond `screen`
 * itself: picking which of your own monitors to show isn't a bigger grant
 * than the screen capability already is. */
export const SelectMonitorEvent = z.object({
  type: z.literal('monitor:select'),
  index: z.number().int().min(0),
});

export const InputMessage = z.discriminatedUnion('type', [
  MouseMoveEvent,
  MouseButtonEvent,
  MouseDoubleClickEvent,
  MouseWheelEvent,
  KeyEvent,
  ShortcutEvent,
  ClipboardEvent,
  ChatMessageEvent,
  SelectMonitorEvent,
]);

export type InputMessage = z.infer<typeof InputMessage>;

export function parseInputMessage(raw: string): InputMessage | null {
  try {
    const parsed = InputMessage.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Which channel a given event type belongs on - see the module doc above. */
export function channelForInput(type: InputMessage['type']): typeof INPUT_CHANNEL_RELIABLE | typeof INPUT_CHANNEL_MOTION {
  return type === 'mouse:move' ? INPUT_CHANNEL_MOTION : INPUT_CHANNEL_RELIABLE;
}
