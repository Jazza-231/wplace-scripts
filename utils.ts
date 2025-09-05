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
type RGBA = Buffer<ArrayBufferLike>;
type HSL = { h: number; s: number; l: number };
type StreamOrPath = Stream.Readable | string;
type ProcessFunction = (streamOrPath: StreamOrPath, opts: ProcessOpts) => Promise<RGB | null>;

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

async function streamOrPathToBuffer(streamOrPath: Stream.Readable | string): Promise<RGBA> {
	const image = sharp();
	if (typeof streamOrPath === "string") {
		if (!fs.existsSync(streamOrPath))
			throw new Error(`File ${streamOrPath} does not exist`, { cause: "file-missing" });
		const file = streamOrPath;
		streamOrPath = fs.createReadStream(file);
		log(`Read ${file} to stream`, "all");
	}
	streamOrPath.pipe(image);
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
async function averageImage(streamOrPath: StreamOrPath, opts: ProcessOpts = {}) {
	const rgbaBuf = await streamOrPathToBuffer(streamOrPath);
	let sumR = 0,
		sumG = 0,
		sumB = 0,
		sumA = 0;

	for (let i = 0; i < rgbaBuf.length; i += 4) {
		const a = rgbaBuf[i + 3] / 255;
		if (a <= 0 && !opts.includeTransparency) continue;
		sumR += rgbaBuf[i] * a;
		sumG += rgbaBuf[i + 1] * a;
		sumB += rgbaBuf[i + 2] * a;
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

async function modeImage(streamOrPath: StreamOrPath, opts: ProcessOpts = {}) {
	const rgbaBuf = await streamOrPathToBuffer(streamOrPath);
	const u32 = new Uint32Array(rgbaBuf.buffer, rgbaBuf.byteOffset, rgbaBuf.byteLength >>> 2);

	const hist = new Uint32Array(1 << 24);
	const touched: number[] = [];

	let maxKey = 0;
	let maxCount = 0;
	const skipBlack = !opts.includeBlack;

	for (let i = 0; i < u32.length; i++) {
		const v = u32[i];
		const a = v >>> 24;
		if (a === 0) continue;

		const key = v & 0x00ffffff;
		if (skipBlack && key === 0) continue;

		const c = hist[key] + 1;
		if (hist[key] === 0) touched.push(key);
		hist[key] = c;

		if (c > maxCount) {
			maxCount = c;
			maxKey = key;
		}
	}

	for (let i = 0; i < touched.length; i++) hist[touched[i]] = 0;

	if (maxCount === 0) return null;

	const r = maxKey & 0xff;
	const g = (maxKey >>> 8) & 0xff;
	const b = (maxKey >>> 16) & 0xff;
	return { r, g, b };
}

function countNonTransparent(rgba: Uint8Array): number {
	// Treat the buffer as 32-bit words: [R,G,B,A] -> A is the top byte on little-endian
	const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, Math.floor(rgba.byteLength / 4));

	let count = 0;
	// Manual unroll for a bit more throughput
	const n = u32.length;
	let i = 0;
	const step = 8;
	for (; i + step <= n; i += step) {
		const v0 = u32[i] >>> 24;
		const v1 = u32[i + 1] >>> 24;
		const v2 = u32[i + 2] >>> 24;
		const v3 = u32[i + 3] >>> 24;
		const v4 = u32[i + 4] >>> 24;
		const v5 = u32[i + 5] >>> 24;
		const v6 = u32[i + 6] >>> 24;
		const v7 = u32[i + 7] >>> 24;
		count +=
			(v0 !== 0 ? 1 : 0) +
			(v1 !== 0 ? 1 : 0) +
			(v2 !== 0 ? 1 : 0) +
			(v3 !== 0 ? 1 : 0) +
			(v4 !== 0 ? 1 : 0) +
			(v5 !== 0 ? 1 : 0) +
			(v6 !== 0 ? 1 : 0) +
			(v7 !== 0 ? 1 : 0);
	}
	for (; i < n; i++) {
		count += u32[i] >>> 24 !== 0 ? 1 : 0;
	}
	return count;
}

export async function countImage(streamOrPath: StreamOrPath, opts: ProcessOpts = {}) {
	const rgbaBuf = await streamOrPathToBuffer(streamOrPath);
	// pixels is just length / 4
	const pixels = rgbaBuf.length >>> 2;

	const count = countNonTransparent(rgbaBuf);

	const value = Math.log1p(count) / Math.pow(Math.log1p(pixels), 0.9);
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

async function runProcessor(
	archivePath: string,
	min: number,
	max: number,
	concurrency: number,
	processingFunctionName: keyof typeof FUNCTIONS,
	opts: ProcessOpts = {},
) {
	const numberRegex = /tiles-(\d+)/;
	const archiveNumber = numberRegex.exec(archivePath)?.[1];

	log(
		`Processing range ${min}-${max} with operation ${processingFunctionName} on tiles-${archiveNumber}`,
		"basic",
	);
	const startTime = Date.now();

	const processedFolders = await processRange(
		archivePath,
		min,
		max,
		FUNCTIONS[processingFunctionName],
		opts,
		concurrency,
	);

	const width = max - min + 1;
	const suffixes = Object.keys(opts)
		.filter((k) => opts[k])
		.map((k) => optionsToSuffix[k])
		.join("");

	await sharp(processedFolders, { raw: { width, height: tileHeight, channels: 3 } }).toFile(
		path.join(
			wPlacePath,
			`${processingFunctionName} ${min}-${max}${suffixes}-${archiveNumber}.png`,
		),
	);

	const endTime = Date.now();
	log(
		`Finished processing range ${min}-${max} in ${((endTime - startTime) / 1000).toFixed(1)}s`,
		"basic",
	);

	const results = {
		archiveNumber,
		processingFunctionName,
		min,
		max,
		timeTaken: ((endTime - startTime) / 1000).toFixed(1),
	};

	ensureDir(path.join(wPlacePath, "logs"));
	fs.writeFileSync(
		path.join(
			wPlacePath,
			"logs",
			`${processingFunctionName}-${archiveNumber}-${new Date()
				.toISOString()
				.replace(/[:.]/g, "-")}.json`,
		),
		JSON.stringify(results),
		"utf8",
	);
}

// Config: the configuration continues
const concurrency = 32;

async function main(archiveNumber: number, extract: boolean = false) {
	const archiveName = `tiles-${archiveNumber}`;

	let extractTo = path.join(wPlacePath, `${archiveName}-extracted`);

	if (extract) {
		extractTo = path.join(wPlacePath, `_extract-${archiveNumber}_${Date.now()}`);

		console.log(`Extracting ${archiveName} to ${extractTo}`);

		await extractArchiveToFolder(`${wPlacePath}/${archiveName}.7z`, extractTo);
		extractTo = path.join(extractTo, archiveName);
	}

	// await runProcessor(extractTo, 0, 2047, concurrency, "average", { includeTransparency: true });
	// await runProcessor(extractTo, 0, 2047, concurrency, "average", { includeTransparency: false });
	// await runProcessor(extractTo, 0, 2047, concurrency, "mode", { includeBlack: true });
	// await runProcessor(extractTo, 0, 2047, concurrency, "mode", { includeBlack: false });
	await runProcessor(extractTo, 0, 2047, concurrency, "count");

	if (extract) {
		console.log(`Cleaning up ${extractTo}`);
		fs.rmSync(extractTo, { recursive: true, force: true });
	}
}

for (let i = 1; i < 27; i++) {
	await main(i, true);
}
