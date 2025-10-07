import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";

type RawRow = {
	id: number;
	cityId: number;
	name: string;
	number: number;
	countryId: number;
	coord: { tileX: number; tileY: number };
	[k: string]: any;
};

type V1Entry = { id: number; n: number; y: number; xs: number; xe: number };
type V1Blob = { c: number; n: string; id: number; e: V1Entry[] };

type V2Run = { x0: number; k: number; id0: number; n0: number };
type V2Blob = { c: number; n: string; id: number; y: number; s: number; seq: V2Run[] };

type Compact = V1Blob | V2Blob | (V1Blob | V2Blob)[];

// ---------- CLI utils ----------
function usage(exit = 1): never {
	console.error(
		[
			"Usage:",
			"  Single file:",
			"    pnpm tsx wplace-compress.ts -c <input.jsonl>",
			"    pnpm tsx wplace-compress.ts -d <input[-compressed].json>",
			"    pnpm tsx wplace-compress.ts -q <input[-compressed].json> <coord JSON>",
			'      coord: [x,y] or {"x":X,"y":Y}',
			"",
			"  Mass on directory:",
			"    pnpm tsx wplace-compress.ts -mc <input_dir> [--concurrency N]",
			"    pnpm tsx wplace-compress.ts -md <input_dir> [--concurrency N]",
			"    pnpm tsx wplace-compress.ts -mq <input_dir> <coord JSON> [--concurrency N]",
		].join("\n"),
	);
	process.exit(exit);
}

function getArgFlag(flag: string): number | undefined {
	const idx = process.argv.indexOf(flag);
	if (idx >= 0 && process.argv[idx + 1]) {
		const n = Number(process.argv[idx + 1]);
		if (!Number.isNaN(n) && n > 0) return n;
	}
	return undefined;
}

function defaultConcurrency(): number {
	return Math.max(1, Math.min(8, os.cpus().length)); // sane default
}

// ---------- Path helpers ----------
function outPathsForJsonl(inputPath: string) {
	const dir = path.dirname(inputPath);
	const ext = path.extname(inputPath);
	const base = path.basename(inputPath, ext);
	return {
		compressed: path.join(dir, `${base}-compressed.json`),
		uncompressed: path.join(dir, `${base}-uncompressed.jsonl`),
	};
}

function outPathForCompressedJSON(inputPath: string) {
	const dir = path.dirname(inputPath);
	const ext = path.extname(inputPath);
	const base = path.basename(inputPath, ext).replace(/-compressed$/, "");
	return path.join(dir, `${base}-uncompressed.jsonl`);
}

function ensureDir(p: string) {
	fs.mkdirSync(p, { recursive: true });
}

// ---------- IO ----------
async function readJSONL(filePath: string): Promise<RawRow[]> {
	const rl = readline.createInterface({
		input: fs.createReadStream(filePath, { encoding: "utf-8" }),
		crlfDelay: Infinity,
	});
	const out: RawRow[] = [];
	for await (const line of rl) {
		const s = line.trim();
		if (!s) continue;
		out.push(JSON.parse(s));
	}
	return out;
}

// ---------- Compression core ----------
function rowsToV1(rows: RawRow[]): V1Blob[] {
	type MetaKey = string;
	const groups = new Map<
		MetaKey,
		{ c: number; n: string; id: number; bucket: Map<string, number[]> }
	>();

	for (const r of rows) {
		const metaKey = `${r.cityId}|${r.name}|${r.countryId}`;
		let g = groups.get(metaKey);
		if (!g) {
			g = { c: r.cityId, n: r.name, id: r.countryId, bucket: new Map() };
			groups.set(metaKey, g);
		}
		const key = `${r.id}|${r.number}|${r.coord.tileY}`;
		const arr = g.bucket.get(key) ?? [];
		arr.push(r.coord.tileX);
		g.bucket.set(key, arr);
	}

	const blobs: V1Blob[] = [];
	for (const g of groups.values()) {
		const entries: V1Entry[] = [];
		for (const [k, xsArr] of g.bucket.entries()) {
			const [ridStr, nStr, yStr] = k.split("|");
			const rid = Number(ridStr);
			const n = Number(nStr);
			const y = Number(yStr);
			const xs = xsArr.slice().sort((a, b) => a - b);

			let start = xs[0];
			let prev = xs[0];
			for (let i = 1; i < xs.length; i++) {
				const cur = xs[i];
				if (cur === prev + 1) {
					prev = cur;
					continue;
				}
				entries.push({ id: rid, n, y, xs: start, xe: prev });
				start = cur;
				prev = cur;
			}
			if (start !== undefined) entries.push({ id: rid, n, y, xs: start, xe: prev });
		}
		entries.sort((a, b) => a.id - b.id || a.n - b.n || a.y - b.y || a.xs - b.xs || a.xe - b.xe);
		blobs.push({ c: g.c, n: g.n, id: g.id, e: entries });
	}

	blobs.sort((a, b) => a.c - b.c || a.id - b.id || a.n.localeCompare(b.n));
	return blobs;
}

