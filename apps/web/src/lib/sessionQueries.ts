import type { IceServerConfig } from '@minedesk/types';
import { useMutation } from '@tanstack/react-query';
import { api } from './apiClient';

export interface CreateSessionResult {
  sessionId: string;
  status: string;
  unattended: boolean;
  capabilities: string[];
  iceServers: IceServerConfig[];
  deviceOnline: boolean;
}

export interface CreateSessionInput {
  deviceId: string;
  /** Only required when connecting to a device this account does not own. */
  unattendedPassword?: string;
}

export function useCreateSession() {
  return useMutation({
    mutationFn: (input: CreateSessionInput | string) =>
      api.post<CreateSessionResult>(
        '/api/v1/sessions',
        typeof input === 'string' ? { deviceId: input } : input,
      ),
  });
}
