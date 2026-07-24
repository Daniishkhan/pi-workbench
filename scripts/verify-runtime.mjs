#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const expectedCommit = "105c1399d36517292cc7dbe1f56f4724de39bd10";
const expectedSource = `https://codeload.github.com/nicobailon/pi-subagents/tar.gz/${expectedCommit}`;
const declared = packageJson.dependencies?.["pi-subagents"];
if (declared !== expectedSource) throw new Error(`pi-subagents must be pinned to upstream main commit ${expectedCommit}; found ${String(declared)}`);
const locked = packageLock.packages?.["node_modules/pi-subagents"];
if (locked?.resolved !== expectedSource || typeof locked.integrity !== "string" || !locked.integrity) {
	throw new Error("package-lock.json does not integrity-lock the approved pi-subagents upstream snapshot.");
}
const runtimeRoot = path.join(root, "node_modules", "pi-subagents");
const runtimePackagePath = path.join(runtimeRoot, "package.json");
if (!existsSync(runtimePackagePath)) throw new Error("pi-subagents is not installed. Run npm install in the Workbench package.");
const runtimePackage = JSON.parse(readFileSync(runtimePackagePath, "utf8"));
if (runtimePackage.name !== "pi-subagents" || runtimePackage.version !== "0.35.1") {
	throw new Error(`Unexpected pi-subagents package identity: ${runtimePackage.name}@${runtimePackage.version}`);
}
const entrySource = readFileSync(path.join(runtimeRoot, "index.ts"), "utf8");
if (!/export\s*\{\s*default\s*\}/.test(entrySource)) throw new Error("pi-subagents no longer exposes its public default extension entry point.");
const rpcSource = readFileSync(path.join(runtimeRoot, "src", "extension", "rpc.ts"), "utf8");
for (const contract of [
	'SUBAGENT_RPC_PROTOCOL_VERSION = 1',
	'SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request"',
	'SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:"',
]) {
	if (!rpcSource.includes(contract)) throw new Error(`pi-subagents public RPC compatibility check failed: ${contract}`);
}
const delegationSource = readFileSync(path.join(runtimeRoot, "src", "api", "delegation.ts"), "utf8");
for (const contract of [
	"SUBAGENT_DELEGATION_PROTOCOL_VERSION = 1",
	'SUBAGENT_DELEGATION_REQUEST_EVENT = "prompt-template:subagent:request"',
	'SUBAGENT_DELEGATION_STARTED_EVENT = "prompt-template:subagent:started"',
	'SUBAGENT_DELEGATION_UPDATE_EVENT = "prompt-template:subagent:update"',
	'SUBAGENT_DELEGATION_RESPONSE_EVENT = "prompt-template:subagent:response"',
	'SUBAGENT_DELEGATION_CANCEL_EVENT = "prompt-template:subagent:cancel"',
]) {
	if (!delegationSource.includes(contract)) throw new Error(`pi-subagents public delegation compatibility check failed: ${contract}`);
}
const sharedTypesSource = readFileSync(path.join(runtimeRoot, "src", "shared", "types.ts"), "utf8");
if (!sharedTypesSource.includes('SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete"')) {
	throw new Error("pi-subagents async-complete event contract check failed.");
}
console.log(`Verified pi-subagents upstream main snapshot ${expectedCommit.slice(0, 12)} (${runtimePackage.version}, ${locked.integrity.slice(0, 24)}…).`);
