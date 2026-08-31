// Vendored copy for standalone deploy (no monorepo/workspace deps) -
// keep this in sync by hand with its counterpart in the sibling app
// (backend/src/vendor/shared <-> frontend/src/vendor/shared) when it changes.
/**
 * Browser-safe barrel. `ids.ts` uses node:crypto and is deliberately excluded
 * here - it is imported by server code via the `@minedesk/shared/ids` subpath
 * instead, so a bundler building for the browser never has to resolve a Node
 * builtin it cannot polyfill.
 */
export * from './permissions.js';
export * from './paths.js';
export * from './format.js';
