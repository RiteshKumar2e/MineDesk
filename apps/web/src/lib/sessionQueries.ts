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

export function useCreateSession() {
  return useMutation({
    mutationFn: (deviceId: string) => api.post<CreateSessionResult>('/api/v1/sessions', { deviceId }),
  });
}