function v1ToV2IfPossible(v1: V1Blob, s = 4): V2Blob | null {
	if (!v1.e.length) return { c: v1.c, n: v1.n, id: v1.id, y: 0, s, seq: [] };
	const y = v1.e[0].y;
	for (const e of v1.e) {
		if (e.y !== y) return null;
		if (e.xe - e.xs + 1 !== s) return null;
	}
	const es = v1.e.slice().sort((a, b) => a.xs - b.xs);
	const runs: V2Run[] = [];
	let runStartIdx = 0;

	const flush = (fromIdx: number, toIdx: number) => {
		const first = es[fromIdx];
		const k = toIdx - fromIdx + 1;
		runs.push({ x0: first.xs, k, id0: first.id, n0: first.n });
	};

	for (let i = 1; i < es.length; i++) {
		const prev = es[i - 1];
		const cur = es[i];
		const xsOK = cur.xs === prev.xs + s;
		const idOK = cur.id === prev.id + 1;
		const nOK = cur.n === prev.n + 1;
		if (!(xsOK && idOK && nOK)) {
			flush(runStartIdx, i - 1);
			runStartIdx = i;
		}
	}
	flush(runStartIdx, es.length - 1);

	if (runs.length === 1 || runs.length * 2 <= v1.e.length) {
		return { c: v1.c, n: v1.n, id: v1.id, y, s, seq: runs };
	}
	return null;
}

function compactFromRows(rows: RawRow[], preferS = 4): (V1Blob | V2Blob)[] {
	const v1s = rowsToV1(rows);
	const out: (V1Blob | V2Blob)[] = [];
	for (const b of v1s) {
		const v2 = v1ToV2IfPossible(b, preferS);
		out.push(v2 ?? b);
	}
	return out;
}

function expandCompact(compact: Compact): RawRow[] {
	const arr = Array.isArray(compact) ? compact : [compact];
	const rows: RawRow[] = [];

	const isV2 = (x: any): x is V2Blob => x && Array.isArray(x.seq);
	const isV1 = (x: any): x is V1Blob => x && Array.isArray(x.e);

	for (const blob of arr) {
		if (isV2(blob)) {
			const { c, n, id, y, s, seq } = blob;
			for (const r of seq) {
				for (let i = 0; i < r.k; i++) {
					const xs = r.x0 + i * s;
					const xe = xs + (s - 1);
					for (let x = xs; x <= xe; x++) {
						rows.push({
							id: r.id0 + i,
							cityId: c,
							name: n,
							number: r.n0 + i,
							countryId: id,
							coord: { tileX: x, tileY: y },
						});
					}
				}
			}
		} else if (isV1(blob)) {
			const { c, n, id, e } = blob;
			for (const entry of e) {
				for (let x = entry.xs; x <= entry.xe; x++) {
					rows.push({
						id: entry.id,
						cityId: c,
						name: n,
						number: entry.n,
						countryId: id,
						coord: { tileX: x, tileY: entry.y },
					});
				}
			}
		} else {
			throw new Error("Unknown compact blob shape");
		}
	}

	rows.sort(
		(a, b) =>
			a.cityId - b.cityId ||
			a.countryId - b.countryId ||
			a.name.localeCompare(b.name) ||
			a.coord.tileY - b.coord.tileY ||
			a.coord.tileX - b.coord.tileX ||
			a.id - b.id ||
			a.number - b.number,
	);

	return rows;
}

