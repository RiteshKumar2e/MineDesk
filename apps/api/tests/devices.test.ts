import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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

describe('devices', () => {
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

  it('creates a device with a device id and a one-time enrollment code', async () => {
    const { accessToken } = await registerAndLogin(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: 'Office PC' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.device.deviceId).toMatch(/^RMT-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(body.device.status).toBe('offline');
    expect(body.enrollment.code).toMatch(/^ENR-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    // Conservative defaults: view/control on, everything invasive off.
    expect(body.device.permissions).toMatchObject({
      screen: true,
      mouse: true,
      keyboard: true,
      camera: false,
      microphone: false,
      fileDelete: false,
    });
  });

  it('rejects an empty device name', async () => {
    const { accessToken } = await registerAndLogin(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lists only the caller’s own devices', async () => {
    const ownerA = await registerAndLogin(app);
    const ownerB = await registerAndLogin(app);

    await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: { authorization: `Bearer ${ownerA.accessToken}` },
      payload: { name: 'A-PC' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: { name: 'B-PC' },
    });

    const listA = await app.inject({
      method: 'GET',
      url: '/api/v1/devices',
      headers: { authorization: `Bearer ${ownerA.accessToken}` },
    });
    const names = listA.json().devices.map((d: { name: string }) => d.name);
    expect(names).toEqual(['A-PC']);
  });

  it('returns DEVICE_NOT_FOUND rather than another user’s device (IDOR check)', async () => {
    const ownerA = await registerAndLogin(app);
    const ownerB = await registerAndLogin(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: { authorization: `Bearer ${ownerA.accessToken}` },
      payload: { name: 'A-PC' },
    });
    const deviceRowId = created.json().device.id;

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/devices/${deviceRowId}`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('DEVICE_NOT_FOUND');
  });

  it('enrolls an agent with a valid one-time code exactly once', async () => {
    const { accessToken } = await registerAndLogin(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: 'Office PC' },
    });
    const { code } = created.json().enrollment;

    const enroll = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/enroll',
      payload: { code, hostname: 'OFFICE-PC', os: 'windows', osVersion: '11', agentVersion: '0.1.0' },
    });
    expect(enroll.statusCode).toBe(201);
    expect(typeof enroll.json().agentSecret).toBe('string');

    const reuse = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/enroll',
      payload: { code, hostname: 'OFFICE-PC', os: 'windows' },
    });
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json().error.code).toBe('ENROLLMENT_CODE_INVALID');
  });

  it('rejects an unknown enrollment code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/enroll',
      payload: { code: 'ENR-0000-0000', hostname: 'X', os: 'windows' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('ENROLLMENT_CODE_INVALID');
  });

  it('authenticates an enrolled agent and issues a device-scoped token', async () => {
    const { accessToken } = await registerAndLogin(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: 'Office PC' },
    });
    const { code } = created.json().enrollment;
    const deviceId = created.json().device.deviceId;

    const enroll = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/enroll',
      payload: { code, hostname: 'OFFICE-PC', os: 'windows' },
    });
    const { agentSecret } = enroll.json();

    const auth = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/auth',
      payload: { deviceId, secret: agentSecret },
    });
    expect(auth.statusCode).toBe(200);
    expect(typeof auth.json().token).toBe('string');

    const wrongSecret = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/auth',
      payload: { deviceId, secret: 'totally-wrong-secret-value-xx' },
    });
    expect(wrongSecret.statusCode).toBe(401);
  });

  it('updates permissions and enforces the file-delete-requires-download rule as a warning', async () => {
    const { accessToken } = await registerAndLogin(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: 'Office PC' },
    });
    const deviceRowId = created.json().device.id;

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/devices/${deviceRowId}/permissions`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { camera: true, fileDelete: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().device.permissions.camera).toBe(true);
    expect(res.json().device.permissions.fileDelete).toBe(true);
    expect(res.json().warnings.length).toBeGreaterThan(0);
  });

  it('requires a password to enable unattended access', async () => {
    const { accessToken } = await registerAndLogin(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: 'Office PC' },
    });
    const deviceRowId = created.json().device.id;

    const missingPassword = await app.inject({
      method: 'PUT',
      url: `/api/v1/devices/${deviceRowId}/unattended`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { enabled: true },
    });
    expect(missingPassword.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'PUT',
      url: `/api/v1/devices/${deviceRowId}/unattended`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { enabled: true, password: 'a-strong-unattended-password' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().device.unattendedAccessEnabled).toBe(true);
    expect(ok.json().device.hasUnattendedPassword).toBe(true);
  });

  it('revoking a device immediately invalidates its agent token', async () => {
    const { accessToken } = await registerAndLogin(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: 'Office PC' },
    });
    const deviceRowId = created.json().device.id;
    const deviceId = created.json().device.deviceId;
    const { code } = created.json().enrollment;

    const enroll = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/enroll',
      payload: { code, hostname: 'OFFICE-PC', os: 'windows' },
    });
    const { agentSecret } = enroll.json();

    const auth = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/auth',
      payload: { deviceId, secret: agentSecret },
    });
    const agentToken = auth.json().token;

    await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${deviceRowId}/revoke`,
      headers: { authorization: `Bearer ${accessToken}` },
    });

    const afterRevoke = await app.inject({
      method: 'GET',
      url: '/api/v1/agent/config',
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(afterRevoke.statusCode).toBe(401);
  });
});
