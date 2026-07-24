import { createHash } from "node:crypto";
import path from "node:path";

export function repositoryContextKey(repositoryRoot: string): string {
	return createHash("sha256").update(path.resolve(repositoryRoot)).digest("hex").slice(0, 32);
}

export function repositoryContextPath(cacheRoot: string, repositoryRoot: string): string {
	return path.join(cacheRoot, `${repositoryContextKey(repositoryRoot)}.json`);
}

export function isRepositoryContextFresh(cachedHead: string | null, currentHead: string | null): boolean {
	return cachedHead !== null && currentHead !== null && cachedHead === currentHead;
}
