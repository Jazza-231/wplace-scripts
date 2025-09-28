import { configDotenv } from "dotenv";
import fs from "fs";
import Bottleneck from "bottleneck";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const MINUTE = 60 * 1000;
const OUT_PATH = "./credits.json";

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
type PixelEmpty = {
	paintedBy: {
		id: 0;
		name: "";
		allianceId: 0;
		allianceName: "";
		equippedFlag: 0;
	};
	region: {
		id: number;
		cityId: number;
		name: string;
		number: number;
		countryId: number;
	};
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

	proxyRequestList = proxyRequestList.splice(0, 100); // Limit for now

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

function isPixel(value: any): value is PixelPainted | PixelEmpty {
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

function isPainted(value: PixelPainted | PixelEmpty): value is PixelPainted {
	return value.paintedBy.id !== 0;
}

const topLeft: Coord = {
	tileX: 1069,
	tileY: 670,
	pixelX: 184,
	pixelY: 606,
};
const bottomRight: Coord = {
	tileX: 1069,
	tileY: 671,
	pixelX: 912,
	pixelY: 334,
};

const coordGenerator = function* (topLeft: Coord, bottomRight: Coord): Generator<Coord> {
	for (let tileY = topLeft.tileY; tileY <= bottomRight.tileY; tileY++) {
		for (let tileX = topLeft.tileX; tileX <= bottomRight.tileX; tileX++) {
			const startPixelX = tileX === topLeft.tileX ? topLeft.pixelX : 0;
			const endPixelX = tileX === bottomRight.tileX ? bottomRight.pixelX : 1000;
			const startPixelY = tileY === topLeft.tileY ? topLeft.pixelY : 0;
			const endPixelY = tileY === bottomRight.tileY ? bottomRight.pixelY : 1000;

			for (let pixelY = startPixelY; pixelY < endPixelY; pixelY++) {
				for (let pixelX = startPixelX; pixelX < endPixelX; pixelX++) {
					yield { tileX, tileY, pixelX, pixelY };
				}
			}
		}
	}
};

const coords = [...coordGenerator(topLeft, bottomRight)];
const numberOfCoords = coords.length;

const credits: Record<
	number,
	{
		id: number;
		name: string;
		allianceId: number;
		allianceName: string;
		equippedFlag: number;
		picture: string;
		paintedPixelsCount: number;
	}
> = {};

console.log("Fetching proxies...");
const proxies = await getProxies();

console.log(`Using ${proxies.length} proxies...`);
console.log(`Checking ${numberOfCoords} coords...`);

const limiter = new Bottleneck({
	maxConcurrent: proxies.length,
	minTime: Math.floor(410 / proxies.length),
});

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
		"300",
		"--connect-timeout",
		"100",
		"--proxy",
		proxyUrl,
		...headersToCurlArgs(headers),
		url,
	];

	try {
		const { stdout } = await execFileAsync("curl", baseArgs, {
			encoding: "utf8",
			timeout: 450_000,
			maxBuffer: 10 * 1024 * 1024,
		});

		if (!stdout) throw new Error("Empty response body");
		const text = stdout.trim();
		return JSON.parse(text);
	} catch (err: any) {
		throw err;
	}
}

const COUNT = 300;

const tasks: Promise<void>[] = [];

for (let i = 0; i < Math.min(COUNT, numberOfCoords); i++) {
	tasks.push(
		limiter.schedule(async () => {
			const coord = coords[i];
			const url = `https://backend.wplace.live/s0/pixel/${coord.tileX}/${coord.tileY}?x=${coord.pixelX}&y=${coord.pixelY}`;

			console.log(`Checking ${i + 1} of ${numberOfCoords}`);

			const proxy = pickNextProxy(proxies);
			const headers = getHeaders();

			try {
				const data = await curlJson(url, proxy, headers);

				if (data && isPixel(data)) {
					if (isPainted(data)) {
						const key = data.paintedBy.id;
						if (key in credits) {
							credits[key].paintedPixelsCount++;
						} else {
							credits[key] = {
								id: data.paintedBy.id,
								name: data.paintedBy.name,
								allianceId: data.paintedBy.allianceId,
								allianceName: data.paintedBy.allianceName,
								equippedFlag: data.paintedBy.equippedFlag,
								picture: data.paintedBy.picture,
								paintedPixelsCount: 1,
							};
						}
					}
				}
			} catch (err: any) {
				console.error(`curl error via ${proxy}:`, err?.message || err);
			}
		}),
	);
}

await Promise.all(tasks);

const sortedCredits = Object.entries(credits)
	.sort((a, b) => b[1].paintedPixelsCount - a[1].paintedPixelsCount)
	.map(([_, v]) => v);

fs.writeFileSync(OUT_PATH, JSON.stringify(sortedCredits, null, 2), { encoding: "utf-8" });
console.log(`Wrote ${OUT_PATH}`);
