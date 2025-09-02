import { spawn } from "child_process";
import path from "path";
import * as fs from "fs";
import * as readline from "readline";
import sharp from "sharp";
import Stream from "stream";

const sevenZipPath = "C:/Program Files/7-Zip/7z.exe";
const archive = "C:/Users/jazza/Downloads/wplace/tiles-1.7z";
const wPlacePath = "C:/Users/jazza/Downloads/wplace";

const tileHeight = 2048;

type AverageOpts = { transparency?: boolean };

function listFilesInArchiveFolder(archive: string, folder: string): Promise<string[]> {
	return new Promise((resolve, reject) => {
		// List, technical details, archive, glob
		const args = ["l", "-slt", archive, `*/${folder}/*`];
		const child = spawn(sevenZipPath, args);

		const rl = readline.createInterface({ input: child.stdout });
		const files: string[] = [];

		rl.on("line", (line) => {
			const match = line.match(/Path = (.+)/);
			if (match && match[1].endsWith(".png")) {
				const filePath = match[1];
				files.push(filePath);
			}
		});

		let errorBuffer = "";
		child.stderr.on("data", (d) => (errorBuffer += d.toString()));

		child.on("close", (code) => {
			if (code === 0) resolve(files);
			else reject(new Error(`7z list failed with code ${code}: ${errorBuffer || "(no stderr)"}`));
		});
	});
}

function streamPathFromArchive(archive: string, file: string): Stream.Readable {
	// Extract, stdout, archive, file
	const args = ["x", "-so", archive, file];
	const child = spawn(sevenZipPath, args);
	return child.stdout;
}

function startFileSave(stream: Stream.Readable, outFile: string) {
	const writableStream = fs.createWriteStream(outFile);
	stream.pipe(writableStream);
	return writableStream;
}

async function averageImage(stream: Stream.Readable | string, opts: AverageOpts = {}) {
	const image = sharp();
	if (typeof stream === "string") {
		const file = stream;
		stream = fs.createReadStream(file);
	}
	stream.pipe(image);

	const rgba = await image.clone().ensureAlpha().raw().toBuffer();
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

function ensureDir(p: string) {
	if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function moveDirContents(source: string, destination: string) {
	ensureDir(destination);
	for (const name of fs.readdirSync(source)) {
		const from = path.join(source, name);
		const to = path.join(destination, name);
		if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
		fs.renameSync(from, to);
	}
}

function findSubdirEndingWith(root: string, endName: string): string | null {
	const queue = [root];
	while (queue.length) {
		const current = queue.shift()!;
		const stat = fs.statSync(current);
		if (!stat.isDirectory()) continue;
		if (path.basename(current) === endName) return current;
		for (const child of fs.readdirSync(current)) {
			queue.push(path.join(current, child));
		}
	}
	return null;
}

function extractFolderFromArchive(
	archive: string,
	internalFolder: string,
	destDir: string,
	opts: { overwrite?: boolean } = {},
): Promise<string> {
	return new Promise((resolve, reject) => {
		const tmpRoot = path.join(destDir, `.__extract_${Date.now()}`);
		ensureDir(tmpRoot);

		const args = ["x", "-y", `-o${tmpRoot}`, archive, `-ir!*/${internalFolder}/*`];
		const child = spawn(sevenZipPath, args);

		let stderr = "";
		child.stderr.on("data", (d) => (stderr += d.toString()));

		child.on("close", (code) => {
			if (code !== 0) {
				// uh oh, clean up time
				fs.rmSync(tmpRoot, { recursive: true, force: true });
				return reject(new Error(`7z extract failed with code ${code}: ${stderr || "(no stderr)"}`));
			}

			// find "<something>/<internalFolder>" and move insides to "<destDir>"
			const extractedInner = findSubdirEndingWith(tmpRoot, internalFolder);
			if (!extractedInner) {
				fs.rmSync(tmpRoot, { recursive: true, force: true });
				return reject(
					new Error(`Could not locate extracted folder "${internalFolder}" under temp root`),
				);
			}

			// const finalDir = path.join(destDir, internalFolder);
			const finalDir = destDir;

			if (opts.overwrite && fs.existsSync(finalDir)) {
				fs.rmSync(finalDir, { recursive: true, force: true });
			}
			ensureDir(finalDir);

			moveDirContents(extractedInner, finalDir);

			// clean up temp
			fs.rmSync(tmpRoot, { recursive: true, force: true });

			resolve(finalDir);
		});
	});
}

async function averageFolder(archivePath: string, innerFolder: string, opts: AverageOpts = {}) {
	console.log(`Getting average for ${archivePath}/${innerFolder}`);

	// Extract archivePath/innerFolder to temp folder
	const tmpRoot = path.join(wPlacePath, `.__average_${Date.now()}`);
	ensureDir(tmpRoot);

	console.log(`Extracting ${archivePath}/${innerFolder} to ${tmpRoot}`);

	await extractFolderFromArchive(archivePath, innerFolder, tmpRoot);

	console.log(`Extracted to ${tmpRoot}`);

	const files = fs.readdirSync(tmpRoot).map((f) => path.join(tmpRoot, f));

	console.log(`Getting average for ${files.length} files`);

	const averages: { r: number; g: number; b: number }[] = [];

	for (let i = 0; i <= 2047; i++) {
		const filePath = path.join(tmpRoot, `${i}.png`);
		if (!fs.existsSync(filePath)) averages.push({ r: 0, g: 0, b: 0 });
		else {
			const avg = await averageImage(filePath, opts);
			if (!avg) averages.push({ r: 0, g: 0, b: 0 });
			else averages.push(avg);
		}
	}

	fs.rmSync(tmpRoot, { recursive: true, force: true });

	console.log("Gotten averages");

	return averages;
}

async function folderToAverageStream(
	archivePath: string,
	folder: string,
	width: number = 1,
	opts: AverageOpts = {},
): Promise<Buffer> {
	const averages = await averageFolder(archivePath, folder, opts);

	const height = averages.length;

	const buffer = Buffer.alloc(width * height * 3);

	console.log("Making average image");

	averages.forEach((p, row) => {
		for (let col = 0; col < width; col++) {
			const offset = (row * width + col) * 3;
			buffer[offset + 0] = p.r;
			buffer[offset + 1] = p.g;
			buffer[offset + 2] = p.b;
		}
	});

	return buffer;
}

async function averageRange(min: number, max: number, opts: AverageOpts = {}): Promise<Buffer> {
	const columns = max - min + 1;

	// Number of columns * 2048 rows * 3 bytes per pixel
	const outBuffer = Buffer.alloc(columns * tileHeight * 3);

	for (let i = min; i < columns; i++) {
		const stripBuffer = await folderToAverageStream(archive, i.toString(), 1, opts);

		for (let y = 0; y < tileHeight; y++) {
			const srcIdx = y * 3;
			const dstIdx = (y * columns + i) * 3;
			outBuffer[dstIdx + 0] = stripBuffer[srcIdx + 0]; // R
			outBuffer[dstIdx + 1] = stripBuffer[srcIdx + 1]; // G
			outBuffer[dstIdx + 2] = stripBuffer[srcIdx + 2]; // B
		}
	}

	return outBuffer;
}

const averages = await averageRange(0, 19);

sharp(averages, { raw: { width: 20, height: 2048, channels: 3 } }).toFile(
	path.join(wPlacePath, "average 0-20.png"),
);
