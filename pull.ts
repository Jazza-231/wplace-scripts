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
const maxX = 4;
const minY = 0;
const maxY = 2047;

const concurrency = 800;
const minTime = 1;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

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

const numberOfProxies = proxies.length;

writeCreate(path.join(basePath, "logs", "proxies.json"), JSON.stringify(proxies));

console.log(`Fetched ${numberOfProxies} proxies`);

const agentByProxy = new Map<string, ProxyAgent>();

function getAgent(proxyURI: string) {
	let agent = agentByProxy.get(proxyURI);
	if (!agent) {
		agent = new ProxyAgent({
			uri: proxyURI,
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

/* -------------------- HELPERS -------------------- */
function getRandomProxy() {
	const randomIndex = Math.floor(Math.random() * numberOfProxies);
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

function writeCreate(filePath: string, fileContents: string | Buffer) {
	const dirPath = path.dirname(filePath);

	if (!fs.existsSync(dirPath)) {
		fs.mkdirSync(dirPath, { recursive: true });
	}

	fs.writeFileSync(filePath, fileContents);
}

function formattedTime(ms: number) {
	if (ms < SECOND) return `${ms.toFixed(0)}ms`;
	if (ms < MINUTE) return `${(ms / SECOND).toFixed(0)}s`;
	if (ms < HOUR) return `${(ms / MINUTE).toFixed(0)}m`;
	return `${(ms / HOUR).toFixed(0)}h`;
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
		const proxyAgent = getAgent(getRandomProxy());

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

type TaskStatus = "pending" | "queued" | "running" | "done" | "error";

interface Task {
	status: TaskStatus;
	url: string;
	coords: { x: number; y: number };
	attempts: number;
	nextEarliestAt: number;
	leaseUntil?: number;
	code?: number;
	err?: any;
}

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 400;
const BACKOFF = 1.6;
const JITTER_MS = 200;
const LEASE_MS = MINUTE;

function computeDelay(attempt: number) {
	const backoffDelay = BASE_DELAY_MS * Math.pow(BACKOFF, Math.max(0, attempt - 1));
	const jitter = Math.floor(Math.random() * JITTER_MS);
	return backoffDelay + jitter;
}

const tasks = new Map<string, Task>();

for (let x = minX; x <= maxX; x++) {
	for (let y = minY; y <= maxY; y++) {
		const url = wPlaceURL.replace("{x}", x.toString()).replace("{y}", y.toString());
		tasks.set(url, {
			status: "pending",
			url,
			coords: { x, y },
			attempts: 0,
			nextEarliestAt: 0,
		});
	}
}

async function scheduleTask(task: Task) {
	if (task.status !== "pending") return;
	if (Date.now() < task.nextEarliestAt) return;

	// Task is mine now
	task.status = "queued";

	await limiter.schedule(async () => {
		task.status = "running";
		task.leaseUntil = Date.now() + LEASE_MS;

		try {
			const { code, buffer } = await downloadURL(task.url);

			if (code === 200 && buffer) {
				// Success!
				const pathData = wPlaceURLToPath(task.url);
				const { filePath, fileName } = pathData;
				const filePathWithName = path.join(filePath, fileName);
				writeCreate(filePathWithName, buffer);

				task.status = "done";
				task.code = code;
				return;
			}

			if (code === 404) {
				// 404 is ok! Means there is no tile there
				task.status = "done";
				task.code = 404;
				return;
			}

			// console.error(
			// 	`Error ${code} on ${task.coords.x}/${task.coords.y} attempt ${task.attempts + 1}`,
			// );
			retryTask(task, code);
		} catch (err) {
			// Network / thrown errors
			// console.error(`Error ${task.coords.x}/${task.coords.y} attempt ${task.attempts + 1}`);
			// console.error(err);

			retryTask(task, err);
		}
	});
}

function retryTask(task: Task, err: any) {
	task.attempts++;
	task.err = err;

	if (task.attempts >= MAX_ATTEMPTS) {
		// Give up on life
		task.status = "error";

		writeCreate(
			path.join(basePath, `logs`, `error-${task.coords.x}/${task.coords.y}.log`),
			JSON.stringify(task),
		);
		return;
	}

	// Back off for a wee bit
	const delay = computeDelay(task.attempts);
	task.status = "pending";
	task.nextEarliestAt = Date.now() + delay;
}

let lastCountDone = 0;

const interval = setInterval(() => {
	const values = [...tasks.values()];
	const doneCount = values.filter((t) => t.status === "done").length;
	const remaining = values.filter((t) =>
		["pending", "queued", "running"].includes(t.status),
	).length;

	let perDone = 0;
	if (doneCount > lastCountDone) {
		perDone = Math.round((doneCount - lastCountDone) / 5);
		lastCountDone = doneCount;
	}

	const etaMs = perDone > 0 ? (remaining / perDone) * SECOND : 0;

	console.log(`${perDone} per second, ${remaining} remaining, est ${formattedTime(etaMs)}`);

	const now = Date.now();
	for (const task of values) {
		if (task.status === "running" && task.leaseUntil && now > task.leaseUntil) {
			console.warn(`Reclaiming stuck task ${task.coords.x}/${task.coords.y}`);
			retryTask(task, "lease expired");
		}
	}
}, 5 * SECOND);

// --- Pull loop ---
async function runAll() {
	while (true) {
		let active = 0;
		for (const task of tasks.values()) {
			if (task.status === "pending" && Date.now() >= task.nextEarliestAt) {
				scheduleTask(task);
			}
			if (["pending", "queued", "running"].includes(task.status)) active++;
		}

		if (active === 0) break;
		await new Promise((r) => setTimeout(r, 50));
	}

	clearInterval(interval);

	const values = [...tasks.values()];

	const done = values.filter((t) => t.status === "done").length;
	const failed = values.filter((t) => t.status === "error").length;
	const twoHundreds = values.filter((t) => t.code === 200).length;

	console.log(`All tasks finished. Done=${done}, Failed=${failed}, Files=${twoHundreds}`);

	return;
}

runAll();
