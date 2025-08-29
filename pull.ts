// pull.js
// Flow:
/*
1. Pull proxy list from Download Link
2. Create pool of proxies
3. Create pool of URLs
4. Go through and download each URL through a rotated proxy
 */

/* -------------------- IMPORTS -------------------- */
import { fetch, request, ProxyAgent } from "undici";
import fs from "fs";
import path from "path";
import Bottleneck from "bottleneck";

/* -------------------- GLOBALS -------------------- */
const proxyListURL =
	"https://proxy.webshare.io/api/v2/proxy/list/download/ipqdzaeydnckvkfpjhtwzfwjswdfnffznqhyalqx/-/any/username/direct/-/?plan_id=11758104";
const basePath = "C:/Users/jazza/Downloads/wplace/";
const wPlaceURL = "https://backend.wplace.live/files/s0/tiles/{x}/{y}.png";

// INCLUSIVE
const minX = 0;
const maxX = 9;
const minY = 0;
const maxY = 2047;

const concurrency = 400;
const minTime = 1;

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/* -------------------- GET PROXIES -------------------- */

console.log("Fetching proxies...");

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

const proxyURLTemplate = "http://{username}:{password}@{ip}:{port}";

const proxies = proxyRequestList.map((proxy) => {
	return proxyURLTemplate
		.replace("{username}", proxy.username)
		.replace("{password}", proxy.password)
		.replace("{ip}", proxy.ip)
		.replace("{port}", proxy.port);
});

writeCreate(path.join(basePath, "logs", "proxies.json"), JSON.stringify(proxies));

console.log(`Fetched ${proxies.length} proxies`);

/* -------------------- HELPERS -------------------- */
function getRandomProxy() {
	const randomIndex = Math.floor(Math.random() * proxies.length);
	return proxies[randomIndex];
}

function wPlaceURLToPath(url: string) {
	const urlRegex = /https:\/\/backend\.wplace\.live\/files\/s0\/tiles\/(\d+)\/(\d+)\.png/;
	const match = urlRegex.exec(url);

	if (match) {
		const [, x, y] = match;

		const filePath = path.join(basePath, `tiles/${x}`);
		const fileName = `${y}.png`;
		return { filePath, fileName };
	}

	throw new Error("Invalid URL");
}

function wPlaceURLToCoords(url: string) {
	const urlRegex = /https:\/\/backend\.wplace\.live\/files\/s0\/tiles\/(\d+)\/(\d+)\.png/;
	const match = urlRegex.exec(url);

	if (match) {
		const [, x, y] = match;
		return { x, y };
	}

	throw new Error("Invalid URL");
}

function writeCreate(filePath: string, fileContents: string | Buffer) {
	const dirPath = path.dirname(filePath);

	if (!fs.existsSync(dirPath)) {
		fs.mkdirSync(dirPath, { recursive: true });
	}

	fs.writeFileSync(filePath, fileContents);
}

/* -------------------- MAKE URLS -------------------- */
const wPlaceURLs: string[] = [];

for (let x = minX; x <= maxX; x++) {
	for (let y = minY; y <= maxY; y++) {
		const url = wPlaceURL.replace("{x}", x.toString()).replace("{y}", y.toString());
		wPlaceURLs.push(url);
	}
}

/* -------------------- DOWNLOAD URLS -------------------- */
const limiter = new Bottleneck({
	maxConcurrent: concurrency,
	minTime,
});

function downloadURL(url: string): Promise<{ code: number; buffer?: Buffer }> {
	return new Promise((resolve, reject) => {
		const proxyAgent = new ProxyAgent({
			uri: getRandomProxy(),
			keepAliveTimeout: MINUTE,
			keepAliveMaxTimeout: 5 * MINUTE,
			connectTimeout: MINUTE,
			autoSelectFamily: true,
			connect: { timeout: MINUTE },
		});

		request(url, { dispatcher: proxyAgent })
			.then(async (response) => {
				const code = response.statusCode;

				switch (code) {
					case 200:
						resolve({ code, buffer: Buffer.from(await response.body.arrayBuffer()) });
						break;

					default:
						resolve({ code });
						break;
				}
			})
			.catch((err) => {
				reject({ err });
			});
	});
}

for (const wPlaceURL of wPlaceURLs) {
	const coords = wPlaceURLToCoords(wPlaceURL);

	limiter.schedule(() =>
		downloadURL(wPlaceURL)
			.then(({ code, buffer }) => {
				if (code === 200 && buffer) {
					console.log(`200 on ${coords.x}/${coords.y}`);

					const pathData = wPlaceURLToPath(wPlaceURL);
					const { filePath, fileName } = pathData;
					const filePathWithName = path.join(filePath, fileName);

					writeCreate(filePathWithName, buffer);
				} else if (code === 404) {
					console.log(`404 on ${coords.x}/${coords.y}`);
				} else {
					console.error(`Error ${code} on ${coords.x}/${coords.y}`);
				}
			})
			.catch((err) => {
				console.error(`Error ${coords.x}/${coords.y}`);
				console.error(err);
			}),
	);
}
