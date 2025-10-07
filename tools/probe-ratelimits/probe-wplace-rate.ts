// probe-wplace-rate.ts
// DISCLAIMER: AI GENERATED, CHATGPT 5
import fs from "fs";

type Event = {
	t: number;
	status: number;
	retryAfterSec?: number;
};

type Heuristics = {
	minIntervalMsEstimate?: number;
	perSecond?: { estimate?: number; confidence: number };
	perMinute?: { estimate?: number; confidence: number };
	combined?: { perSecond?: number; perMinute?: number };
	notes: string[];
};

const OUT_PATH = "./wplace_ratelimit_probe.json";

const BASE = "https://backend.wplace.live";
const SHARD = "s0";
const BURST_TARGET_RPS = 25;
const WRITE_INTERVAL_MS = 1000;
const MAX_TIMELINE = 2000;

const WINDOWS_MS = [1000, 5000, 10000, 60000];

const timeline: Event[] = [];
const successTimes: number[] = [];
const statusCounts: Record<number, number> = {};
const seenHeaders = {
	retryAfterSeconds: [] as number[],
	xRateLimit: {} as Record<string, string>,
};

const heuristics: Heuristics = {
	notes: [],
	perSecond: { estimate: undefined, confidence: 0 },
	perMinute: { estimate: undefined, confidence: 0 },
	combined: {},
};

let lastWrite = 0;

// spike mode (rare, gentle)
const SPIKE_MODE = true;
const SPIKE_EVERY_MS = 60_000; // once a minute
const SPIKE_DURATION_MS = 2_000; // short burst
const SPIKE_RPS = 8; // brief overshoot
let lastSpikeStart = 0;

// silent throttling diagnostics
const latencies: number[] = [];
let timeoutCount = 0;
let networkErrorCount = 0;

// stability indicator
let stableTicks = 0;
let lastEst = { ps: 0, pm: 0 };
const SMALL_DELTA_THRESHOLD = 1;

// pacing telemetry (for JSON)
let pacing_inSpike = false;
let pacing_targetRps = BURST_TARGET_RPS;
let pacing_effectiveGapMs = Math.floor(1000 / BURST_TARGET_RPS);
let pacing_nextRequestAt = Date.now();

const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

function buildUrl(): string {
	const tileX = randInt(0, 2047);
	const tileY = randInt(0, 2047);
	const x = randInt(0, 999);
	const y = randInt(0, 999);
	return `${BASE}/${SHARD}/pixel/${tileX}/${tileY}?x=${x}&y=${y}`;
}

function recordEvent(ev: Event) {
	timeline.push(ev);
	if (timeline.length > MAX_TIMELINE) timeline.splice(0, timeline.length - MAX_TIMELINE);
	statusCounts[ev.status] = (statusCounts[ev.status] ?? 0) + 1;
	if (ev.status >= 200 && ev.status < 300) successTimes.push(ev.t);
	if (successTimes.length > MAX_TIMELINE)
		successTimes.splice(0, successTimes.length - MAX_TIMELINE);
}

function parseRetryAfter(h: string | null): number | undefined {
	if (!h) return undefined;
	const n = Number(h);
	if (!Number.isNaN(n)) return n;
	return undefined;
}

function captureHeaders(res: Response) {
	const ra = parseRetryAfter(res.headers.get("retry-after"));
	if (ra !== undefined) {
		seenHeaders.retryAfterSeconds.push(ra);
		if (seenHeaders.retryAfterSeconds.length > 100) seenHeaders.retryAfterSeconds.shift();
	}
	for (const [k, v] of res.headers.entries()) {
		const lk = k.toLowerCase();
		if (lk.startsWith("x-ratelimit") || lk.includes("ratelimit")) {
			seenHeaders.xRateLimit[k] = v;
		}
	}
}

function pct(arr: number[], p: number) {
	if (arr.length === 0) return undefined;
	const a = [...arr].sort((x, y) => x - y);
	const idx = Math.min(a.length - 1, Math.max(0, Math.floor((p / 100) * a.length)));
	return a[idx];
}

function estimateMinIntervalMs() {
	if (successTimes.length < 6) return;
	const deltas: number[] = [];
	for (let i = 1; i < successTimes.length; i++) deltas.push(successTimes[i] - successTimes[i - 1]);
	const p50 = pct(deltas, 50);
	const p90 = pct(deltas, 90);
	const p95 = pct(deltas, 95);
	const candidate = p95 ?? p90 ?? p50;
	if (candidate && candidate > 0) heuristics.minIntervalMsEstimate = Math.round(candidate);
}

