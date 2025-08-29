// pull.js
// Flow:
/*
1. Pull proxy list from Download Link
2. Create pool of proxies
3. Create pool of URLs
4. Go through and download each URL through a rotated proxy
 */

/* -------------------- IMPORTS -------------------- */
import { request, ProxyAgent } from "undici";
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

const totalTasks = (maxX - minX + 1) * (maxY - minY + 1);

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

	// console.log(
	// 	"latency",
	// 	latencyBuckets,
	// 	"status",
	// 	statusCounts,
	// 	"errors",
	// 	errorCount,
	// 	"proxies",
	// 	active,
	// );

	for (const k of Object.keys(latencyBuckets)) delete latencyBuckets[k];
	for (const k of Object.keys(statusCounts)) delete statusCounts[+k];
	errorCount = 0;

	perProxy.clear();
}, 5000).unref();

/* -------------------- GET PROXIES -------------------- */

async function fetchWithRetry(url: string, maxRetries = 3): Promise<Response> {
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			console.log(`Fetching proxies (attempt ${attempt}/${maxRetries})...`);

			const proxyRequest = await fetch(url, {
				// Use signal for timeout (standard fetch API)
				signal: AbortSignal.timeout(30000), // 30 seconds total timeout
			});

			if (!proxyRequest.ok) {
				throw new Error(`HTTP ${proxyRequest.status}: ${proxyRequest.statusText}`);
			}

			return proxyRequest; // Explicitly return the response
		} catch (error) {
			console.error(`Attempt ${attempt} failed:`, error.message);

			if (attempt === maxRetries) {
				throw error; // Final attempt failed
			}

			// Wait before retrying (exponential backoff)
			const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
			console.log(`Retrying in ${delay}ms...`);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	// This should never be reached due to the throw above, but TypeScript needs it
	throw new Error("All retry attempts failed");
}

const proxyRequest = await fetchWithRetry(proxyListURL);
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

function createTaskFromCoords(coords: { x: number; y: number }): Task {
	const url = wPlaceURL.replace("{x}", coords.x.toString()).replace("{y}", coords.y.toString());
	return {
		status: "pending",
		url,
		coords,
		attempts: 0,
		nextEarliestAt: 0,
	};
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

function* generateTaskCoords() {
	for (let x = minX; x <= maxX; x++) {
		for (let y = minY; y <= maxY; y++) {
			yield { x, y };
		}
	}
}

const taskGenerator = generateTaskCoords();
const activeTasks = new Map<string, Task>(); // Only store active/retry tasks
const maxActiveTasks = concurrency * 3; // Buffer for retries
const completedStats = { done: 0, failed: 0, files: 0 };
let generatorExhausted = false;

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
	const values = [...activeTasks.values()];
	const activeCount = values.filter((t) =>
		["pending", "queued", "running"].includes(t.status),
	).length;

	let perDone = 0;
	const currentDone = completedStats.done;
	if (currentDone > lastCountDone) {
		perDone = Math.round((currentDone - lastCountDone) / 5);
		lastCountDone = currentDone;
	}

	const totalRemaining = totalTasks - completedStats.done - completedStats.failed;
	const etaMs = perDone > 0 ? (totalRemaining / perDone) * SECOND : 0;

	console.log(
		`${perDone} per second, ${activeCount} active, ${totalRemaining} remaining, ${
			completedStats.files
		} files, est ${formattedTime(etaMs)}`,
	);

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
		// Fill up active tasks from generator
		while (activeTasks.size < maxActiveTasks && !generatorExhausted) {
			const next = taskGenerator.next();
			if (next.done) {
				generatorExhausted = true;
				break;
			}
			const task = createTaskFromCoords(next.value);
			activeTasks.set(task.url, task);
		}

		// Clean up completed tasks
		for (const [url, task] of activeTasks.entries()) {
			if (task.status === "done") {
				if (task.code === 200) completedStats.files++;
				completedStats.done++;
				activeTasks.delete(url);
			} else if (task.status === "error") {
				completedStats.failed++;
				activeTasks.delete(url);
			}
		}

		// If no active tasks and generator is done, we're finished
		if (activeTasks.size === 0 && generatorExhausted) break;

		// Schedule pending tasks
		for (const task of activeTasks.values()) {
			if (task.status === "pending" && Date.now() >= task.nextEarliestAt) {
				scheduleTask(task);
			}
		}

		await new Promise((r) => setTimeout(r, 50));
	}

	console.log(
		`All tasks finished. Done=${completedStats.done}, Failed=${completedStats.failed}, Files=${completedStats.files}`,
	);
}

runAll();
