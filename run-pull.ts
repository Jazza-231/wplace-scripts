import path from "path";
import { fork } from "child_process";

const basePath = import.meta.dirname;
const pullScript = path.join(basePath, "pull.ts");
const splits = 4;

const minX = 1000,
	maxX = 1020,
	minY = 0,
	maxY = 2047;
const totalWidth = maxX - minX + 1;
const widthPerSplit = Math.ceil(totalWidth / splits);

// Track stats from all children
interface ChildStats {
	perSecond: number;
	active: number;
	remaining: number;
	files: number;
	failed: number;
	etaMs: number;
}

const childStats = new Map<number, ChildStats>();

for (let i = 0; i < splits; i++) {
	const splitMinX = minX + i * widthPerSplit;
	const splitMaxX = Math.min(splitMinX + widthPerSplit - 1, maxX);

	const args = [`--minX=${splitMinX}`, `--maxX=${splitMaxX}`, `--minY=${minY}`, `--maxY=${maxY}`];

	const child = fork(pullScript, args, {
		execArgv: ["--import", "tsx"],
		silent: true, // Important: capture stdout/stderr
	});

	console.log(`Starting child ${i}: X=${splitMinX}-${splitMaxX}`);

	// Parse stdout from each child
	child.stdout?.on("data", (data) => {
		const output = data.toString().trim();

		// Look for the progress line pattern
		const match = output.match(
			/(\d+) per second, (\d+) active, (\d+) remaining, (\d+) files, (\d+) failed, est (.+)/,
		);
		if (match) {
			const [, perSecond, active, remaining, files, failed, etaStr] = match;

			// Parse ETA string back to milliseconds
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
			// Forward non-progress lines (errors, etc.)
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

// Helper function to parse ETA strings back to milliseconds
function parseEtaString(etaStr: string): number {
	if (etaStr.includes("ms")) return parseInt(etaStr);
	if (etaStr.includes("s")) return parseInt(etaStr) * 1000;
	if (etaStr.includes("m")) return parseInt(etaStr) * 60 * 1000;
	if (etaStr.includes("h")) return parseInt(etaStr) * 60 * 60 * 1000;
	return 0;
}

// Helper function to format milliseconds back to readable string
function formattedTime(ms: number): string {
	const SECOND = 1000;
	const MINUTE = 60 * SECOND;
	const HOUR = 60 * MINUTE;

	if (ms < SECOND) return `${ms.toFixed(0)}ms`;
	if (ms < MINUTE) return `${(ms / SECOND).toFixed(0)}s`;
	if (ms < HOUR) return `${(ms / MINUTE).toFixed(0)}m`;
	return `${(ms / HOUR).toFixed(0)}h`;
}

// Aggregate and display combined stats every 5 seconds
setInterval(() => {
	if (childStats.size === 0) return;

	const stats = Array.from(childStats.values());

	const totalPerSecond = stats.reduce((sum, s) => sum + s.perSecond, 0);
	const totalActive = stats.reduce((sum, s) => sum + s.active, 0);
	const totalRemaining = stats.reduce((sum, s) => sum + s.remaining, 0);
	const totalFiles = stats.reduce((sum, s) => sum + s.files, 0);
	const failed = stats.reduce((sum, s) => sum + s.failed, 0);

	// Use the largest ETA (most conservative estimate)
	const maxEtaMs = Math.max(...stats.map((s) => s.etaMs));

	console.log(
		`📊 COMBINED: ${totalPerSecond} per second, ${totalActive} active, ${totalRemaining} remaining, ${totalFiles} files, ${failed} failed, est ${formattedTime(
			maxEtaMs,
		)}`,
	);
}, 5000).unref();
