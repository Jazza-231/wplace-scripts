import { mkdir, stat as _stat, readdir } from "fs/promises";
import { basename, dirname, join } from "path";
import { createInterface } from "readline";
import sharp from "sharp";
const { kernel: _kernel } = sharp;

// === Config ===
const OUTPUT_DIR = "C:\\Users\\jazza\\Downloads\\wplace\\cropped";

// mask + grouping
const ALPHA_THRESHOLD = 16; // >= this alpha counts as solid
const DILATE_RADIUS = 1; // grow mask before grouping (connect tiny gaps)
const MERGE_GAP = 2; // merge boxes whose grown bounds touch within this gap (px)

// filtering
const MIN_GROUP_SOLID_PX = 10; // ignore components with fewer solid pixels
const MIN_GROUP_AREA = 4; // ignore components whose (w*h) ≤ this

// padding + scaling
const PADDING_AT_1X = 2;

// new scaling targets
const TARGET_WIDTH = 800; // aim for ~800 px final WIDTH
const MAX_POW2_SCALE = 8; // hard cap at 8x (1,2,4,8 only)

// optional strictness (default false — allow true 1x inputs)
const STRICT_GRID_GUARD = false; // if true: only skip when component is ALREADY upscaled inconsistently

// global output sequence counter
let GLOBAL_SEQ = 0;

// === Helpers ===
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim().replace(/['"]/g, ""))));
const isImage = (p) => /\.(png|webp|jpg|jpeg|bmp|gif)$/i.test(p);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function choosePow2Scale(w /* 1x padded width */, _h) {
	const width = Math.max(1, w);
	let best = 1;
	let bestDist = Infinity;
	for (let s = 1; s <= MAX_POW2_SCALE; s <<= 1) {
		const dist = Math.abs(width * s - TARGET_WIDTH);
		if (dist < bestDist) {
			bestDist = dist;
			best = s;
		}
	}
	return best;
}

async function getMask(inputPath) {
	const img = sharp(inputPath, { limitInputPixels: false }).ensureAlpha();
	const meta = await img.metadata();
	const { width: W, height: H } = meta;
	const buf = await img.raw().toBuffer(); // RGBA

	const mask = new Uint8Array(W * H);
	let solidCount = 0;
	for (let i = 0, p = 0; i < buf.length; i += 4, p++) {
		const a = buf[i + 3];
		const solid = a >= ALPHA_THRESHOLD ? 1 : 0;
		mask[p] = solid;
		solidCount += solid;
	}
	return { W, H, mask, solidCount };
}

function dilate(W, H, mask, r) {
	if (r <= 0) return mask;
	const out = new Uint8Array(W * H);
	const idx = (x, y) => y * W + x;
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			let on = 0;
			for (let dy = -r; dy <= r && !on; dy++) {
				const yy = y + dy;
				if (yy < 0 || yy >= H) continue;
				for (let dx = -r; dx <= r; dx++) {
					const xx = x + dx;
					if (xx < 0 || xx >= W) continue;
					if (mask[idx(xx, yy)]) {
						on = 1;
						break;
					}
				}
			}
			out[idx(x, y)] = on;
		}
	}
	return out;
}

function components(W, H, mask) {
	const visited = new Uint8Array(W * H);
	const idx = (x, y) => y * W + x;
	const comps = [];
	const qx = new Int32Array(W * H);
	const qy = new Int32Array(W * H);

	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const p = idx(x, y);
			if (!mask[p] || visited[p]) continue;

			let head = 0,
				tail = 0;
			qx[tail] = x;
			qy[tail] = y;
			tail++;
			visited[p] = 1;

			let minX = x,
				maxX = x,
				minY = y,
				maxY = y,
				count = 0;

			while (head < tail) {
				const cx = qx[head],
					cy = qy[head];
				head++;
				count++;
				if (cx < minX) minX = cx;
				if (cx > maxX) maxX = cx;
				if (cy < minY) minY = cy;
				if (cy > maxY) maxY = cy;

				for (let dy = -1; dy <= 1; dy++) {
					for (let dx = -1; dx <= 1; dx++) {
						if (dx === 0 && dy === 0) continue;
						const nx = cx + dx,
							ny = cy + dy;
						if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
						const np = idx(nx, ny);
						if (!mask[np] || visited[np]) continue;
						visited[np] = 1;
						qx[tail] = nx;
						qy[tail] = ny;
						tail++;
					}
				}
			}
			comps.push({ minX, minY, maxX, maxY, count });
		}
	}
	return comps;
}

