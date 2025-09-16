import { spawn } from "child_process";
import path from "path";
import * as fs from "fs";

const sevenZipPath = "C:/Program Files/7-Zip/7z.exe";
const basePath = "C:/Users/jazza/Downloads/wplace";
const targetSubfolder = "602";
const targetFile = "769.png";

function extractFile(x: number) {
	return new Promise<void>((resolve, reject) => {
		const archive = path.join(basePath, `tiles-${x}.7z`);
		const internalPath = `tiles-${x}/${targetSubfolder}/${targetFile}`;
		const outputFile = path.join(basePath, `${x}-769.png`);

		const args = ["e", archive, internalPath, `-o${basePath}`, "-y"];

		const child = spawn(sevenZipPath, args);

		child.on("error", (err) => reject(err));

		child.on("close", (code) => {
			if (code === 0) {
				const extractedPath = path.join(basePath, targetFile);
				fs.rename(extractedPath, outputFile, (err: any) => {
					if (err) reject(err);
					else resolve();
				});
			} else {
				reject(new Error(`7z exited with code ${code}`));
			}
		});
	});
}

async function main() {
	for (let x = 1; x <= 54; x++) {
		console.log(`Extracting from tiles-${x}.7z...`);
		try {
			await extractFile(x);
			console.log(`Wrote ${x}-769.png`);
		} catch (err) {
			console.error(`Failed for tiles-${x}.7z:`, err);
		}
	}
}

main();