// ---------- Query ----------
function parseCoordArg(raw: string): { x: number; y: number } {
	let v: any;
	try {
		v = JSON.parse(raw);
	} catch {
		throw new Error("coord arg must be JSON");
	}
	if (Array.isArray(v) && v.length === 2) return { x: Number(v[0]), y: Number(v[1]) };
	if (v && typeof v === "object" && "x" in v && "y" in v) return { x: Number(v.x), y: Number(v.y) };
	throw new Error('coord must be [x,y] or {"x":X,"y":Y}');
}

function queryOneCompact(compact: Compact, x: number, y: number) {
	const arr = Array.isArray(compact) ? compact : [compact];
	const isV2 = (x: any): x is V2Blob => x && Array.isArray(x.seq);
	const isV1 = (x: any): x is V1Blob => x && Array.isArray(x.e);

	for (const blob of arr) {
		if (isV2(blob)) {
			const { c, n, id, s } = blob;
			if (y !== blob.y) continue;
			for (const r of blob.seq) {
				if (x < r.x0) continue;
				const dx = x - r.x0;
				const q = Math.floor(dx / s);
				if (q < 0 || q >= r.k) continue;
				const xs = r.x0 + q * s;
				const xe = xs + (s - 1);
				if (x >= xs && x <= xe) {
					const entryId = r.id0 + q;
					const number = r.n0 + q;
					return {
						cityId: c,
						name: n,
						countryId: id,
						id: entryId,
						number,
						y,
						xs,
						xe,
						format: "V2",
					};
				}
			}
		} else if (isV1(blob)) {
			const { c, n, id } = blob;
			for (const e of blob.e) {
				if (e.y !== y) continue;
				if (x >= e.xs && x <= e.xe) {
					return {
						cityId: c,
						name: n,
						countryId: id,
						id: e.id,
						number: e.n,
						y: e.y,
						xs: e.xs,
						xe: e.xe,
						format: "V1",
					};
				}
			}
		}
	}
	return null;
}

// ---------- Single-file commands ----------
async function doCompressFile(input: string) {
	const { compressed } = outPathsForJsonl(input);
	const rows = await readJSONL(input);
	const compact = compactFromRows(rows, 4);
	const payload: Compact = compact.length === 1 ? compact[0] : compact;
	fs.writeFileSync(compressed, JSON.stringify(payload));
	console.log(`Compressed -> ${compressed} | rows: ${rows.length}`);
}

async function doDecompressFile(input: string) {
	const out = outPathForCompressedJSON(input);
	const compact = JSON.parse(fs.readFileSync(input, "utf-8")) as Compact;
	const rows = expandCompact(compact);
	await fs.promises.writeFile(out, rows.map((r) => JSON.stringify(r)).join("\n"));
	console.log(`Uncompressed -> ${out} | rows: ${rows.length}`);
}

async function doQueryFile(input: string, coordStr: string) {
	const { x, y } = parseCoordArg(coordStr);
	const compact = JSON.parse(fs.readFileSync(input, "utf-8")) as Compact;
	const res = queryOneCompact(compact, x, y);
	if (!res) {
		console.log(JSON.stringify({ match: false, file: input, x, y }));
		return;
	}
	console.log(JSON.stringify({ match: true, file: input, x, ...res }));
}

// ---------- Mass helpers ----------
async function listFiles(dir: string, predicate: (name: string) => boolean): Promise<string[]> {
	const ents = await fs.promises.readdir(dir, { withFileTypes: true });
	return ents
		.filter((e) => e.isFile() && predicate(e.name))
		.map((e) => path.join(dir, e.name))
		.sort();
}

async function runWithLimit<T>(
	items: T[],
	limit: number,
	fn: (item: T, idx: number) => Promise<void>,
) {
	let i = 0;
	const workers: Promise<void>[] = [];
	async function worker() {
		while (true) {
			const idx = i++;
			if (idx >= items.length) break;
			const it = items[idx];
			try {
				await fn(it, idx);
			} catch (e) {
				console.error(e);
			}
		}
	}
	const n = Math.max(1, limit);
	for (let k = 0; k < n; k++) workers.push(worker());
	await Promise.all(workers);
}

