import { spawn } from "child_process";
import path from "path";
import * as fs from "fs";
import sharp from "sharp";
import Stream from "stream";

// Static configs
const sevenZipPath = "C:/Program Files/7-Zip/7z.exe";
const wPlacePath = "C:/Users/jazza/Downloads/wplace";
const tileHeight = 2048;
const logging = "basic" as "basic" | "detailed" | "all";

const FUNCTIONS = {
	average: averageImage,
	mode: modeImage,
	count: countImage,
};

const optionsToSuffix: Record<keyof ProcessOpts, string> = {
	includeTransparency: "-t",
	includeBlack: "-b",
};

// Types
type ProcessOpts = { includeTransparency?: boolean; includeBlack?: boolean };
type RGB = { r: number; g: number; b: number };
type HSL = { h: number; s: number; l: number };
type ProcessFunction = (stream: Stream.Readable | string, opts: ProcessOpts) => Promise<RGB | null>;

// Helpers
function log(message: any, level: "basic" | "detailed" | "all" = "basic") {
	if (logging === "all") {
		console.log(message);
	} else if (logging === "detailed" && (level === "detailed" || level === "basic")) {
		console.log(message);
	} else if (logging === "basic" && level === "basic") {
		console.log(message);
	}
}

// https://stackoverflow.com/a/9493060/119527
function hslToRgb(hsl: HSL) {
	let r: number, g: number, b: number;
	const { h, s, l } = hsl;

	if (s === 0) {
		r = g = b = l; // achromatic
	} else {
		const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
		const p = 2 * l - q;
		r = hueToRgb(p, q, h + 1 / 3);
		g = hueToRgb(p, q, h);
		b = hueToRgb(p, q, h - 1 / 3);
	}

	r = Math.round(r * 255);
	g = Math.round(g * 255);
	b = Math.round(b * 255);

	log(`${h},${s},${l} to ${r},${g},${b}`, "all");

	return { r, g, b };
}

function hueToRgb(p: number, q: number, t: number) {
	if (t < 0) t += 1;
	if (t > 1) t -= 1;
	if (t < 1 / 6) return p + (q - p) * 6 * t;
	if (t < 1 / 2) return q;
	if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
	return p;
}

async function streamToBuffer(stream: Stream.Readable | string) {
	const image = sharp();
	if (typeof stream === "string") {
		const file = stream;
		stream = fs.createReadStream(file);
		log(`Read ${file} to stream`, "all");
	}
	stream.pipe(image);
	const buffer = await image.ensureAlpha().raw().toBuffer();

	return buffer;
}