function mergeTouchingBoxes(boxes, gap) {
	if (boxes.length <= 1) return boxes.slice();
	const expand = (b, g) => ({
		minX: b.minX - g,
		minY: b.minY - g,
		maxX: b.maxX + g,
		maxY: b.maxY + g,
		count: b.count,
	});
	const intersects = (a, b) =>
		!(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY);

	let arr = boxes.map((b) => ({ ...b }));
	let changed = true;
	while (changed) {
		changed = false;
		const used = new Array(arr.length).fill(false);
		const next = [];
		for (let i = 0; i < arr.length; i++) {
			if (used[i]) continue;
			let cur = { ...arr[i] };
			used[i] = true;
			let exCur = expand(cur, gap);
			for (let j = i + 1; j < arr.length; j++) {
				if (used[j]) continue;
				const exOther = expand(arr[j], gap);
				if (intersects(exCur, exOther)) {
					cur.minX = Math.min(cur.minX, arr[j].minX);
					cur.minY = Math.min(cur.minY, arr[j].minY);
					cur.maxX = Math.max(cur.maxX, arr[j].maxX);
					cur.maxY = Math.max(cur.maxY, arr[j].maxY);
					cur.count += arr[j].count;
					used[j] = true;
					changed = true;
					exCur = expand(cur, gap);
				}
			}
			next.push(cur);
		}
		arr = next;
	}
	return arr;
}

function tightenBoxOnOriginal(mask, W, H, box) {
	const minX = Math.max(0, box.minX);
	const minY = Math.max(0, box.minY);
	const maxX = Math.min(W - 1, box.maxX);
	const maxY = Math.min(H - 1, box.maxY);
	let x0 = maxX,
		y0 = maxY,
		x1 = minX,
		y1 = minY,
		cnt = 0;
	for (let y = minY; y <= maxY; y++) {
		const row = y * W;
		for (let x = minX; x <= maxX; x++) {
			if (mask[row + x]) {
				if (x < x0) x0 = x;
				if (y < y0) y0 = y;
				if (x > x1) x1 = x;
				if (y > y1) y1 = y;
				cnt++;
			}
		}
	}
	return cnt ? { minX: x0, minY: y0, maxX: x1, maxY: y1, count: cnt } : null;
}

