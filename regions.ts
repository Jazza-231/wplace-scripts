import { configDotenv } from "dotenv";
import fs from "fs";
import Bottleneck from "bottleneck";
import { execFile } from "child_process";
import { promisify } from "util";
import ms from "ms";

const execFileAsync = promisify(execFile);

const OUT_DIR = "./regions";
const CHECKPOINT_PATH = "./regions.checkpoint.json";

export {};
configDotenv({ quiet: true });

type Coord = { tileX: number; tileY: number; pixelX: number; pixelY: number };

type PixelPainted = {
	paintedBy: {
		id: number;
		name: string;
		allianceId: number;
		allianceName: string;
		equippedFlag: number;
		picture: string;
	};
	region: { id: number; cityId: number; name: string; number: number; countryId: number };
};

async function getProxies() {
	const proxyListURL = process.env.PROXY_LIST_URL;
	if (!proxyListURL) throw new Error("No proxy list URL provided");

	const response = await fetch(proxyListURL);
	const proxyText = (await response.text()).trim();

	let proxyRequestList = proxyText
		.split(/\r?\n/)
		.map((proxy) => proxy.split(":"))
		.map((proxy) => {
			const [ip, port, username, password] = proxy;
			return { ip, port, username, password };
		});

	proxyRequestList = proxyRequestList.splice(0, 500);

	const proxyURLTemplate = "http://{username}:{password}@{ip}:{port}";

	return proxyRequestList.map((proxy) =>
		proxyURLTemplate
			.replace("{username}", proxy.username)
			.replace("{password}", proxy.password)
			.replace("{ip}", proxy.ip)
			.replace("{port}", proxy.port),
	);
}

let currentProxyIndex = 0;
function pickNextProxy(proxies: string[]) {
	const proxy = proxies[currentProxyIndex];
	currentProxyIndex++;
	if (currentProxyIndex >= proxies.length) currentProxyIndex = 0;
	return proxy;
}

function getHeaders() {
	return {
		"User-Agent":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		Accept: "application/json",
		"Accept-Language": "en-AU,en;q=0.9",
		Referer: "https://wplace.live/",
		Origin: "https://wplace.live",
	};
}

function isPixel(value: any): value is PixelPainted {
	if (typeof value !== "object" || value === null) return false;
	if (typeof value.paintedBy !== "object" || value.paintedBy === null) return false;
	if (typeof value.region !== "object" || value.region === null) return false;

	const paintedByValid =
		typeof value.paintedBy.id === "number" &&
		typeof value.paintedBy.name === "string" &&
		typeof value.paintedBy.allianceId === "number" &&
		typeof value.paintedBy.allianceName === "string" &&
		typeof value.paintedBy.equippedFlag === "number" &&
		("picture" in value.paintedBy ? typeof value.paintedBy.picture === "string" : true);

	const regionValid =
		typeof value.region.id === "number" &&
		typeof value.region.cityId === "number" &&
		typeof value.region.name === "string" &&
		typeof value.region.number === "number" &&
		typeof value.region.countryId === "number";

	return paintedByValid && regionValid;
}

function indexToCoord(i: number): Coord {
	const tileY = Math.floor(i / 2048);
	const tileX = i % 2048;
	return { tileX, tileY, pixelX: 0, pixelY: 0 };
}

function* getCoords(startIndex: number, endIndex: number): Generator<Coord> {
	for (let i = startIndex; i < endIndex; i++) yield indexToCoord(i);
}

const numberOfCoords = 2048 ** 2;

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

type Checkpoint = { lastCompletedRow: number; nextIndex: number };

function readCheckpoint(): Checkpoint {
	try {
		if (!fs.existsSync(CHECKPOINT_PATH)) return { lastCompletedRow: -1, nextIndex: 0 };
		const raw = fs.readFileSync(CHECKPOINT_PATH, "utf-8");
		const parsed = JSON.parse(raw) as Partial<Checkpoint>;
		const lastCompletedRow =
			typeof parsed.lastCompletedRow === "number" ? parsed.lastCompletedRow : -1;
		const nextIndex =
			typeof parsed.nextIndex === "number" &&
			parsed.nextIndex >= 0 &&
			parsed.nextIndex < numberOfCoords
				? parsed.nextIndex
				: Math.max(0, (lastCompletedRow + 1) * 2048);
		return { lastCompletedRow, nextIndex };
	} catch {
		return { lastCompletedRow: -1, nextIndex: 0 };
	}
}

function writeCheckpoint(cp: Checkpoint) {
	fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp), { encoding: "utf-8" });
}

function rowFile(tileY: number) {
	return `${OUT_DIR}/tileY-${tileY}.jsonl`;
}

function writeRegionLine(region: {
	id: number;
	cityId: number;
	name: string;
	number: number;
	countryId: number;
	coord: { tileX: number; tileY: number };
}) {
	fs.appendFileSync(rowFile(region.coord.tileY), JSON.stringify(region) + "\n", {
		encoding: "utf-8",
	});
}

function sortRowFile(tileY: number) {
	const file = rowFile(tileY);
	if (!fs.existsSync(file)) return;
	const text = fs.readFileSync(file, "utf-8").trim();
	if (!text) return;
	const lines = text.split(/\r?\n/);
	const objs = lines
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter((x) => x && typeof x === "object");
	objs.sort((a: any, b: any) => a.coord.tileX - b.coord.tileX);
	const out = objs.map((o) => JSON.stringify(o)).join("\n") + "\n";
	fs.writeFileSync(file, out, { encoding: "utf-8" });
}

console.log("Fetching proxies...");
const proxies = await getProxies();
console.log(`Using ${proxies.length} proxies...`);

