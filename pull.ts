/* -------------------- IMPORTS -------------------- */
import { request, ProxyAgent } from "undici";
import fs from "fs";
import path from "path";
import Bottleneck from "bottleneck";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { configDotenv } from "dotenv";
import { DEFAULT_CONFIG } from "./config";

configDotenv({ quiet: true });

/* -------------------- GLOBALS -------------------- */
// This WAS a real hardcoded URL, but it's now in my .env, and it has been re-rolled, so git history won't leak a working URL
const proxyListURL = process.env.PROXY_LIST_URL;
if (!proxyListURL) throw new Error("PROXY_LIST_URL not set");

const WP_WPLACE_PATH = process.env.WP_WPLACE_PATH;
const WP_CONCURRENT = process.env.WP_CONCURRENT;

if (!(WP_WPLACE_PATH && WP_CONCURRENT)) {
	console.error(
		"Environment variables failed to be set by run-pull.ts - defaults are passed this way",
	);
	process.exit(1);
}

const wPlacePath = WP_WPLACE_PATH;
const wPlaceURL = "https://backend.wplace.live/files/s0/tiles/{x}/{y}.png";

const { minX, maxX, minY, maxY } = DEFAULT_CONFIG.TILE_BOUNDS;

const totalTasks = (maxX - minX + 1) * (maxY - minY + 1);

const concurrency = parseInt(WP_CONCURRENT);
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
	for (const k of Object.keys(latencyBuckets)) delete latencyBuckets[k];
	for (const k of Object.keys(statusCounts)) delete statusCounts[+k];
	errorCount = 0;

	perProxy.clear();
}, 5000).unref();

/* -------------------- GET PROXIES -------------------- */
async function fetchWithRetry(url: string, maxRetries = 10): Promise<Response> {
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			console.log(`Fetching proxies (attempt ${attempt}/${maxRetries})...`);

			const proxyRequest = await fetch(url, {
				signal: AbortSignal.timeout(30 * SECOND),
			});

			if (!proxyRequest.ok) {
				throw new Error(`HTTP ${proxyRequest.status}: ${proxyRequest.statusText}`);
			}

			return proxyRequest;
		} catch (error) {
			if (error instanceof Error) console.error(`Attempt ${attempt} failed:`, error.message);
			else console.error(`Attempt ${attempt} failed:`, error);

			if (attempt === maxRetries) {
				throw error;
			}

			const delay = Math.min(2000 * Math.pow(2, attempt - 1), 30 * SECOND);
			console.log(`Retrying in ${delay}ms...`);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

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

writeCreate(path.join(wPlacePath, "logs", "proxies.json"), JSON.stringify(proxies));

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
let proxyIdx = 0;
function getNextProxy() {
	return proxies[proxyIdx++ % proxies.length];
}

function pathFromCoords(coords: { x: number; y: number }) {
	return {
		filePath: path.join(wPlacePath, "tiles", String(coords.x)),
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
		.mkdir(path.join(wPlacePath, "logs"), { recursive: true })
		.then(() => fs.promises.appendFile(path.join(wPlacePath, "logs", "errors.ndjson"), payload));
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

	if (ms < MINUTE) {
		const s = Math.floor(ms / SECOND);
		const ds = Math.floor((ms % SECOND) / 100);
		return ds ? `${s}.${ds}s` : `${s}s`;
	}

	if (ms < HOUR) {
		const m = Math.floor(ms / MINUTE);
		const s = Math.floor((ms % MINUTE) / SECOND);
		return s ? `${m}m ${s}s` : `${m}m`;
	}

	const h = Math.floor(ms / HOUR);
	const m = Math.floor((ms % HOUR) / MINUTE);
	return m ? `${h}h ${m}m` : `${h}h`;
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

		request(url, { dispatcher: proxyAgent, headersTimeout: 0.5 * MINUTE, bodyTimeout: MINUTE })
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

const MAX_ATTEMPTS = 20;
const BASE_DELAY_MS = 400;
const BACKOFF = 1.6;
const JITTER_MS = 200;
const LEASE_MS = 0.5 * MINUTE;

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
const activeTasks = new Map<string, Task>();
const maxActiveTasks = concurrency * 3;
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
		console.error(`Giving up on ${task.coords.x}/${task.coords.y} after ${task.attempts} attempts`);

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
		} files, ${completedStats.failed} failed, est ${formattedTime(etaMs)}`,
	);

	const now = Date.now();
	for (const task of values) {
		if (
			(task.status === "running" || task.status === "queued") &&
			task.leaseUntil &&
			now > task.leaseUntil
		) {
			console.warn(`Reclaiming stuck task ${task.coords.x}/${task.coords.y}`);
			retryTask(task, "lease expired");
		}
	}
}, 5 * SECOND).unref();

// --- Pull loop ---
async function runAll() {
	for (let x = minX; x <= maxX; x++) {
		await ensureDirOnce(path.join(wPlacePath, "tiles", String(x)));
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
