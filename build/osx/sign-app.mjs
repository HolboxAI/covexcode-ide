#!/usr/bin/env node
/**
 * Self-contained macOS Developer ID signer for the package job.
 * Does not depend on vscode/build/darwin/sign.ts being in the compile artifact
 * (that missing file was the #107/#109 packaging failure mode).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function die(msg) {
	console.error(msg);
	process.exit(1);
}

function readPlistString(plistPath, key) {
	const r = spawnSync('plutil', ['-extract', key, 'raw', '-o', '-', plistPath], {
		encoding: 'utf8',
	});
	if (r.status !== 0) {
		return '';
	}
	return (r.stdout || '').trim();
}

async function main() {
	const buildDir = process.argv[2] || process.cwd();
	const arch = process.env.VSCODE_ARCH;
	const identity = process.env.CODESIGN_IDENTITY;
	const tempDir = process.env.AGENT_TEMPDIRECTORY;

	if (!arch) die('VSCODE_ARCH is required');
	if (!identity) die('CODESIGN_IDENTITY is required');
	if (!tempDir) die('AGENT_TEMPDIRECTORY is required');

	const productPath = path.join(buildDir, 'vscode', 'product.json');
	if (!fs.existsSync(productPath)) {
		die(`Missing ${productPath}`);
	}
	const product = JSON.parse(fs.readFileSync(productPath, 'utf8'));
	const appRoot = path.join(buildDir, `VSCode-darwin-${arch}`);
	const appName = `${product.nameLong}.app`;
	const appPath = path.join(appRoot, appName);
	if (!fs.existsSync(appPath)) {
		die(`Missing app at ${appPath}`);
	}

	const entitlementsDir = path.join(__dirname, 'entitlements');
	const infoPlistPath = path.join(appPath, 'Contents', 'Info.plist');

	const electronPlist = path.join(
		appPath,
		'Contents',
		'Frameworks',
		'Electron Framework.framework',
		'Versions',
		'A',
		'Resources',
		'Info.plist',
	);
	const electronVersion =
		readPlistString(electronPlist, 'CFBundleVersion') ||
		readPlistString(electronPlist, 'CFBundleShortVersionString');
	if (!electronVersion) {
		die(`Could not read Electron version from ${electronPlist}`);
	}

	for (const [key, value] of [
		['NSAppleEventsUsageDescription', 'An application in Boxcode wants to use AppleScript.'],
		['NSMicrophoneUsageDescription', 'An application in Boxcode wants to use the Microphone.'],
		['NSCameraUsageDescription', 'An application in Boxcode wants to use the Camera.'],
		['NSAudioCaptureUsageDescription', 'An application in Boxcode wants to use Audio Capture.'],
		['NSLocalNetworkUsageDescription', 'The app uses your local network for DNS resolution and to connect to locally running services.'],
	]) {
		const existing = spawnSync('plutil', ['-extract', key, 'raw', '-o', '-', infoPlistPath], {
			encoding: 'utf8',
		});
		const op = existing.status === 0 ? '-replace' : '-insert';
		const r = spawnSync('plutil', [op, key, '-string', value, infoPlistPath], { encoding: 'utf8' });
		if (r.status !== 0) {
			die(`plutil ${op} ${key} failed: ${r.stderr || r.stdout}`);
		}
	}

	function entitlementsFor(filePath) {
		if (filePath.includes(' Helper (GPU).app')) {
			return path.join(entitlementsDir, 'helper-gpu-entitlements.plist');
		}
		if (filePath.includes(' Helper (Renderer).app')) {
			return path.join(entitlementsDir, 'helper-renderer-entitlements.plist');
		}
		if (filePath.includes(' Helper (Plugin).app')) {
			return path.join(entitlementsDir, 'helper-plugin-entitlements.plist');
		}
		if (filePath.includes(' Helper.app')) {
			return path.join(entitlementsDir, 'helper-entitlements.plist');
		}
		return path.join(entitlementsDir, 'app-entitlements.plist');
	}

	const signPrefix = process.env.SIGN_PREFIX;
	if (!signPrefix) die('SIGN_PREFIX is required (npm prefix with @electron/osx-sign)');

	let sign;
	try {
		const requireFromPrefix = createRequire(path.join(signPrefix, 'package.json'));
		const resolved = requireFromPrefix.resolve('@electron/osx-sign');
		({ sign } = await import(pathToFileURL(resolved).href));
	} catch (e) {
		die(`Cannot load @electron/osx-sign (${e.message}). prepare_assets.sh must npm-install it first.`);
	}

	const keychain = path.join(tempDir, 'buildagent.keychain');
	const appOpts = {
		app: appPath,
		platform: 'darwin',
		optionsForFile: (filePath) => ({
			entitlements: entitlementsFor(filePath),
			hardenedRuntime: true,
		}),
		preAutoEntitlements: false,
		preEmbedProvisioningProfile: false,
		keychain,
		version: electronVersion,
		identity,
	};

	console.log(`+ signing ${appPath} with identity ${identity.slice(0, 8)}… (electron ${electronVersion})`);
	await sign(appOpts);
	console.log('+ signing complete');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
