-- MineDesk schema - hand-written, no ORM/migration engine involved.
--
-- This is the exact table structure Prisma had already created (dumped
-- straight from sqlite_master on the working local database), kept as plain
-- SQL now that the app talks to SQLite/Turso directly via @libsql/client.
-- Apply it to a fresh database with:
--   turso db shell <db-name> < backend/db/schema.sql          (remote)
--   sqlite3 backend/db/dev.db < backend/db/schema.sql          (local file)
--
-- Booleans are stored as INTEGER 0/1 and dates as ISO 8601 TEXT - SQLite has
-- no native types for either; see lib/db.ts's row mappers for where the
-- 0/1-to-boolean and TEXT-to-Date conversion actually happens on read.

CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorSecret" TEXT,
    "twoFactorBackupCodes" TEXT NOT NULL DEFAULT '[]',
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE INDEX "users_email_idx" ON "users"("email");

CREATE TABLE "auth_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "previousTokenHash" TEXT,
    "replacedAt" DATETIME,
    "rotationCounter" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" DATETIME,
    "revokedReason" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "auth_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "auth_sessions_tokenHash_key" ON "auth_sessions"("tokenHash");
CREATE INDEX "auth_sessions_userId_revokedAt_idx" ON "auth_sessions"("userId", "revokedAt");
CREATE INDEX "auth_sessions_expiresAt_idx" ON "auth_sessions"("expiresAt");
CREATE INDEX "auth_sessions_previousTokenHash_idx" ON "auth_sessions"("previousTokenHash");

CREATE TABLE "verification_tokens" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "verification_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "verification_tokens_tokenHash_key" ON "verification_tokens"("tokenHash");
CREATE INDEX "verification_tokens_userId_type_idx" ON "verification_tokens"("userId", "type");
CREATE INDEX "verification_tokens_expiresAt_idx" ON "verification_tokens"("expiresAt");

CREATE TABLE "devices" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "os" TEXT NOT NULL DEFAULT 'unknown',
    "osVersion" TEXT,
    "agentVersion" TEXT,
    "hostname" TEXT,
    "status" TEXT NOT NULL DEFAULT 'offline',
    "lastSeenAt" DATETIME,
    "agentSecretHash" TEXT,
    "enrolledAt" DATETIME,
    "unattendedAccessEnabled" BOOLEAN NOT NULL DEFAULT false,
    "unattendedPasswordHash" TEXT,
    "allowIncomingRequests" BOOLEAN NOT NULL DEFAULT true,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "devices_deviceId_key" ON "devices"("deviceId");
CREATE INDEX "devices_userId_status_idx" ON "devices"("userId", "status");
CREATE INDEX "devices_lastSeenAt_idx" ON "devices"("lastSeenAt");

CREATE TABLE "device_permissions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "screen" BOOLEAN NOT NULL DEFAULT true,
    "mouse" BOOLEAN NOT NULL DEFAULT true,
    "keyboard" BOOLEAN NOT NULL DEFAULT true,
    "clipboard" BOOLEAN NOT NULL DEFAULT true,
    "fileUpload" BOOLEAN NOT NULL DEFAULT false,
    "fileDownload" BOOLEAN NOT NULL DEFAULT false,
    "fileDelete" BOOLEAN NOT NULL DEFAULT false,
    "audio" BOOLEAN NOT NULL DEFAULT false,
    "camera" BOOLEAN NOT NULL DEFAULT false,
    "microphone" BOOLEAN NOT NULL DEFAULT false,
    "sharedFolders" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "device_permissions_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "device_permissions_deviceId_key" ON "device_permissions"("deviceId");

CREATE TABLE "enrollment_codes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "usedIp" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "enrollment_codes_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "enrollment_codes_code_key" ON "enrollment_codes"("code");
CREATE INDEX "enrollment_codes_expiresAt_idx" ON "enrollment_codes"("expiresAt");

CREATE TABLE "remote_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "grantedCapabilities" TEXT NOT NULL DEFAULT '[]',
    "unattended" BOOLEAN NOT NULL DEFAULT false,
    "usedCamera" BOOLEAN NOT NULL DEFAULT false,
    "usedMicrophone" BOOLEAN NOT NULL DEFAULT false,
    "usedAudio" BOOLEAN NOT NULL DEFAULT false,
    "usedClipboard" BOOLEAN NOT NULL DEFAULT false,
    "usedFiles" BOOLEAN NOT NULL DEFAULT false,
    "controllerIp" TEXT,
    "agentIp" TEXT,
    "connectionType" TEXT,
    "endReason" TEXT,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "endedAt" DATETIME,
    CONSTRAINT "remote_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "remote_sessions_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "remote_sessions_sessionId_key" ON "remote_sessions"("sessionId");
CREATE INDEX "remote_sessions_userId_requestedAt_idx" ON "remote_sessions"("userId", "requestedAt");
CREATE INDEX "remote_sessions_deviceId_requestedAt_idx" ON "remote_sessions"("deviceId", "requestedAt");
CREATE INDEX "remote_sessions_status_idx" ON "remote_sessions"("status");

CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "deviceId" TEXT,
    "sessionId" TEXT,
    "action" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "audit_logs_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "audit_logs_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "remote_sessions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "audit_logs_userId_createdAt_idx" ON "audit_logs"("userId", "createdAt");
CREATE INDEX "audit_logs_deviceId_createdAt_idx" ON "audit_logs"("deviceId", "createdAt");
CREATE INDEX "audit_logs_sessionId_idx" ON "audit_logs"("sessionId");
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");