function ensureDir(p: string) {
	if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function extractArchiveToFolder(archive: string, destDir: string) {
	return new Promise((resolve, reject) => {
		ensureDir(destDir);
		log(`Extracting ${archive} to ${destDir}`, "all");

		const args = ["x", "-y", `-o${destDir}`, archive];
		const child = spawn(sevenZipPath, args);

		let stderr = "";
		child.stderr.on("data", (d) => (stderr += d.toString()));

		child.on("close", (code) => {
			if (code !== 0) {
				// uh oh, clean up time
				fs.rmSync(destDir, { recursive: true, force: true });
				return reject(new Error(`7z extract failed with code ${code}: ${stderr || "(no stderr)"}`));
			} else resolve(destDir);
		});
	});
}

// Processing functions
async function averageImage(stream: Stream.Readable | string, opts: ProcessOpts = {}) {
	const rgba = await streamToBuffer(stream);
	let sumR = 0,
		sumG = 0,
		sumB = 0,
		sumA = 0;

	for (let i = 0; i < rgba.length; i += 4) {
		const a = rgba[i + 3] / 255;
		if (a <= 0 && !opts.includeTransparency) continue;
		sumR += rgba[i] * a;
		sumG += rgba[i + 1] * a;
		sumB += rgba[i + 2] * a;
		sumA += opts.includeTransparency ? 1 : a;
	}

	return sumA > 0
		? {
				r: Math.round(sumR / sumA),
				g: Math.round(sumG / sumA),
				b: Math.round(sumB / sumA),
		  }
		: null;
}

async function modeImage(stream: Stream.Readable | string, opts: ProcessOpts = {}) {
	const rgba = await streamToBuffer(stream);
	const counts = new Map<string, number>();

	for (let i = 0; i < rgba.length; i += 4) {
		const r = rgba[i];
		const g = rgba[i + 1];
		const b = rgba[i + 2];
		const a = rgba[i + 3] / 255;
		if (a <= 0) continue;
		if (!opts.includeBlack && r + b + g === 0) continue;

		const key = `${r},${g},${b}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	if (counts.size === 0) return null;

	let maxKey = "";
	let maxCount = -1;
	for (const [key, count] of counts) {
		if (count > maxCount) {
			maxKey = key;
			maxCount = count;
		}
	}

	const [r, g, b] = maxKey.split(",").map(Number);
	return { r, g, b };
}

async function countImage(stream: Stream.Readable | string, opts: ProcessOpts = {}) {
	const rgba = await streamToBuffer(stream);

	const pixels = rgba.length / 4;

	let count = 0;
	for (let i = 0; i < rgba.length; i += 4) {
		const a = rgba[i + 3] / 255;
		if (a > 0) count++;
	}

	const value = Math.log1p(count) / Math.log1p(pixels) ** 0.9;
	return hslToRgb({ h: value, s: 1, l: value * 0.6 });
}

// MUCH simpler parallel processing - just increase concurrency and batch sizes
async function processFolder(
	folderPath: string,
	folderNumber: number,
	processingFunction: ProcessFunction,
	opts: ProcessOpts = {},
) {
	const innerFolder = path.join(folderPath, folderNumber.toString());
	log(`Processing folder ${innerFolder}`, "detailed");

	const processedImages: RGB[] = [];

	for (let i = 0; i <= tileHeight - 1; i++) {
		const filePath = path.join(innerFolder, `${i}.png`);

		if (!fs.existsSync(filePath)) processedImages.push({ r: 0, g: 0, b: 0 });
		else {
			const processedImage = await processingFunction(filePath, opts);
			if (!processedImage) processedImages.push({ r: 0, g: 0, b: 0 });
			else processedImages.push(processedImage);
		}
	}

	log(`Finished processing folder ${innerFolder}`, "detailed");
	return processedImages;
}

async function folderToStream(
	folderPath: string,
	folderNumber: number,
	width: number = 1,
	processingFunction: ProcessFunction,
	opts: ProcessOpts = {},
): Promise<Buffer> {
	const processedImages = await processFolder(folderPath, folderNumber, processingFunction, opts);
	const height = processedImages.length;
	const buffer = Buffer.allocUnsafe(width * height * 3);

	processedImages.forEach((p, row) => {
		for (let col = 0; col < width; col++) {
			const offset = (row * width + col) * 3;
			buffer[offset + 0] = p.r;
			buffer[offset + 1] = p.g;
			buffer[offset + 2] = p.b;
		}
	});

	log(`Made processed image of ${folderPath}/${folderNumber}`, "basic");
	return buffer;
}

async function processRange(
	archivePath: string,
	min: number,
	max: number,
	processingFunction: ProcessFunction,
	opts: ProcessOpts = {},
	concurrency: number = 4,
): Promise<Buffer> {
	const columns = max - min + 1;
	const outBuffer = Buffer.allocUnsafe(columns * tileHeight * 3);

	const results: Array<{ x: number; stripBuffer: Buffer }> = [];

	for (let i = min; i <= max; i += concurrency) {
		const batch: Promise<{ x: number; stripBuffer: Buffer }>[] = [];
		for (let x = i; x <= Math.min(i + concurrency - 1, max); x++) {
			batch.push(
				folderToStream(archivePath, x, 1, processingFunction, opts).then((stripBuffer: Buffer) => ({
					x,
					stripBuffer,
				})),
			);
		}
		const batchResults = await Promise.all(batch);
		results.push(...batchResults);
	}

	// Assemble final buffer
	for (const { x, stripBuffer } of results) {
		for (let y = 0; y < tileHeight; y++) {
			const srcIdx = y * 3;
			const dstIdx = (y * columns + (x - min)) * 3;
			outBuffer[dstIdx + 0] = stripBuffer[srcIdx + 0]; // R
			outBuffer[dstIdx + 1] = stripBuffer[srcIdx + 1]; // G
			outBuffer[dstIdx + 2] = stripBuffer[srcIdx + 2]; // B
		}
	}

	return outBuffer;
}

async function main(
	archivePath: string,
	min: number,
	max: number,
	concurrency: number,
	processingFunction: keyof typeof FUNCTIONS,
	opts: ProcessOpts = {},
) {
	log(`Processing range ${min}-${max} with operation ${processingFunction}`, "basic");
	const startTime = Date.now();

	const processedFolders = await processRange(
		archivePath,
		min,
		max,
		FUNCTIONS[processingFunction],
		opts,
		concurrency,
	);

	const width = max - min + 1;
	const suffixes = Object.keys(opts)
		.filter((k) => opts[k])
		.map((k) => optionsToSuffix[k])
		.join("");

	await sharp(processedFolders, { raw: { width, height: tileHeight, channels: 3 } }).toFile(
		path.join(wPlacePath, `${processingFunction} ${min}-${max}${suffixes}.png`),
	);

	const endTime = Date.now();
	log(
		`Finished processing range ${min}-${max} in ${((endTime - startTime) / 1000).toFixed(1)}s`,
		"basic",
	);
}

// Config: the configuration continues
const extract = false;
const archiveName = "tiles-15";
const concurrency = 32;

let archivePath = path.join(wPlacePath, `${archiveName}-extracted`);

if (extract) {
	archivePath = path.join(wPlacePath, `_extract_${Date.now()}`);
	await extractArchiveToFolder(`${wPlacePath}/${archiveName}.7z`, archivePath);
	archivePath = path.join(archivePath, archiveName);
}

// await main(archivePath, 0, 2047, concurrency, "average", { includeTransparency: true });
// await main(archivePath, 0, 2047, concurrency, "average", { includeTransparency: false });
// await main(archivePath, 0, 2047, concurrency, "mode", { includeBlack: true });
// await main(archivePath, 0, 2047, concurrency, "mode", { includeBlack: false });
await main(archivePath, 1000, 1063, concurrency, "count");

if (extract) fs.rmSync(archivePath, { recursive: true, force: true });
