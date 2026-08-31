import type { IceServerConfig } from '../vendor/types/index.js';
import { env } from '../config/env.js';
import { createTurnCredentials } from './crypto.js';

/**
 * ICE configuration handed to a peer when a session is authorized.
 *
 * STUN alone resolves the majority of connections directly, peer to peer. TURN
 * is the fallback for symmetric NAT and restrictive corporate firewalls, where
 * media must be relayed. Credentials are ephemeral and scoped to one session
 * identifier, so a leaked config cannot be used to relay unrelated traffic.
 */
export function buildIceServers(sessionIdentifier: string): IceServerConfig[] {
  const servers: IceServerConfig[] = [];

  if (env.STUN_SERVER) {
    servers.push({ urls: env.STUN_SERVER.split(',').map((s) => s.trim()).filter(Boolean) });
  }

  if (env.TURN_SERVER) {
    const urls = env.TURN_SERVER.split(',').map((s) => s.trim()).filter(Boolean);
    const ephemeral = createTurnCredentials(sessionIdentifier);

    if (ephemeral) {
      servers.push({ urls, username: ephemeral.username, credential: ephemeral.credential });
    } else if (env.TURN_USERNAME && env.TURN_PASSWORD) {
      // Static credentials: acceptable for local development only. Production
      // deployments should set TURN_STATIC_SECRET so credentials expire.
      servers.push({ urls, username: env.TURN_USERNAME, credential: env.TURN_PASSWORD });
    }
  }

  return servers;
}

/** How long the returned ICE credentials remain usable. */
export const iceCredentialTtlSeconds = env.TURN_CREDENTIAL_TTL;
