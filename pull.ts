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

/* -------------------- GLOBALS -------------------- */
const proxyListURL =
	"https://proxy.webshare.io/api/v2/proxy/list/download/ipqdzaeydnckvkfpjhtwzfwjswdfnffznqhyalqx/-/any/username/direct/-/?plan_id=11758104";

const basePath = "C:/Users/jazza/Downloads/wplace/";

/* -------------------- GET PROXIES -------------------- */

const proxyRequest = await fetch(proxyListURL);
const proxyText = await proxyRequest.text();

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

/* -------------------- HELPERS -------------------- */
function getRandomProxy() {
	const randomIndex = Math.floor(Math.random() * proxies.length);
	return proxies[randomIndex];
}

// https://backend.wplace.live/files/s0/tiles/69/420.png
/* -------------------- GET URLS -------------------- */
const testURL = "https://backend.wplace.live/files/s0/tiles/69/420.png";

const proxyAgent = new ProxyAgent(getRandomProxy());

const { statusCode, body } = await request(testURL, { dispatcher: proxyAgent });

console.log(statusCode);

const dirPath = path.join(basePath, "tiles", "69");
const filePath = path.join(dirPath, "420.png");

if (!fs.existsSync(dirPath)) {
	fs.mkdirSync(dirPath, { recursive: true });
}

fs.writeFileSync(filePath, Buffer.from(await body.arrayBuffer()));
