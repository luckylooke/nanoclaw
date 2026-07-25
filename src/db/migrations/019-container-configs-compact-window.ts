import type { Migration } from './index.js';

/**
 * `compact_window` on `container_configs`: adaptive per-session compaction
 * window override (see complexity-tier.ts). NULL keeps the runner's static
 * default.
 */
export const migration019: Migration = {
  version: 19,
  name: 'container-configs-compact-window',
  up(db) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN compact_window INTEGER;`);
  },
};