const limiter = new Bottleneck({
	maxConcurrent: proxies.length * 5,
	minTime: Math.floor(300 / proxies.length),
});

function headersToCurlArgs(headers: Record<string, string>): string[] {
	const args: string[] = [];
	if (headers["User-Agent"]) args.push("--user-agent", headers["User-Agent"]);
	for (const [k, v] of Object.entries(headers)) {
		if (k === "User-Agent") continue;
		args.push("-H", `${k}: ${v}`);
	}
	return args;
}

async function curlJson(url: string, proxyUrl: string, headers: Record<string, string>) {
	const baseArgs = [
		"--silent",
		"--show-error",
		"--fail-with-body",
		"--compressed",
		"--max-time",
		"30",
		"--connect-timeout",
		"10",
		"--proxy",
		proxyUrl,
		...headersToCurlArgs(headers),
		url,
	];
	for (;;) {
		try {
			const { stdout } = await execFileAsync("curl", baseArgs, {
				encoding: "utf8",
				timeout: 45_000,
				maxBuffer: 10 * 1024 * 1024,
			});
			if (!stdout) throw new Error("Empty response body");
			const text = stdout.trim();
			return JSON.parse(text);
		} catch {
			await new Promise((r) => setTimeout(r, 500));
		}
	}
}

const COUNT = numberOfCoords;

const cp0 = readCheckpoint();
const startRow = cp0.lastCompletedRow + 1;
const startIndex = startRow * 2048;
const endIndex = COUNT;

if (startRow >= 0 && startRow < 2048) {
	try {
		if (fs.existsSync(rowFile(startRow))) fs.unlinkSync(rowFile(startRow));
	} catch {}
}

console.log(
	`Resuming at row tileY=${startRow} (index ${startIndex}/${COUNT}); lastCompletedRow=${cp0.lastCompletedRow}`,
);

const coordsGen = getCoords(startIndex, endIndex);
const WORKERS = Math.min(128, endIndex - startIndex);

let processed = 0;
let absoluteDone = startIndex;
let lastCompletedRow = cp0.lastCompletedRow;
let lastLog = Date.now();
let lastCkpt = Date.now();

const rowDone = new Uint16Array(2048);
const rowReady: boolean[] = Array(2048).fill(false);
const rowSealed: boolean[] = Array(2048).fill(false);
for (let y = 0; y <= lastCompletedRow; y++) {
	rowDone[y] = 2048;
	rowReady[y] = true;
	rowSealed[y] = true;
}

const start = Date.now();

function maybeSealRows() {
	while (
		lastCompletedRow + 1 < 2048 &&
		rowReady[lastCompletedRow + 1] &&
		!rowSealed[lastCompletedRow + 1]
	) {
		const y = lastCompletedRow + 1;
		sortRowFile(y);
		rowSealed[y] = true;
		lastCompletedRow = y;
		writeCheckpoint({
			lastCompletedRow,
			nextIndex: Math.max(absoluteDone, (lastCompletedRow + 1) * 2048),
		});
		console.log(`Row complete & sorted: tileY=${y} (${absoluteDone}/${COUNT})`);
		lastCkpt = Date.now();
	}
}

async function processCoord(coord: {
	tileX: number;
	tileY: number;
	pixelX: number;
	pixelY: number;
}) {
	const url = `https://backend.wplace.live/s0/pixel/${coord.tileX}/${coord.tileY}?x=${coord.pixelX}&y=${coord.pixelY}`;
	const headers = getHeaders();

	const proxy = () => pickNextProxy(proxies);
	for (;;) {
		try {
			const data = await curlJson(url, proxy(), headers);
			if (data && isPixel(data)) {
				writeRegionLine({ ...data.region, coord: { tileX: coord.tileX, tileY: coord.tileY } });
			}
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 500));
		}
	}
}

async function worker() {
	for (;;) {
		const next = coordsGen.next();
		if (next.done) return;

		const coord = next.value;
		await limiter.schedule(() => processCoord(coord));

		processed += 1;
		absoluteDone += 1;

		const y = coord.tileY;
		if (!rowReady[y]) {
			rowDone[y] += 1;
			if (rowDone[y] === 2048) {
				rowReady[y] = true;
				maybeSealRows();
			}
		}

		const now = Date.now();
		if (processed % 250 === 0 || now - lastLog >= 5000) {
			const elapsedMs = now - start;
			const percent = (absoluteDone / COUNT) * 100;
			const rate = processed > 0 ? elapsedMs / processed : Infinity;
			const remainingMs = isFinite(rate) ? rate * (COUNT - absoluteDone) : Infinity;
			console.log(
				`Checked ${absoluteDone}/${COUNT} (${percent.toFixed(2)}%) - elapsed ${ms(elapsedMs, {
					long: true,
				})} - remaining ~${isFinite(remainingMs) ? ms(remainingMs, { long: true }) : "unknown"}`,
			);
			lastLog = now;
		}

		if (now - lastCkpt >= 15000) {
			writeCheckpoint({ lastCompletedRow, nextIndex: absoluteDone });
			lastCkpt = now;
		}
	}
}

const workers: Promise<void>[] = [];
for (let i = 0; i < WORKERS; i++) workers.push(worker());
await Promise.all(workers);

maybeSealRows();

const end = Date.now();
const totalMs = end - start;
writeCheckpoint({ lastCompletedRow: 2047, nextIndex: COUNT });

console.log(
	`Done in ${ms(totalMs, {
		long: true,
	})} - processed ${absoluteDone}/${COUNT} (100.00%) - remaining ~00:00:00`,
);
console.log(`Wrote sharded, sorted JSONL files to ${OUT_DIR} and checkpoint to ${CHECKPOINT_PATH}`);
