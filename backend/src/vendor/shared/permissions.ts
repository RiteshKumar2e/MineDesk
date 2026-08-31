import { ALL_CAPABILITIES, type Capability, type PermissionSet } from '../types/index.js';

/**
 * Default permission mask for a newly enrolled device.
 *
 * The defaults are deliberately conservative: viewing and controlling the
 * desktop is on, but anything that reaches a person (camera, microphone) or
 * destroys data (file delete) starts off. The owner turns those on explicitly.
 */
export const DEFAULT_PERMISSIONS: PermissionSet = {
  screen: true,
  mouse: true,
  keyboard: true,
  clipboard: true,
  fileUpload: false,
  fileDownload: false,
  fileDelete: false,
  audio: false,
  camera: false,
  microphone: false,
};

/** Capabilities that additionally require a live prompt at the remote machine. */
export const PROMPTED_CAPABILITIES: readonly Capability[] = ['camera', 'microphone'] as const;

/** Capabilities that light a privacy indicator on both ends while active. */
export const INDICATOR_CAPABILITIES: readonly Capability[] = ['camera', 'microphone'] as const;

export const CAPABILITY_GROUPS: { label: string; capabilities: Capability[] }[] = [
  { label: 'Remote desktop', capabilities: ['screen', 'mouse', 'keyboard'] },
  { label: 'Files', capabilities: ['fileUpload', 'fileDownload', 'fileDelete'] },
  { label: 'Communication', capabilities: ['audio', 'camera', 'microphone'] },
  { label: 'Clipboard', capabilities: ['clipboard'] },
];

export const CAPABILITY_LABELS: Record<Capability, string> = {
  screen: 'Screen',
  mouse: 'Mouse',
  keyboard: 'Keyboard',
  clipboard: 'Clipboard',
  fileUpload: 'Upload',
  fileDownload: 'Download',
  fileDelete: 'Delete',
  audio: 'Audio',
  camera: 'Camera',
  microphone: 'Microphone',
};

export const CAPABILITY_DESCRIPTIONS: Record<Capability, string> = {
  screen: 'See what is on the display.',
  mouse: 'Move the pointer and click.',
  keyboard: 'Type and send keyboard shortcuts.',
  clipboard: 'Synchronize copied text between the two computers.',
  fileUpload: 'Send files to this computer.',
  fileDownload: 'Copy files from the shared folders on this computer.',
  fileDelete: 'Delete files inside the shared folders.',
  audio: 'Hear the sound this computer plays.',
  camera: 'Use the camera. The person at this computer is asked every session.',
  microphone: 'Use the microphone. The person at this computer is asked every session.',
};

/** Narrow an arbitrary object into a valid, complete permission set. */
export function normalizePermissions(input: Partial<Record<string, unknown>>): PermissionSet {
  const out = { ...DEFAULT_PERMISSIONS };
  for (const cap of ALL_CAPABILITIES) {
    const value = input[cap];
    if (typeof value === 'boolean') out[cap] = value;
  }
  return out;
}

/** Capabilities that are enabled, as a flat list (what the invite carries). */
export function grantedCapabilities(permissions: PermissionSet): Capability[] {
  return ALL_CAPABILITIES.filter((cap) => permissions[cap]);
}

/**
 * Single source of truth for "may this session use this capability?".
 * Called by the API before authorizing, and again by the agent before acting -
 * a compromised server alone cannot turn on a capability the owner disabled.
 */
export function isCapabilityAllowed(permissions: PermissionSet, capability: Capability): boolean {
  return permissions[capability] === true;
}

/** Enabling a file capability implies the device must also share the screen. */
export function validatePermissionSet(permissions: PermissionSet): string[] {
  const problems: string[] = [];
  if (permissions.fileDelete && !permissions.fileDownload) {
    problems.push('Delete requires Download so files can be reviewed before removal.');
  }
  if ((permissions.mouse || permissions.keyboard) && !permissions.screen) {
    problems.push('Mouse and keyboard control require the screen to be shared.');
  }
  return problems;
}
