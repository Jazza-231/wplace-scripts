import { spawn } from "child_process";
import readline from "readline";

const extract = "../go/extract/";
const combine = "../go/combine/";
const massCrop = "../go/mass-crop/";
const gif = "./gif.ps1";

class Options {
	global: {
		startIndex: number;
		endIndex: number;
		leftX: number;
		rightX: number;
		topY: number;
		bottomY: number;
		workers: number;
		basePath: string;
	};

	extract: {
		sevenZipPath: string;
	};

	combine: {
		deleteOriginals: boolean;
	};

	massCrop: {
		x: number;
		y: number;
		cropRect: { left: number; top: number; right: number; bottom: number };
	};

	gif: {
		fps: number;
		x: number;
		y: number;
		startIndex: number;
	};

	constructor() {
		this.global = {
			startIndex: 1,
			endIndex: -1,
			leftX: 1714,
			rightX: 1715,
			topY: 942,
			bottomY: 943,
			workers: 24,
			basePath: "C:/Users/jazza/Downloads/wplace",
		};

		this.extract = {
			sevenZipPath: "C:/Program Files/7-Zip/7z.exe",
		};

		this.combine = {
			deleteOriginals: true,
		};

		this.massCrop = {
			x: this.global.leftX,
			y: this.global.bottomY,
			cropRect: { left: 0, top: 0, right: 100, bottom: 100 },
		};

		this.gif = {
			fps: 20,
			x: this.global.leftX,
			y: this.global.bottomY,
			startIndex: 0 || this.global.startIndex,
		};
	}
}

export const options = new Options();

async function spawnChild(command: string, cwd: string, args: string[]): Promise<void> {
	const child = spawn(command, args, {
		cwd,
	});

	child.stdout.on("data", (data) => {
		console.log(data.toString());
	});

	child.stderr.on("data", (data) => {
		console.error(data.toString());
	});

	return new Promise((resolve, reject) => {
		child.on("close", (code) => {
			if (code !== 0) {
				console.error(`Extractor exited with code ${code}`);
				reject();
			} else resolve();
		});
	});
}

const extractArgs = [
	"--7zip",
	options.extract.sevenZipPath,
	"--base",
	options.global.basePath,
	"--start",
	options.global.startIndex.toString(),
	"--end",
	options.global.endIndex.toString(),
	"--left",
	options.global.leftX.toString(),
	"--right",
	options.global.rightX.toString(),
	"--top",
	options.global.topY.toString(),
	"--bottom",
	options.global.bottomY.toString(),
	"--workers",
	options.global.workers.toString(),
];
const combineArgs = [
	"--base",
	options.global.basePath,
	"--start",
	options.global.startIndex.toString(),
	"--end",
	options.global.endIndex.toString(),
	"--left",
	options.global.leftX.toString(),
	"--right",
	options.global.rightX.toString(),
	"--top",
	options.global.topY.toString(),
	"--bottom",
	options.global.bottomY.toString(),
	"--workers",
	options.global.workers.toString(),
	"--delete",
	options.combine.deleteOriginals.toString(),
];
function massCropArgs(cropRect: typeof options.massCrop.cropRect) {
	return [
		"--base",
		options.global.basePath,
		"--start",
		options.global.startIndex.toString(),
		"--end",
		options.global.endIndex.toString(),
		"--x",
		options.massCrop.x.toString(),
		"--y",
		options.massCrop.y.toString(),
		"--crop",
		JSON.stringify(cropRect || options.massCrop.cropRect),
	];
}

await spawnChild("go", extract, ["run", "main.go", ...extractArgs]);
await spawnChild("go", combine, ["run", "main.go", ...combineArgs]);

function askQuestion(query: string): Promise<string> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	return new Promise((resolve) =>
		rl.question(query, (ans) => {
			rl.close();
			resolve(ans);
		}),
	);
}

const left = await askQuestion("Crop rectangle left: ").then((v) => parseInt(v));
const top = await askQuestion("Crop rectangle top: ").then((v) => parseInt(v));
const right = await askQuestion("Crop rectangle right: ").then((v) => parseInt(v));
const bottom = await askQuestion("Crop rectangle bottom: ").then((v) => parseInt(v));

await spawnChild("go", massCrop, ["run", "main.go", ...massCropArgs({ left, top, right, bottom })]);

const startIndex = await askQuestion("Start index: ").then((v) => parseInt(v));
function gifArgs(startIndex: number) {
	return [
		options.gif.fps.toString(),
		options.gif.x.toString(),
		options.gif.y.toString(),
		startIndex.toString(),
	];
}
await spawnChild("pwsh", ".", [
	"-NoLogo",
	"-ExecutionPolicy",
	"Bypass",
	"-File",
	gif,
	...gifArgs(startIndex),
]);
