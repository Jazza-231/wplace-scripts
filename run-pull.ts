import path from "path";
import { fork } from "child_process";

const basePath = import.meta.dirname;
const pullScript = path.join(basePath, "pull.ts");
const splits = 4;

const minX = 1150,
	maxX = 1160,
	minY = 0,
	maxY = 2047;

interface ChildStats {
	perSecond: number;
	active: number;
	remaining: number;
	files: number;
	failed: number;
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
	});

	console.log(`Starting child ${i}: X=${splitMinX}-${splitMaxX}`);

	child.stdout?.on("data", (data) => {
		const output = data.toString().trim();
		const match = output.match(
			/(\d+) per second, (\d+) active, (\d+) remaining, (\d+) files, (\d+) failed, est (.+)/,
		);
		if (match) {
			const [, perSecond, active, remaining, files, failed, etaStr] = match;
			const etaMs = parseEtaString(etaStr);
			childStats.set(i, {
				perSecond: parseInt(perSecond),
				active: parseInt(active),
				remaining: parseInt(remaining),
				files: parseInt(files),
				failed: parseInt(failed),
				etaMs,
			});
		} else {
			console.log(`Child ${i}: ${output}`);
		}
	});

	child.stderr?.on("data", (data) => {
		console.error(`Child ${i} Error: ${data.toString().trim()}`);
	});

	child.on("exit", (code) => {
		console.log(`Child ${i} exited with code ${code}`);
		childStats.delete(i);
	});
}

function parseEtaString(etaStr: string): number {
	if (etaStr.includes("ms")) return parseInt(etaStr);
	if (etaStr.includes("s")) return parseInt(etaStr) * 1000;
	if (etaStr.includes("m")) return parseInt(etaStr) * 60 * 1000;
	if (etaStr.includes("h")) return parseInt(etaStr) * 60 * 60 * 1000;
	return 0;
}

function formattedTime(ms: number): string {
	const SECOND = 1000;
	const MINUTE = 60 * SECOND;
	const HOUR = 60 * MINUTE;

	if (ms < SECOND) return `${ms.toFixed(0)}ms`;
	if (ms < MINUTE) return `${(ms / SECOND).toFixed(0)}s`;
	if (ms < HOUR) return `${(ms / MINUTE).toFixed(0)}m`;
	return `${(ms / HOUR).toFixed(0)}h`;
}

setInterval(() => {
	if (childStats.size === 0) return;

	const stats = Array.from(childStats.values());
	const totalPerSecond = stats.reduce((sum, s) => sum + s.perSecond, 0);
	const totalActive = stats.reduce((sum, s) => sum + s.active, 0);
	const totalRemaining = stats.reduce((sum, s) => sum + s.remaining, 0);
	const totalFiles = stats.reduce((sum, s) => sum + s.files, 0);
	const failed = stats.reduce((sum, s) => sum + s.failed, 0);
	const maxEtaMs = Math.max(...stats.map((s) => s.etaMs));

	console.log(
		`📊 COMBINED: ${totalPerSecond} per second, ${totalActive} active, ${totalRemaining} remaining, ${totalFiles} files, ${failed} failed, est ${formattedTime(
			maxEtaMs,
		)}`,
	);
}, 5000).unref();
