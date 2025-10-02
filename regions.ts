import { configDotenv } from "dotenv";
import fs from "fs";
import Bottleneck from "bottleneck";
import { execFile } from "child_process";
import { promisify } from "util";
import ms from "ms";

const execFileAsync = promisify(execFile);

const OUT_PATH = "./regions.json";

export {};
configDotenv({ quiet: true });

type Coord = {
	tileX: number;
	tileY: number;
	pixelX: number;
	pixelY: number;
};

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
	const headers = {
		"User-Agent":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		Accept: "application/json",
		"Accept-Language": "en-AU,en;q=0.9",
		Referer: "https://wplace.live/",
		Origin: "https://wplace.live",
	};

	return headers;
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

function* getCoords(): Generator<Coord> {
	for (let tileY = 0; tileY < 2048; tileY++) {
		for (let tileX = 0; tileX < 2048; tileX++) {
			yield { tileX, tileY, pixelX: 0, pixelY: 0 };
		}
	}
}

const coordsGen = getCoords();
const numberOfCoords = 2048 ** 2;

const regions: {
	id: number;
	cityId: number;
	name: string;
	number: number;
	countryId: number;
	coord: Coord;
}[] = [];

console.log("Fetching proxies...");
const proxies = await getProxies();

console.log(`Using ${proxies.length} proxies...`);

const limiter = new Bottleneck({
	maxConcurrent: proxies.length,
	minTime: Math.floor(370 / proxies.length),
});

// Doing this cuz I may need to go back to an undici-based solution
function headersToCurlArgs(headers: Record<string, string>): string[] {
	const args: string[] = [];
	if (headers["User-Agent"]) {
		args.push("--user-agent", headers["User-Agent"]);
	}
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

	try {
		const { stdout } = await execFileAsync("curl", baseArgs, {
			encoding: "utf8",
			timeout: 45_000,
			maxBuffer: 10 * 1024 * 1024,
		});

		if (!stdout) throw new Error("Empty response body");
		const text = stdout.trim();
		return JSON.parse(text);
	} catch (err: any) {
		throw err;
	}
}

const COUNT = numberOfCoords;
console.log(`Checking ${COUNT} coords...`);

const WORKERS = Math.min(128, COUNT);

let processed = 0;

const start = Date.now();

async function processCoord(coord: {
	tileX: number;
	tileY: number;
	pixelX: number;
	pixelY: number;
}) {
	const url = `https://backend.wplace.live/s0/pixel/${coord.tileX}/${coord.tileY}?x=${coord.pixelX}&y=${coord.pixelY}`;
	const headers = getHeaders();

	while (true) {
		const proxy = pickNextProxy(proxies);
		try {
			const data = await curlJson(url, proxy, headers);
			if (data && isPixel(data)) {
				regions.push({ ...data.region, coord });
			}
			break;
		} catch (err: any) {
			console.error(`curl error via ${proxy}:`, err?.message || err);
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

		if (processed % 1000 === 0) {
			const elapsedMs = Date.now() - start;
			const percent = (processed / COUNT) * 100;
			const rate = processed > 0 ? elapsedMs / processed : Infinity;
			const remainingMs = isFinite(rate) ? rate * (COUNT - processed) : Infinity;

			console.log(
				`Checked ${processed}/${COUNT} (${percent.toFixed(2)}%) - elapsed ${ms(elapsedMs, {
					long: true,
				})} - remaining ~${isFinite(remainingMs) ? ms(remainingMs, { long: true }) : "unknown"}`,
			);

			fs.writeFileSync(OUT_PATH, JSON.stringify(regions, null, 2), {
				encoding: "utf-8",
			});
		}
	}
}

const workers: Promise<void>[] = [];
for (let i = 0; i < WORKERS; i++) {
	workers.push(worker());
}

await Promise.all(workers);

const end = Date.now();
const totalMs = end - start;
console.log(
	`Done in ${ms(totalMs, {
		long: true,
	})} - processed ${processed}/${COUNT} (100.00%) - remaining ~00:00:00`,
);

const sortedRegions = regions.sort(
	(a, b) => a.coord.tileX - b.coord.tileX || a.coord.tileY - b.coord.tileY,
);

fs.writeFileSync(OUT_PATH, JSON.stringify(sortedRegions, null, 2), { encoding: "utf-8" });
console.log(`Wrote ${OUT_PATH}`);