function countInWindow(endMs: number, windowMs: number, times: number[]) {
	const start = endMs - windowMs;
	let c = 0;
	for (let i = times.length - 1; i >= 0; i--) {
		const t = times[i];
		if (t < start) break;
		if (t <= endMs) c++;
	}
	return c;
}

function estimateWindowLimits() {
	if (successTimes.length < 10) return;

	const now = Date.now();
	const maxByWindow = new Map<number, number>();
	for (const w of WINDOWS_MS) {
		let max = 0;
		const step = Math.max(1, Math.floor(successTimes.length / 200));
		for (let i = step - 1; i < successTimes.length; i += step) {
			const t = successTimes[i];
			const c = countInWindow(t, w, successTimes);
			if (c > max) max = c;
		}
		const current = countInWindow(now, w, successTimes);
		if (current > max) max = current;
		maxByWindow.set(w, max);
	}

	const perSec = maxByWindow.get(1000);
	const perMin = maxByWindow.get(60000);

	const rlHits = statusCounts[429] ?? 0;
	const dataFactor = Math.min(1, successTimes.length / 300);
	const rlFactor = Math.min(1, rlHits / 20);
	const conf = Math.round((0.3 + 0.7 * (0.6 * dataFactor + 0.4 * rlFactor)) * 100) / 100;

	if (perSec && perSec > 0) heuristics.perSecond = { estimate: perSec, confidence: conf };
	if (perMin && perMin > 0) heuristics.perMinute = { estimate: perMin, confidence: conf };

	heuristics.combined = {
		perSecond: heuristics.perSecond?.estimate,
		perMinute: heuristics.perMinute?.estimate,
	};

	const ps = heuristics.perSecond?.estimate ?? 0;
	const pm = heuristics.perMinute?.estimate ?? 0;
	const delta = Math.abs(ps - lastEst.ps) + Math.abs(pm - lastEst.pm);
	if (delta <= SMALL_DELTA_THRESHOLD) stableTicks++;
	else stableTicks = 0;
	lastEst = { ps, pm };
}

function writeOut() {
	const now = Date.now();
	if (now - lastWrite < WRITE_INTERVAL_MS) return;
	lastWrite = now;

	estimateMinIntervalMs();
	estimateWindowLimits();

	const p50 = pct(latencies, 50);
	const p95 = pct(latencies, 95);
	const p99 = pct(latencies, 99);

	// derive "current-known safe"
	const safeRpsFromMinInterval =
		heuristics.minIntervalMsEstimate && heuristics.minIntervalMsEstimate > 0
			? 1000 / heuristics.minIntervalMsEstimate
			: undefined;

	const effectiveRps = pacing_effectiveGapMs > 0 ? 1000 / pacing_effectiveGapMs : pacing_targetRps;

	const deltaVsMinInterval =
		safeRpsFromMinInterval !== undefined ? effectiveRps - safeRpsFromMinInterval : undefined;

	const perSecondHeuristic = heuristics.perSecond?.estimate;
	const deltaVsHeuristic =
		perSecondHeuristic !== undefined ? effectiveRps - perSecondHeuristic : undefined;

	const nextSpikeAt = SPIKE_MODE
		? new Date(
				pacing_inSpike ? lastSpikeStart + SPIKE_DURATION_MS : lastSpikeStart + SPIKE_EVERY_MS,
		  ).toISOString()
		: undefined;

	const body = {
		target_pattern: `${BASE}/${SHARD}/pixel/{0..2047}/{0..2047}?x={0..999}&y={0..999}`,
		startedAt: new Date(timeline[0]?.t ?? Date.now()).toISOString(),
		updatedAt: new Date().toISOString(),
		samples: {
			totalRequests: Object.values(statusCounts).reduce((a, b) => a + b, 0),
			successes: (statusCounts[200] ?? 0) + (statusCounts[206] ?? 0) + (statusCounts[204] ?? 0),
			rateLimited429: statusCounts[429] ?? 0,
			otherErrors: Object.entries(statusCounts)
				.filter(([k]) => !["200", "204", "206", "429"].includes(k))
				.reduce((a, [, v]) => a + v, 0),
		},
		headers_observed: {
			retryAfterSeconds: seenHeaders.retryAfterSeconds.slice(-10),
			xRateLimit: seenHeaders.xRateLimit,
		},
		heuristics,
		diagnostics: {
			latencyMs: { p50, p95, p99, count: latencies.length },
			timeouts: timeoutCount,
			networkErrors: networkErrorCount,
		},
		stability: {
			stableWritesInARow: stableTicks,
			smallDeltaThreshold: SMALL_DELTA_THRESHOLD,
		},
		pacing: {
			baseTargetRps: BURST_TARGET_RPS,
			effectiveGapMs: pacing_effectiveGapMs,
			effectiveRps,
			nextRequestAt: new Date(pacing_nextRequestAt).toISOString(),
			spike: {
				enabled: SPIKE_MODE,
				inSpike: pacing_inSpike,
				spikeRps: SPIKE_RPS,
				schedule: { everyMs: SPIKE_EVERY_MS, durationMs: SPIKE_DURATION_MS },
				nextSpikeAt, // when the next push is going to be
			},
		},
		delta: {
			vsMinIntervalRps: deltaVsMinInterval, // effective - safe (min-interval-derived)
			vsHeuristicPerSecond: deltaVsHeuristic, // effective - heuristic per-second
			safeRpsFromMinInterval: safeRpsFromMinInterval,
			heuristicPerSecond: perSecondHeuristic,
			heuristicPerMinute: heuristics.perMinute?.estimate,
		},
		recentEvents: timeline.slice(-100).map((e) => ({
			t: new Date(e.t).toISOString(),
			status: e.status,
			retryAfterSec: e.retryAfterSec,
		})),
	};

	try {
		fs.writeFileSync(OUT_PATH, JSON.stringify(body, null, 2), "utf8");
	} catch {}
}

