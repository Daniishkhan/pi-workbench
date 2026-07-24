export interface MigrationManifest {
  schemaVersion: 1;
  createdAt: string;
  settingsFile: string;
  settingsBackup: string;
  originalSettingsHash: string;
  appliedSettingsHash: string;
  legacyScout: string;
  scoutBackup: string;
  archivedScout?: string;
  embeddedRuntimeCommit?: string;
}
export function buildMigratedSettings(settings: Record<string, any>, recommendedProfile?: Record<string, any>): Record<string, any>;
export function applyMigration(settingsFile?: string, scoutFile?: string): { manifestPath: string; manifest: MigrationManifest };
export function rollback(manifestPath: string, force?: boolean): { settingsRestored: boolean; scoutRestored: boolean };
export function check(settingsFile?: string, scoutFile?: string): Record<string, unknown>;