// ---------- Mass commands ----------
async function doMassCompress(inputDir: string, conc?: number) {
	const outDir = `${inputDir}-compressed`;
	ensureDir(outDir);
	const files = await listFiles(inputDir, (n) => n.toLowerCase().endsWith(".jsonl"));
	console.log(`mc: ${files.length} files -> ${outDir}`);
	const limit = conc ?? getArgFlag("--concurrency") ?? defaultConcurrency();

	await runWithLimit(files, limit, async (file) => {
		const rows = await readJSONL(file);
		const compact = compactFromRows(rows, 4);
		const payload: Compact = compact.length === 1 ? compact[0] : compact;
		const base = path.basename(file, path.extname(file));
		const out = path.join(outDir, `${base}-compressed.json`);
		fs.writeFileSync(out, JSON.stringify(payload));
		console.log(`[mc] ${path.basename(file)} -> ${path.basename(out)} (${rows.length} rows)`);
	});
}

async function doMassDecompress(inputDir: string, conc?: number) {
	const outDir = `${inputDir}-uncompressed`;
	ensureDir(outDir);
	const files = await listFiles(inputDir, (n) => n.toLowerCase().endsWith(".json"));
	console.log(`md: ${files.length} files -> ${outDir}`);
	const limit = conc ?? getArgFlag("--concurrency") ?? defaultConcurrency();

	await runWithLimit(files, limit, async (file) => {
		const compact = JSON.parse(fs.readFileSync(file, "utf-8")) as Compact;
		const rows = expandCompact(compact);
		const base = path.basename(file, path.extname(file)).replace(/-compressed$/, "");
		const out = path.join(outDir, `${base}-uncompressed.jsonl`);
		await fs.promises.writeFile(out, rows.map((r) => JSON.stringify(r)).join("\n"));
		console.log(`[md] ${path.basename(file)} -> ${path.basename(out)} (${rows.length} rows)`);
	});
}

async function doMassQuery(inputDir: string, coordStr: string, conc?: number) {
	const { x, y } = parseCoordArg(coordStr);
	const files = await listFiles(inputDir, (n) => n.toLowerCase().endsWith(".json"));
	console.log(`mq: searching ${files.length} files for (${x},${y})`);
	const limit = conc ?? getArgFlag("--concurrency") ?? defaultConcurrency();

	// Early short-circuit: collect matches but keep concurrency
	const matches: any[] = [];
	await runWithLimit(files, limit, async (file) => {
		try {
			const compact = JSON.parse(fs.readFileSync(file, "utf-8")) as Compact;
			const hit = queryOneCompact(compact, x, y);
			if (hit) {
				matches.push({ file, x, ...hit });
			}
		} catch (e) {
			console.error(`[mq] Failed ${file}:`, (e as Error).message);
		}
	});

	if (matches.length === 0) {
		console.log(JSON.stringify({ match: false, x, y, files: files.length }));
	} else {
		// Print all matches as JSONL
		for (const m of matches) console.log(JSON.stringify({ match: true, ...m }));
	}
}

// ---------- Main ----------
async function main() {
	const flag = process.argv[2];
	if (!flag) usage();

	if (flag === "-c") {
		const input = process.argv[3];
		if (!input || !fs.existsSync(input) || path.extname(input).toLowerCase() !== ".jsonl") {
			console.error("need an existing .jsonl input");
			process.exit(1);
		}
		await doCompressFile(input);
		return;
	}

	if (flag === "-d") {
		const input = process.argv[3];
		if (!input || !fs.existsSync(input)) {
			console.error("need an existing compact .json input");
			process.exit(1);
		}
		await doDecompressFile(input);
		return;
	}

	if (flag === "-q") {
		const input = process.argv[3];
		const coord = process.argv[4];
		if (!input || !fs.existsSync(input) || !coord) {
			console.error("need: -q <compact.json> <coord JSON>");
			process.exit(1);
		}
		await doQueryFile(input, coord);
		return;
	}

	if (flag === "-mc") {
		const inputDir = process.argv[3];
		if (!inputDir || !fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
			console.error("need an existing directory containing .jsonl files");
			process.exit(1);
		}
		await doMassCompress(inputDir);
		return;
	}

	if (flag === "-md") {
		const inputDir = process.argv[3];
		if (!inputDir || !fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
			console.error("need an existing directory containing compact .json files");
			process.exit(1);
		}
		await doMassDecompress(inputDir);
		return;
	}

	if (flag === "-mq") {
		const inputDir = process.argv[3];
		const coord = process.argv[4];
		if (!inputDir || !fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory() || !coord) {
			console.error("need: -mq <dir> <coord JSON>");
			process.exit(1);
		}
		await doMassQuery(inputDir, coord);
		return;
	}

	usage();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
