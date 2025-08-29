import path from "path";
import { fork } from "child_process";

const basePath = import.meta.dirname;
const pullScript = path.join(basePath, "pull.ts");
const splits = 4;

const minX = 0,
	maxX = 20,
	minY = 0,
	maxY = 2047;
const totalWidth = maxX - minX + 1;
const widthPerSplit = Math.ceil(totalWidth / splits);

for (let i = 0; i < splits; i++) {
	const splitMinX = minX + i * widthPerSplit;
	const splitMaxX = Math.min(splitMinX + widthPerSplit - 1, maxX);

	const args = [`--minX=${splitMinX}`, `--maxX=${splitMaxX}`, `--minY=${minY}`, `--maxY=${maxY}`];

	const child = fork(pullScript, args, {
		execArgv: ["--import", "tsx"],
	});

	console.log(`Starting child ${i}: X=${splitMinX}-${splitMaxX}, Y=${minY}-${maxY}`);
	child.on("exit", (code) => {
		console.log(`Child ${i} exited with code ${code}`);
	});
}
