import type { PermissionSet, PublicDevice } from '@minedesk/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './apiClient';

export const deviceKeys = {
  all: ['devices'] as const,
  detail: (id: string) => ['devices', id] as const,
};

export function useDevices() {
  return useQuery({
    queryKey: deviceKeys.all,
    queryFn: () => api.get<{ devices: PublicDevice[] }>('/api/v1/devices'),
    // Presence can change on its own (agent connects/disconnects), so the
    // list quietly re-checks rather than requiring a manual refresh.
    refetchInterval: 15_000,
  });
}

export function useDevice(id: string | undefined) {
  return useQuery({
    queryKey: deviceKeys.detail(id ?? ''),
    queryFn: () =>
      api.get<{ device: PublicDevice; sharedFolders: string[] }>(`/api/v1/devices/${id}`),
    enabled: Boolean(id),
    refetchInterval: 15_000,
  });
}

export function useCreateDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.post<{ device: PublicDevice; enrollment: { code: string; expiresAt: string; command: string } }>(
        '/api/v1/devices',
        { name },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: deviceKeys.all }),
  });
}

export function useRenameDevice(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.patch<{ device: PublicDevice }>(`/api/v1/devices/${id}`, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: deviceKeys.all });
      queryClient.invalidateQueries({ queryKey: deviceKeys.detail(id) });
    },
  });
}

export function useDeleteDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/devices/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: deviceKeys.all }),
  });
}

export function useUpdatePermissions(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (permissions: Partial<PermissionSet> & { sharedFolders?: string[] }) =>
      api.put<{ device: PublicDevice; warnings: string[] }>(`/api/v1/devices/${id}/permissions`, permissions),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: deviceKeys.all });
      queryClient.invalidateQueries({ queryKey: deviceKeys.detail(id) });
    },
  });
}

export function useSetUnattendedAccess(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { enabled: boolean; password?: string }) =>
      api.put<{ device: PublicDevice }>(`/api/v1/devices/${id}/unattended`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: deviceKeys.all });
      queryClient.invalidateQueries({ queryKey: deviceKeys.detail(id) });
    },
  });
}

export function useSetIncomingRequests(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { enabled: boolean }) =>
      api.put<{ device: PublicDevice }>(`/api/v1/devices/${id}/incoming-requests`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: deviceKeys.all });
      queryClient.invalidateQueries({ queryKey: deviceKeys.detail(id) });
    },
  });
}

export function useRevokeDevice(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ device: PublicDevice }>(`/api/v1/devices/${id}/revoke`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: deviceKeys.all });
      queryClient.invalidateQueries({ queryKey: deviceKeys.detail(id) });
    },
  });
}

export function useIssueEnrollmentCode(id: string) {
  return useMutation({
    mutationFn: () =>
      api.post<{ code: string; expiresAt: string; command: string }>(`/api/v1/devices/${id}/enrollment-code`),
  });
}

export interface DeviceSessionRow {
  id: string;
  sessionId: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  userEmail: string;
  userName: string;
  unattended: boolean;
  connectionType: string | null;
  endReason: string | null;
  capabilities: string[];
  usedCamera: boolean;
  usedMicrophone: boolean;
  usedAudio: boolean;
  usedClipboard: boolean;
  usedFiles: boolean;
}

export function useDeviceSessions(id: string | undefined) {
  return useQuery({
    queryKey: ['devices', id, 'sessions'] as const,
    queryFn: () => api.get<{ sessions: DeviceSessionRow[] }>(`/api/v1/devices/${id}/sessions`),
    enabled: Boolean(id),
  });
}

export interface RecentConnection {
  id: string;
  email: string;
  name: string;
  sessionCount: number;
  lastConnectedAt: string | null;
}

export function useDeviceAccess(id: string | undefined) {
  return useQuery({
    queryKey: ['devices', id, 'access'] as const,
    queryFn: () =>
      api.get<{
        authorizedUsers: { id: string; email: string; name: string; role: string; addedAt: string }[];
        unattendedAccessEnabled: boolean;
        recentConnections: RecentConnection[];
      }>(`/api/v1/devices/${id}/access`),
    enabled: Boolean(id),
  });
}