async function sleep(ms: number) {
	return new Promise((res) => setTimeout(res, ms));
}

async function probeLoop() {
	while (true) {
		const url = buildUrl();
		const t0 = Date.now();

		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 8000);

			const res = await fetch(url, {
				method: "GET",
				redirect: "follow",
				signal: controller.signal,
				headers: {
					"User-Agent": "wplace-ratelimit-probe/1.2 (+https://jazza.dev)",
					Accept: "application/json",
				},
			}).finally(() => clearTimeout(timeout));

			captureHeaders(res);

			// fully consume the response (JSON endpoint)
			try {
				await res.text();
			} catch {}

			const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
			latencies.push(Date.now() - t0);
			if (latencies.length > 2000) latencies.shift();

			recordEvent({ t: Date.now(), status: res.status, retryAfterSec: retryAfter });
			writeOut();

			if (res.status === 429 && retryAfter !== undefined && retryAfter > 0) {
				// hard backoff as instructed
				pacing_inSpike = false;
				pacing_targetRps = BURST_TARGET_RPS;
				pacing_effectiveGapMs = retryAfter * 1000;
				pacing_nextRequestAt = Date.now() + pacing_effectiveGapMs;
				await sleep(retryAfter * 1000);
			} else {
				// pacing with rare spikes
				const now = Date.now();
				const needStartSpike = SPIKE_MODE && now - lastSpikeStart > SPIKE_EVERY_MS;
				pacing_inSpike =
					SPIKE_MODE &&
					(needStartSpike
						? ((lastSpikeStart = now), true)
						: now - lastSpikeStart <= SPIKE_DURATION_MS);

				pacing_targetRps = pacing_inSpike ? SPIKE_RPS : BURST_TARGET_RPS;
				const minGap = Math.max(1, Math.floor(1000 / pacing_targetRps));

				const minInt = heuristics.minIntervalMsEstimate ?? 0;
				pacing_effectiveGapMs = Math.max(minGap, Math.floor(minInt * 0.9));
				const elapsed = Date.now() - t0;
				const toWait = Math.max(0, pacing_effectiveGapMs - elapsed);
				pacing_nextRequestAt = Date.now() + toWait;

				if (toWait > 0) await sleep(toWait);
			}
		} catch (err: any) {
			if (err?.name === "AbortError") timeoutCount++;
			else networkErrorCount++;
			recordEvent({ t: Date.now(), status: 0 });
			// after an error, small fixed backoff
			const toWait = 250;
			pacing_inSpike = false;
			pacing_targetRps = BURST_TARGET_RPS;
			pacing_effectiveGapMs = toWait;
			pacing_nextRequestAt = Date.now() + toWait;

			writeOut();
			await sleep(toWait);
		}
	}
}

console.log(`Writing live report to: ${OUT_PATH}`);
console.log(`Press Ctrl+C to stop.`);
probeLoop().catch((err) => {
	console.error(err);
	process.exit(1);
});
