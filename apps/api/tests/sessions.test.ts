import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { markDeviceOffline, markDeviceOnline } from '../src/lib/presence.js';
import { hub } from '../src/modules/signaling/hub.js';
import { closeAll, resetDatabase, STRONG_PASSWORD, uniqueEmail, withApp } from './helpers.js';

async function registerAndLogin(app: FastifyInstance) {
  const email = uniqueEmail();
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, name: 'Owner', password: STRONG_PASSWORD },
  });
  return { email, accessToken: res.json().accessToken as string };
}

async function createDevice(app: FastifyInstance, accessToken: string, name = 'Office PC') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/devices',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name },
  });
  return res.json().device as { id: string; deviceId: string };
}

describe('session creation', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await withApp();
  });
  afterEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closeAll(app);
  });

  it('refuses to connect to an offline device', async () => {
    const { accessToken } = await registerAndLogin(app);
    const device = await createDevice(app, accessToken);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { deviceId: device.deviceId },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DEVICE_OFFLINE');
  });

  it('refuses to connect to another user’s device (IDOR check)', async () => {
    const ownerA = await registerAndLogin(app);
    const ownerB = await registerAndLogin(app);
    const device = await createDevice(app, ownerA.accessToken);

    await markDeviceOnline({
      deviceId: device.deviceId,
      connectionId: 'test-connection',
      nodeId: hub.nodeId,
      agentVersion: null,
      ip: '127.0.0.1',
      since: Date.now(),
    });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: { authorization: `Bearer ${ownerB.accessToken}` },
        payload: { deviceId: device.deviceId },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('DEVICE_NOT_FOUND');
    } finally {
      await markDeviceOffline(device.deviceId);
    }
  });

  it('creates a pending session with a snapshot of the current permission mask', async () => {
    const { accessToken } = await registerAndLogin(app);
    const device = await createDevice(app, accessToken);

    await app.inject({
      method: 'PUT',
      url: `/api/v1/devices/${device.id}/permissions`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { clipboard: false },
    });

    await markDeviceOnline({
      deviceId: device.deviceId,
      connectionId: 'test-connection',
      nodeId: hub.nodeId,
      agentVersion: null,
      ip: '127.0.0.1',
      since: Date.now(),
    });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { deviceId: device.deviceId },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.sessionId).toMatch(/^SES-\d{4}-[0-9A-F]{7}$/);
      expect(body.status).toBe('pending');
      expect(body.capabilities).toContain('screen');
      expect(body.capabilities).not.toContain('clipboard');
    } finally {
      await markDeviceOffline(device.deviceId);
    }
  });

  it('refuses a second connection while one is already pending', async () => {
    const { accessToken } = await registerAndLogin(app);
    const device = await createDevice(app, accessToken);

    await markDeviceOnline({
      deviceId: device.deviceId,
      connectionId: 'test-connection',
      nodeId: hub.nodeId,
      agentVersion: null,
      ip: '127.0.0.1',
      since: Date.now(),
    });

    try {
      const first = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { deviceId: device.deviceId },
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { deviceId: device.deviceId },
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe('DEVICE_BUSY');
    } finally {
      await markDeviceOffline(device.deviceId);
    }
  });

  it('refuses to connect to a device with no capabilities enabled', async () => {
    const { accessToken } = await registerAndLogin(app);
    const device = await createDevice(app, accessToken);

    await app.inject({
      method: 'PUT',
      url: `/api/v1/devices/${device.id}/permissions`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { screen: false, mouse: false, keyboard: false, clipboard: false },
    });

    await markDeviceOnline({
      deviceId: device.deviceId,
      connectionId: 'test-connection',
      nodeId: hub.nodeId,
      agentVersion: null,
      ip: '127.0.0.1',
      since: Date.now(),
    });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { deviceId: device.deviceId },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('PERMISSION_DENIED');
    } finally {
      await markDeviceOffline(device.deviceId);
    }
  });
});
