export interface MigrationManifest {
	schemaVersion: 1;
	createdAt: string;
	settingsFile: string;
	settingsBackup: string;
	originalSettingsHash: string;
	appliedSettingsHash: string;
	legacyScout: string;
	scoutBackup: string | null;
	archivedScout: string | null;
	embeddedRuntimeCommit: string;
	oldPackages: Array<string | undefined>;
	newPackages: Array<string | undefined>;
}

export function sha256(value: string): string;
export function atomicWriteJson(file: string, value: unknown): void;
export function buildMigratedSettings(settings: Record<string, any>, recommendedProfile?: Record<string, any>): Record<string, any>;
export function migrationPreview(settingsFile: string, scoutFile: string): Record<string, unknown>;
export function applyMigration(settingsFile: string, scoutFile: string): { manifestPath: string; manifest: MigrationManifest };
export function rollback(manifestPath: string, force?: boolean): { settingsFile: string; scoutRestored: boolean };
export function main(argv?: string[]): void;
