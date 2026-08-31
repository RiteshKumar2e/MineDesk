import { checkRelativePath, isInsideRoot, resolveWithinRoot, sanitizeFileName } from '../src/vendor/shared/index.js';
import { describe, expect, it } from 'vitest';

describe('file-transfer path validation', () => {
  it('accepts ordinary relative paths', () => {
    expect(checkRelativePath('reports/2026/summary.pdf').ok).toBe(true);
    expect(checkRelativePath('photo.jpg').ok).toBe(true);
  });

  it('rejects parent-directory traversal in any position', () => {
    for (const input of ['../secret.txt', 'a/../../b', 'a/b/../../../c', '..\\secret.txt', '%2e%2e/secret']) {
      const result = checkRelativePath(input);
      expect(result.ok, `expected ${input} to be rejected`).toBe(false);
      expect(result.reason).toBe('traversal');
    }
  });

  it('rejects absolute Windows and POSIX paths', () => {
    expect(checkRelativePath('C:\\Windows\\System32').ok).toBe(false);
    expect(checkRelativePath('C:/Windows/System32').ok).toBe(false);
    expect(checkRelativePath('/etc/shadow').ok).toBe(false);
  });

  it('rejects UNC paths', () => {
    expect(checkRelativePath('\\\\server\\share\\file').ok).toBe(false);
    expect(checkRelativePath('//server/share/file').ok).toBe(false);
  });

  it('rejects null bytes, raw and percent-encoded', () => {
    expect(checkRelativePath('file\u0000.txt').ok).toBe(false);
    expect(checkRelativePath('file%00.txt').ok).toBe(false);
  });

  it('rejects Windows reserved device names in any extension', () => {
    for (const input of ['CON', 'con.txt', 'NUL', 'nul.log', 'COM1', 'lpt9.dat']) {
      expect(checkRelativePath(input).ok, `expected ${input} to be rejected`).toBe(false);
    }
  });

  it('rejects trailing dots and spaces (Win32 strips them, changing identity)', () => {
    expect(checkRelativePath('secret.txt.').ok).toBe(false);
    expect(checkRelativePath('secret.txt ').ok).toBe(false);
  });

  it('containment check requires a path separator, not a string prefix', () => {
    expect(isInsideRoot('/srv/shared', '/srv/shared/file.txt')).toBe(true);
    expect(isInsideRoot('/srv/shared', '/srv/shared-secrets/file.txt')).toBe(false);
    expect(isInsideRoot('/srv/shared', '/srv/shared')).toBe(true);
  });

  it('resolveWithinRoot rejects anything that would escape the root', () => {
    expect(resolveWithinRoot('/srv/shared', 'ok/file.txt')).toBe('/srv/shared/ok/file.txt');
    expect(resolveWithinRoot('/srv/shared', '../escape.txt')).toBeNull();
    expect(resolveWithinRoot('/srv/shared', '/etc/passwd')).toBeNull();
  });

  it('sanitizeFileName strips directory components from an upload name', () => {
    // Traversal segments are discarded along with the rest of the path, leaving
    // a harmless bare filename rather than escaping the shared folder.
    expect(sanitizeFileName('../../evil.exe')).toBe('evil.exe');
    expect(sanitizeFileName('report.pdf')).toBe('report.pdf');
    expect(sanitizeFileName('folder/nested.txt')).toBe('nested.txt');
  });

  it('sanitizeFileName still rejects a bare name that is itself invalid', () => {
    expect(sanitizeFileName('CON')).toBeNull();
    expect(sanitizeFileName('secret.txt.')).toBeNull();
  });
});
