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
import { pipeline } from "stream/promises";
import { Readable } from "stream";

/* -------------------- GLOBALS -------------------- */
const proxyListURL =
	"https://proxy.webshare.io/api/v2/proxy/list/download/ipqdzaeydnckvkfpjhtwzfwjswdfnffznqhyalqx/-/any/username/direct/-/?plan_id=11758104";
const basePath = "C:/Users/jazza/Downloads/wplace/";
const wPlaceURL = "https://backend.wplace.live/files/s0/tiles/{x}/{y}.png";

const argsArr = process.argv.slice(2);

function parseArg(arg: string) {
	const argRegex = /^--(\w+)=(.+)$/;
	if (!argRegex.test(arg)) return null;

	const argName = arg.replace(argRegex, "$1");
	const argValue = +arg.replace(argRegex, "$2");

	return { [argName]: argValue };
}

const args = argsArr
	.map(parseArg)
	.filter((a) => a)
	.reduce((a, b) => ({ ...a, ...b }), {});

// INCLUSIVE
const minX = args?.minX ?? 0;
const maxX = args?.maxX ?? 2047;
const minY = args?.minY ?? 0;
const maxY = args?.maxY ?? 2047;

const concurrency = 800;
const minTime = 0;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/* -------------------- TELEMETRY -------------------- */

const perProxy = new Map<string, { ok: number; fourxx: number; fivexx: number }>();

function bump(proxy: string, code: number) {
	const s = perProxy.get(proxy) ?? { ok: 0, fourxx: 0, fivexx: 0 };
	if (code >= 200 && code < 300) s.ok++;
	else if (code >= 400 && code < 500) s.fourxx++;
	else if (code >= 500) s.fivexx++;
	perProxy.set(proxy, s);
}

const latencyBuckets: Record<string, number> = {};
const statusCounts: Record<number, number> = {};
let errorCount = 0;

setInterval(() => {
	const active = [...perProxy.entries()].filter(([, s]) => s.ok + s.fourxx + s.fivexx > 0).length;

	console.log(
		"latency",
		latencyBuckets,
		"status",
		statusCounts,
		"errors",
		errorCount,
		"proxies",
		active,
	);
	for (const k of Object.keys(latencyBuckets)) delete latencyBuckets[k];
	for (const k of Object.keys(statusCounts)) delete statusCounts[+k];
	errorCount = 0;

	perProxy.clear();
}, 5000).unref();

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

/* -------------------- HELPERS -------------------- */
function getRandomProxy() {
	const randomIndex = Math.floor(Math.random() * numberOfProxies);
	return proxies[randomIndex];
}

let proxyIdx = 0;
function getNextProxy() {
	return proxies[proxyIdx++ % proxies.length];
}

function pathFromCoords(coords: { x: number; y: number }) {
	return {
		filePath: path.join(basePath, "tiles", String(coords.x)),
		fileName: `${coords.y}.png`,
	};
}

const createdDirs = new Set<string>();
async function ensureDirOnce(dir: string) {
	if (createdDirs.has(dir)) return;
	await fs.promises.mkdir(dir, { recursive: true });
	createdDirs.add(dir);
}

const errorBuf: string[] = [];
function logErrorTask(t: Task) {
	errorBuf.push(JSON.stringify(t));
}
setInterval(() => {
	if (!errorBuf.length) return;
	const payload = errorBuf.splice(0).join("\n") + "\n";
	fs.promises
		.mkdir(path.join(basePath, "logs"), { recursive: true })
		.then(() => fs.promises.appendFile(path.join(basePath, "logs", "errors.ndjson"), payload));
}, 5000).unref();

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

/* -------------------- DOWNLOAD URLS -------------------- */
const limiter = new Bottleneck({
	maxConcurrent: concurrency,
	minTime,
});

function downloadURL(url: string): Promise<{ code: number; body?: Readable }> {
	return new Promise((resolve, reject) => {
		const proxy = getNextProxy();
		const proxyAgent = getAgent(proxy);

		const t0 = Date.now();

		request(url, { dispatcher: proxyAgent })
			.then(async (response) => {
				const code = response.statusCode;

				const dt = Date.now() - t0;
				const b = dt < 1000 ? "<1s" : dt < 3000 ? "1-3s" : dt < 7000 ? "3-7s" : ">=7s";

				latencyBuckets[b] = (latencyBuckets[b] ?? 0) + 1;
				statusCounts[code] = (statusCounts[code] ?? 0) + 1;

				bump(proxy, code);

				switch (code) {
					case 200:
						resolve({ code, body: response.body as Readable });
						break;

					default:
						resolve({ code });
						break;
				}
			})
			.catch((err) => {
				errorCount++;

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
			const { code, body } = await downloadURL(task.url);

			if (code === 200 && body) {
				// Success!
				const { filePath, fileName } = pathFromCoords(task.coords);
				const dest = path.join(filePath, fileName);

				await pipeline(body, fs.createWriteStream(dest, { highWaterMark: 1 << 20 }));

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

		logErrorTask(task);
		return;
	}

	// Back off for a wee bit
	const delay = computeDelay(task.attempts);
	task.status = "pending";
	task.nextEarliestAt = Date.now() + delay;
}

let lastCountDone = 0;

setInterval(() => {
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
}, 5 * SECOND).unref();

// --- Pull loop ---
async function runAll() {
	for (let x = minX; x <= maxX; x++) {
		await ensureDirOnce(path.join(basePath, "tiles", String(x)));
	}

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

	const values = [...tasks.values()];

	const done = values.filter((t) => t.status === "done").length;
	const failed = values.filter((t) => t.status === "error").length;
	const twoHundreds = values.filter((t) => t.code === 200).length;

	console.log(`All tasks finished. Done=${done}, Failed=${failed}, Files=${twoHundreds}`);

	return;
}

runAll();
