/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';

export type BundledAgentManifest = {
	schemaVersion: number;
	agentVersion: string;
	protocolVersion: number;
	target: string;
	asset: string;
	sha256: string;
	size: number;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** Parse the version.json written by prepare_sidecar.sh. Kept strict: this
 * file is the only thing that tells us which agent version we are about to
 * run, so a malformed one must not silently become "no pin". */
export function parseBundledAgentManifest(text: string): BundledAgentManifest {
	const value: unknown = JSON.parse(text);
	if (!isObject(value)) {
		throw new Error('bundled agent manifest is not an object');
	}
	const { schemaVersion, agentVersion, protocolVersion, target, asset, sha256, size } = value;
	if (schemaVersion !== 1) {
		throw new Error(`unsupported bundled agent manifest schema ${String(schemaVersion)}`);
	}
	if (typeof agentVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(agentVersion)) {
		throw new Error('bundled agent manifest has no valid agentVersion');
	}
	if (protocolVersion !== 1) {
		throw new Error(`unsupported bundled agent ACP protocol ${String(protocolVersion)}`);
	}
	if (typeof target !== 'string' || target.length === 0) {
		throw new Error('bundled agent manifest has no valid target');
	}
	if (typeof asset !== 'string' || asset.length === 0) {
		throw new Error('bundled agent manifest has no valid asset');
	}
	if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
		throw new Error('bundled agent manifest has no valid sha256');
	}
	if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
		throw new Error('bundled agent manifest has no valid size');
	}
	return { schemaVersion: 1, agentVersion, protocolVersion: 1, target, asset, sha256, size };
}

/** Read the manifest staged next to the bundled executable, if it exists. */
export function readBundledAgentManifest(
	extensionPath: string,
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): BundledAgentManifest | undefined {
	const manifestPath = path.join(extensionPath, 'resources', 'bin', 'version.json');
	try {
		const manifest = parseBundledAgentManifest(fs.readFileSync(manifestPath, 'utf8'));
		if (!bundledManifestMatchesPlatform(manifest, platform, arch)) {
			throw new Error(`bundled agent target ${manifest.target} does not match ${platform}-${arch}`);
		}
		return manifest;
	} catch {
		return undefined;
	}
}

export function bundledManifestMatchesPlatform(
	manifest: BundledAgentManifest,
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): boolean {
	const prefix = `${platform}-${arch}`;
	return manifest.target === prefix || manifest.target.startsWith(`${prefix}-`);
}