async function processImage(inputPath) {
	const base = basename(inputPath).replace(/\.[^.]+$/, "");
	const parent = basename(dirname(inputPath)); // folder name (e.g. "104")
	await mkdir(OUTPUT_DIR, { recursive: true });

	const { W, H, mask, solidCount } = await getMask(inputPath);
	if (solidCount <= MIN_GROUP_SOLID_PX) {
		console.log(`skip ${base}: ≤${MIN_GROUP_SOLID_PX} solid px`);
		return;
	}

	const grown = dilate(W, H, mask, DILATE_RADIUS);
	let comps = components(W, H, grown);
	if (MERGE_GAP > 0) comps = mergeTouchingBoxes(comps, MERGE_GAP);

	let tight = [];
	for (const c of comps) {
		const t = tightenBoxOnOriginal(mask, W, H, c);
		if (!t) continue;
		const w = t.maxX - t.minX + 1;
		const h = t.maxY - t.minY + 1;
		if (t.count < MIN_GROUP_SOLID_PX) continue;
		if (w * h <= MIN_GROUP_AREA) continue;
		tight.push(t);
	}
	if (tight.length === 0) {
		console.log(`skip ${base}: no crops`);
		return;
	}
	tight.sort((a, b) => b.count - a.count);

	for (const c of tight) {
		const x0 = c.minX,
			y0 = c.minY;
		const cw = c.maxX - c.minX + 1;
		const ch = c.maxY - c.minY + 1;

		const crop1x = sharp(inputPath, { limitInputPixels: false })
			.extract({ left: x0, top: y0, width: cw, height: ch })
			.extend({
				top: PADDING_AT_1X,
				bottom: PADDING_AT_1X,
				left: PADDING_AT_1X,
				right: PADDING_AT_1X,
				background: { r: 0, g: 0, b: 0, alpha: 0 },
			});

		const { data, info } = await crop1x.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		const w1 = info.width,
			h1 = info.height;

		if (STRICT_GRID_GUARD) {
			const gcd = (a, b) => {
				while (b) [a, b] = [b, a % b];
				return a;
			};
			let gH = 0,
				gV = 0;
			for (let y = 0; y < h1; y++) {
				let run = 1;
				for (let x = 1; x < w1; x++) {
					const i0 = 4 * (y * w1 + (x - 1));
					const i1 = 4 * (y * w1 + x);
					const same =
						data[i0] === data[i1] &&
						data[i0 + 1] === data[i1 + 1] &&
						data[i0 + 2] === data[i1 + 2] &&
						data[i0 + 3] === data[i1 + 3];
					if (same) run++;
					else {
						gH = gH ? gcd(gH, run) : run;
						run = 1;
					}
				}
				gH = gH ? gcd(gH, run) : run;
			}
			for (let x = 0; x < w1; x++) {
				let run = 1;
				for (let y = 1; y < h1; y++) {
					const i0 = 4 * ((y - 1) * w1 + x);
					const i1 = 4 * (y * w1 + x);
					const same =
						data[i0] === data[i1] &&
						data[i0 + 1] === data[i1 + 1] &&
						data[i0 + 2] === data[i1 + 2] &&
						data[i0 + 3] === data[i1 + 3];
					if (same) run++;
					else {
						gV = gV ? gcd(gV, run) : run;
						run = 1;
					}
				}
				gV = gV ? gcd(gV, run) : run;
			}
			if (gH > 1 && gV > 1 && gH !== gV) {
				console.log(`warn ${base}: off-grid upscaled component (gH=${gH}, gV=${gV}). Skipping.`);
				continue;
			}
		}

		const s = choosePow2Scale(w1, h1);
		const TW = w1 * s;
		const TH = h1 * s;

		const outName = `${++GLOBAL_SEQ} X${parent}-${parent} Y${base}-${base}.png`;
		const outPath = join(OUTPUT_DIR, outName);

		await sharp(data, { raw: { width: w1, height: h1, channels: 4 }, limitInputPixels: false })
			.resize(TW, TH, { kernel: _kernel.nearest, withoutEnlargement: false })
			.png()
			.toFile(outPath);

		console.log(`ok ${outName} ${cw}x${ch} +pad2 -> ${w1}x${h1} x${s} => ${TW}x${TH}`);
	}
}

async function listImages(targetPath) {
	const stat = await _stat(targetPath);
	if (stat.isDirectory()) {
		const entries = await readdir(targetPath);
		return entries.map((n) => join(targetPath, n)).filter(isImage);
	}
	if (stat.isFile() && isImage(targetPath)) return [targetPath];
	return [];
}

(async () => {
	try {
		while (true) {
			const p = await ask("input file or folder (or STOP to quit): ");
			if (!p || /^stop$/i.test(p)) {
				console.log("stopping");
				break;
			}
			const imgs = await listImages(p);
			if (imgs.length === 0) {
				console.error("no images found");
				continue;
			}
			for (const img of imgs) await processImage(img);
			console.log(`done -> ${OUTPUT_DIR}`);
		}
		rl.close();
	} catch (err) {
		rl.close();
		console.error("err:", err.message || err);
		process.exit(1);
	}
})();
