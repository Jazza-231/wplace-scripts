import { configDotenv } from "dotenv";
import { ProxyAgent, request } from "undici";
import fs from "fs";
import Bottleneck from "bottleneck";

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

	const proxyRequest = await fetch(proxyListURL);
	const proxyText = (await proxyRequest.text()).trim();

	let proxyRequestList = proxyText
		.split("\r\n")
		.map((proxy) => proxy.split(":"))
		.map((proxy) => {
			let [ip, port, username, password] = proxy;

			return {
				ip,
				port,
				username,
				password,
			};
		});

	proxyRequestList = proxyRequestList.splice(0, 20); // Limit to first 20 proxies

	const proxyURLTemplate = "http://{username}:{password}@{ip}:{port}";

	return proxyRequestList.map((proxy) => {
		return proxyURLTemplate
			.replace("{username}", proxy.username)
			.replace("{password}", proxy.password)
			.replace("{ip}", proxy.ip)
			.replace("{port}", proxy.port);
	});
}

let currentProxyIndex = 0;
function pickNextProxy(proxies: string[]) {
	const proxy = proxies[currentProxyIndex];
	currentProxyIndex++;
	if (currentProxyIndex >= proxies.length) currentProxyIndex = 0;
	return proxy;
}

const agentByProxy = new Map<string, ProxyAgent>();

function getAgent(proxyURI: string) {
	let agent = agentByProxy.get(proxyURI);
	if (!agent) {
		agent = new ProxyAgent({
			uri: proxyURI,
			connections: 64,
			pipelining: 8,
			keepAliveTimeout: 5 * MINUTE,
			keepAliveMaxTimeout: 5 * MINUTE,
			connectTimeout: MINUTE,
			autoSelectFamily: true,
			connect: { timeout: MINUTE },
		});
		agentByProxy.set(proxyURI, agent);
	}
	return agent;
}

function getHeaders() {
	const headers = {
		"User-Agent":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		Accept: "application/json",
		"Accept-Language": "en-AU,en;q=0.9",
		"Accept-Encoding": "gzip, deflate",
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

// https://backend.wplace.live/s0/pixel/1069/671?x=912&y=334

const limiter = new Bottleneck({
	maxConcurrent: proxies.length,
	// minTime: Math.floor(410 / proxies.length),
	minTime: Math.floor(410),
});

for (let i = 0; i < 100; i++) {
	limiter.schedule(async () => {
		const coord = coords[i];
		const url = `https://backend.wplace.live/s0/pixel/${coord.tileX}/${coord.tileY}?x=${coord.pixelX}&y=${coord.pixelY}`;

		console.log(`Checking ${i + 1} of ${numberOfCoords}`);

		try {
			const dispatcher = getAgent(pickNextProxy(proxies));
			const headers = getHeaders();

			const response = await request(url, {
				dispatcher,
				headers,
			});

			if (response.statusCode === 200) {
				const data = await response.body.json();

				if (data && isPixel(data)) {
					if (isPainted(data)) {
						// Painted pixel
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
			} else {
				console.log(response.statusCode);
			}
		} catch (err) {
			console.error(err);
		}
	});
}

console.log(credits);

fs.writeFileSync(OUT_PATH, JSON.stringify(credits, null, 2), { encoding: "utf-8" });
