import { spawn, fork } from "child_process";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import { parseArgs } from "util";

const args = parseArgs({
	options: {
		wPlacePath: { type: "string", short: "w", default: "C:/Users/jazza/Downloads/wplace" },
		sevenZipPath: { type: "string", short: "7", default: "C:/Program Files/7-Zip/7z.exe" },
		splits: { type: "string", short: "s", default: "8" },
		concurrent: { type: "string", short: "c", default: "800" },
		help: { type: "boolean", short: "h", default: false },
	},
}).values;

if (args.help) {
	console.log(`Usage: tsx run-pull.ts [--wPlacePath <path>] [--sevenZipPath <path>] [--help]`);
	console.log();
	console.log("Options:");
	console.log("-w   Path to the wplace folder (C:/Users/jazza/Downloads/wplace or /srv/wplace)");
	console.log("-7   Path to the 7z executable (C:/Program Files/7-Zip/7z.exe or /usr/bin/7z)");
	console.log("-s   Number of splits to use (8)");
	console.log("-c   Number of concurrent tasks to run (800)");
	console.log("-h   Show this help message");
	process.exit(0);
}

const baseDir = import.meta.dirname;
const runPullPath = path.join(baseDir, "run-pull.ts");
const wPlacePath = args.wPlacePath || "C:/Users/jazza/Downloads/wplace"; // Or /srv/wplace
const sevenZipPath = args.sevenZipPath || "C:/Program Files/7-Zip/7z.exe"; // Or /usr/bin/7z  or "7z" if in PATH

const folderToRename = "tiles";
const tilesXRegex = /^tiles-(\d+)(?:\.7z)?$/;

function runPull() {
	return new Promise<void>((resolve, reject) => {
		const runPull = fork(runPullPath, {
			env: {
				...process.env,
				WPLACE_PATH: wPlacePath,
				splits: args.splits,
				concurrent: args.concurrent,
			},
		});

		runPull.on("exit", (code) => {
			console.log(`run-pull exited with code ${code}`);

			if (code === 0) resolve();
			else reject(new Error(`run-pull exited with code ${code}`));
		});
	});
}

function runProc(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });

		child.stdout.on("data", (d) => process.stdout.write(d));
		child.stderr.on("data", (d) => process.stderr.write(d));

		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`${cmd} exited with code ${code}`));
		});
	});
}

async function renameTiles(): Promise<{ folderPath: string; folderName: string } | null> {
	const entries = await fsp.readdir(wPlacePath, { withFileTypes: true });

	if (!entries.some((e) => e.isDirectory() && e.name === folderToRename)) {
		console.log(`Folder ${folderToRename} does not exist, skipping`);
		return null;
	}

	let biggest = 0;
	for (const e of entries) {
		const m = tilesXRegex.exec(e.name);
		if (m) {
			const n = parseInt(m[1], 10);
			if (n > biggest) biggest = n;
		}
	}

	const newTileNumber = biggest + 1;
	const newFolderName = `tiles-${newTileNumber}`;
	const fromPath = path.join(wPlacePath, folderToRename);
	const toPath = path.join(wPlacePath, newFolderName);

	console.log(`Renaming ${folderToRename} to ${newFolderName}`);
	await fsp.rename(fromPath, toPath);

	return { folderPath: toPath, folderName: newFolderName };
}

async function compressTiles(folderPath: string): Promise<string> {
	if (!folderPath || !fs.existsSync(folderPath)) {
		console.log(`Folder ${folderPath} does not exist, skipping`);
		return "";
	}

	const archivePath = `${folderPath}.7z`;
	console.log(`Compressing ${folderPath} -> ${archivePath}`);

	// 7z: a = add to archive
	await runProc(sevenZipPath, ["a", archivePath, folderPath]);

	return archivePath;
}

async function deleteFolder(folderPath: string): Promise<void> {
	if (!folderPath || !fs.existsSync(folderPath)) {
		console.log(`Folder ${folderPath} does not exist, skipping`);
		return;
	}
	console.log(`Deleting ${folderPath}`);
	await fsp.rm(folderPath, { recursive: true, force: true });
}

(async () => {
	try {
		await runPull();

		const renamed = await renameTiles();
		if (!renamed) return;

		await compressTiles(renamed.folderPath); // wait for 7z to finish
		await deleteFolder(renamed.folderPath);
	} catch (err) {
		console.error("orchestrate error:", err);
		process.exitCode = 1;
	}
})();
