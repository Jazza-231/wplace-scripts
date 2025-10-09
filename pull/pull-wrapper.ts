import path from "path";
import fs from "fs";
import { fork } from "child_process";
import { DEFAULT_CONFIG } from "./config";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const WP_WPLACE_PATH = process.env.WP_WPLACE_PATH;
const WP_SPLITS = process.env.WP_SPLITS;
const WP_CONCURRENT = process.env.WP_CONCURRENT;

if (!(WP_WPLACE_PATH && WP_SPLITS && WP_CONCURRENT)) {
	console.error(
		"Environment variables failed to be set by wplace.ts - defaults are passed this way",
	);
	process.exit(1);
}

const basePath = import.meta.dirname;
const pullScript = path.join(basePath, "pull-tiles.ts");
const splits = parseInt(WP_SPLITS);

const { minX, maxX, minY, maxY } = DEFAULT_CONFIG.TILE_BOUNDS;

const logDir = path.relative(basePath, path.join(basePath, "..", "logs"));
if (!fs.existsSync(logDir)) {
	fs.mkdirSync(logDir, { recursive: true });
}
const startTime = Date.now();

interface ChildStats {
	perSecond: number;
	active: number;
	remaining: number;
	files: number;
	fails: number;
	etaMs: number;
}

const childStats = new Map<number, ChildStats>();

function splitRanges(minX: number, maxX: number, splits: number): Array<[number, number] | null> {
	const total = Math.max(0, maxX - minX + 1);
	const base = Math.floor(total / splits);
	const extra = total % splits;

	const ranges: Array<[number, number] | null> = [];
	let start = minX;

	for (let i = 0; i < splits; i++) {
		const size = base + (i < extra ? 1 : 0);
		if (size <= 0) {
			ranges.push(null);
			continue;
		}
		const end = Math.min(start + size - 1, maxX);
		ranges.push([start, end]);
		start = end + 1;
	}
	return ranges;
}

const ranges = splitRanges(minX, maxX, splits);
let totalFilesMade = 0;
let totalFilesChecked = 0;

for (let i = 0; i < splits; i++) {
	const r = ranges[i];
	if (!r) {
		console.log(`Starting child ${i}: idle`);
		continue;
	}

	const [splitMinX, splitMaxX] = r;
	const args = [`--minX=${splitMinX}`, `--maxX=${splitMaxX}`, `--minY=${minY}`, `--maxY=${maxY}`];

	const child = fork(pullScript, args, {
		execArgv: ["--import", "tsx"],
		silent: true,
		env: { ...process.env, WP_WPLACE_PATH, WP_CONCURRENT },
	});

	console.log(`Starting child ${i}: X=${splitMinX}-${splitMaxX}`);

	child.stdout?.on("data", (data) => {
		const output = data.toString().trim();
		const match = output.match(
			/(\d+) per second, (\d+) active, (\d+) remaining, (\d+) files, (\d+) failed, est (.+)/,
		);
		if (match) {
			const [, perSecond, active, remaining, files, fails, etaStr] = match;
			const etaMs = parseEtaString(etaStr);
			childStats.set(i, {
				perSecond: parseInt(perSecond),
				active: parseInt(active),
				remaining: parseInt(remaining),
				files: parseInt(files),
				fails: parseInt(fails),
				etaMs,
			});
		} else {
			console.log(`Child ${i}: ${output}`);

			const filesMatch = output.match(/All tasks finished. Done=(\d+), Failed=\d+, Files=(\d+)/);
			if (filesMatch) {
				const [, checked, made] = filesMatch;
				totalFilesChecked += parseInt(checked);
				totalFilesMade += parseInt(made);
			}
		}
	});

	child.stderr?.on("data", (data) => {
		console.error(`Child ${i} Error: ${data.toString().trim()}`);
	});

	child.on("close", async (code) => {
		console.log(`Child ${i} exited with code ${code}`);

		childStats.delete(i);

		// When all children are done
		if (childStats.size === 0) {
			const endTime = Date.now();
			const elapsed = endTime - startTime;

			const archiveIndexRegex = /tiles-(\d+).7z/;

			const archiveIndexes = fs
				.readdirSync(DEFAULT_CONFIG.WPLACE_PATH, { withFileTypes: true })
				.filter((f) => f.isFile() && f.name.endsWith(".7z"))
				.map((f) => f.name.match(archiveIndexRegex)?.[1])
				.filter((f) => f);

			const biggestArchiveIndex = Math.max(...archiveIndexes.map((i) => parseInt(i ?? "0")));

			const logData = {
				started: new Date(startTime).toISOString(),
				finished: new Date(endTime).toISOString(),
				elapsedMs: elapsed,
				elapsedFormatted: formattedTime(elapsed),
				splits,
				minX,
				maxX,
				minY,
				maxY,
				totalFilesChecked,
				totalFilesMade,
				archiveIndex: biggestArchiveIndex + 1,
			};

			const logFile = path.join(
				logDir,
				`run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
			);

			fs.writeFileSync(logFile, JSON.stringify(logData, null, 2));
			console.log(`✅ Finished. Log written to ${logFile}`);
		}
	});
}

function parseEtaString(etaStr: string): number {
	let totalMs = 0;

	// Split by spaces so we can handle things like "1h 5m" or "1m 30s"
	const parts = etaStr.trim().split(/\s+/);

	for (const part of parts) {
		if (part.endsWith("ms")) {
			totalMs += parseFloat(part.replace("ms", ""));
		} else if (part.endsWith("s")) {
			totalMs += parseFloat(part.replace("s", "")) * 1000;
		} else if (part.endsWith("m")) {
			totalMs += parseFloat(part.replace("m", "")) * 60 * 1000;
		} else if (part.endsWith("h")) {
			totalMs += parseFloat(part.replace("h", "")) * 60 * 60 * 1000;
		}
	}

	return totalMs;
}

function formattedTime(ms: number) {
	if (ms < SECOND) return `${ms.toFixed(0)}ms`;

	if (ms < MINUTE) {
		const s = Math.floor(ms / SECOND);
		const ds = Math.floor((ms % SECOND) / 100); // 10ths of a second
		return ds ? `${s}.${ds}s` : `${s}s`;
	}

	if (ms < HOUR) {
		const m = Math.floor(ms / MINUTE);
		const s = Math.floor((ms % MINUTE) / SECOND);
		return s ? `${m}m ${s}s` : `${m}m`;
	}

	const h = Math.floor(ms / HOUR);
	const m = Math.floor((ms % HOUR) / MINUTE);
	return m ? `${h}h ${m}m` : `${h}h`;
}

const average = (array: number[]) => array.reduce((a, b) => a + b) / array.length;

setInterval(() => {
	if (childStats.size === 0) return;

	const stats = Array.from(childStats.values());
	const totalPerSecond = stats.reduce((sum, s) => sum + s.perSecond, 0);
	const totalActive = stats.reduce((sum, s) => sum + s.active, 0);
	const totalRemaining = stats.reduce((sum, s) => sum + s.remaining, 0);
	const totalFiles = stats.reduce((sum, s) => sum + s.files, 0);
	const fails = stats.reduce((sum, s) => sum + s.fails, 0);
	const maxEtaMs = average(stats.map((s) => s.etaMs));

	console.log(
		`📊 COMBINED: ${totalPerSecond} per second, ${totalActive} active, ${totalRemaining} remaining, ${totalFiles} files, ${fails} fails, est ${formattedTime(
			maxEtaMs,
		)}`,
	);
}, 5000).unref();
