import { spawn } from "child_process";
import path from "path";
import * as fs from "fs";
import sharp from "sharp";
import Stream from "stream";

const sevenZipPath = "C:/Program Files/7-Zip/7z.exe";
const archiveName = "tiles-15";
const wPlacePath = "C:/Users/jazza/Downloads/wplace";
const archive = `${wPlacePath}/${archiveName}.7z`;

const tileHeight = 2048;
const detailedLogs = false;

type AverageOpts = { transparency?: boolean };
type RGB = { r: number; g: number; b: number };
type HSL = { h: number; s: number; l: number };

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

	return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

function hueToRgb(p: number, q: number, t: number) {
	if (t < 0) t += 1;
	if (t > 1) t -= 1;
	if (t < 1 / 6) return p + (q - p) * 6 * t;
	if (t < 1 / 2) return q;
	if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
	return p;
}

function streamToSharp(stream: Stream.Readable | string) {
	const image = sharp();
	if (typeof stream === "string") {
		const file = stream;
		stream = fs.createReadStream(file);
	}
	stream.pipe(image);
	return image;
}

async function averageImage(stream: Stream.Readable | string, opts: AverageOpts = {}) {
	const image = streamToSharp(stream);

	const rgba = await image.ensureAlpha().raw().toBuffer();
	let sumR = 0,
		sumG = 0,
		sumB = 0,
		sumA = 0;
	for (let i = 0; i < rgba.length; i += 4) {
		const a = rgba[i + 3] / 255;
		if (a <= 0 && !opts.transparency) continue;
		sumR += rgba[i] * a;
		sumG += rgba[i + 1] * a;
		sumB += rgba[i + 2] * a;
		sumA += opts.transparency ? 1 : a;
	}

	const nonTransparent =
		sumA > 0
			? {
					r: Math.round(sumR / sumA),
					g: Math.round(sumG / sumA),
					b: Math.round(sumB / sumA),
			  }
			: null;

	return nonTransparent;
}

async function modeImage(stream: Stream.Readable | string) {
	const image = streamToSharp(stream);

	const rgba = await image.ensureAlpha().raw().toBuffer();

	const counts = new Map<string, number>();

	for (let i = 0; i < rgba.length; i += 4) {
		const r = rgba[i];
		const g = rgba[i + 1];
		const b = rgba[i + 2];
		const a = rgba[i + 3] / 255;
		if (a <= 0) continue;

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

async function countImage(stream: Stream.Readable | string) {
	const image = streamToSharp(stream);

	const rgba = await image.ensureAlpha().raw().toBuffer();
	const pixels = rgba.length / 4;

	let count = 0;
	for (let i = 0; i < pixels; i += 4) {
		const a = rgba[i + 3] / 255;
		if (a > 0) count++;
	}

	const value = Math.log1p(count) / Math.log1p(pixels) ** 0.9;
	const colour = hslToRgb({ h: value, s: 1, l: value * 0.6 });

	return colour;
}

function ensureDir(p: string) {
	if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function extractArchiveToFolder(archive: string, destDir: string) {
	return new Promise((resolve, reject) => {
		ensureDir(destDir);

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

async function averageFolder(folderPath: string, folderNumber: number, opts: AverageOpts = {}) {
	if (detailedLogs) console.log(`Getting average for ${folderPath}/${folderNumber}`);

	const innerFolder = path.join(folderPath, folderNumber.toString());

	const averages: RGB[] = [];

	for (let i = 0; i <= 2047; i++) {
		const filePath = path.join(innerFolder, `${i}.png`);

		if (!fs.existsSync(filePath)) averages.push({ r: 0, g: 0, b: 0 });
		else {
			// const avg = await averageImage(filePath, opts);
			// const avg = await modeImage(filePath);
			const avg = await countImage(filePath);
			if (!avg) averages.push({ r: 0, g: 0, b: 0 });
			else averages.push(avg);
		}
	}

	if (detailedLogs) console.log("Gotten averages");

	return averages;
}

async function folderToAverageStream(
	folderPath: string,
	folderNumber: number,
	width: number = 1,
	opts: AverageOpts = {},
): Promise<Buffer> {
	const averages = await averageFolder(folderPath, folderNumber, opts);

	const height = averages.length;

	const buffer = Buffer.allocUnsafe(width * height * 3);

	if (detailedLogs) console.log("Making average image");

	averages.forEach((p, row) => {
		for (let col = 0; col < width; col++) {
			const offset = (row * width + col) * 3;
			buffer[offset + 0] = p.r;
			buffer[offset + 1] = p.g;
			buffer[offset + 2] = p.b;
		}
	});

	console.log(`Made average image of ${folderPath}/${folderNumber}`);

	return buffer;
}

async function averageRange(
	archivePath: string,
	min: number,
	max: number,
	opts: AverageOpts = {},
	concurrency: number = 4,
): Promise<Buffer> {
	const columns = max - min + 1;
	const outBuffer = Buffer.allocUnsafe(columns * tileHeight * 3);

	const results: Array<{ x: number; stripBuffer: Buffer }> = [];

	for (let i = min; i <= max; i += concurrency) {
		const batch: Promise<{ x: number; stripBuffer: Buffer }>[] = [];
		for (let x = i; x <= Math.min(i + concurrency - 1, max); x++) {
			batch.push(
				folderToAverageStream(archivePath, x, 1, opts).then((stripBuffer: Buffer) => ({
					x,
					stripBuffer,
				})),
			);
		}
		const batchResults = await Promise.all(batch);
		results.push(...batchResults);
	}

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
	opts: AverageOpts,
) {
	const averages = await averageRange(archivePath, min, max, opts, concurrency);

	const width = max - min + 1;

	sharp(averages, { raw: { width, height: tileHeight, channels: 3 } }).toFile(
		path.join(wPlacePath, `count ${min}-${max}${opts.transparency ? "-t" : ""}.png`),
	);
}

let archivePath = path.join(wPlacePath, `${archiveName}-extracted`, archiveName);

// archivePath = path.join(wPlacePath, `_extract_${Date.now()}`);
// await extractArchiveToFolder(archive, archivePath);

// archivePath = path.join(archivePath, archiveName);

console.log("Doing transparency: false");
await main(archivePath, 0, 2047, 50, { transparency: false });
// console.log("Doing transparency: true");
// await main(archivePath, 0, 2047, 30, { transparency: true });

// fs.rmSync(archivePath, { recursive: true, force: true });
