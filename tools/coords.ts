import { parseArgs, ParseArgsOptionsConfig } from "util";

const SIZE = 2048; // tiles are 0..2047

type Args = {
	help: boolean;
	lat: number;
	lon: number;
	tx: number;
	ty: number;
	link: string;
};

type LatLon = { lat: number; lon: number };
type Tile = { x: number; y: number };

export function latLonToTile(latDeg: number, lonDeg: number): Tile {
	const x = Math.floor(((lonDeg + 180) / 360) * SIZE);
	const φ = Math.max(
		Math.min((latDeg * Math.PI) / 180, (85.05112878 * Math.PI) / 180),
		(-85.05112878 * Math.PI) / 180,
	);
	const yNorm = (1 - Math.log(Math.tan(φ / 2 + Math.PI / 4)) / Math.PI) / 2;
	const y = Math.floor(yNorm * SIZE);
	return { x: clamp(x, 0, SIZE - 1), y: clamp(y, 0, SIZE - 1) };
}

export function tileToLatLon(x: number, y: number): LatLon {
	const lon = (x / SIZE) * 360 - 180;
	const n = Math.PI - (2 * Math.PI * y) / SIZE;
	const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
	return { lat, lon };
}

function clamp(n: number, a: number, b: number) {
	return Math.min(Math.max(n, a), b);
}

function linkToTile(link: string): Tile {
	const latLngRegex = /lat=(-?\d+\.\d+)&lng=(-?\d+\.\d+)/;
	const match = link.match(latLngRegex);
	if (!match) throw new Error(`Invalid link: ${link}`);
	const [, lat, lon] = match;

	return latLonToTile(Number(lat), Number(lon));
}

function tileToLink(x: number, y: number): string {
	return `https://wplace.live/?lat=${tileToLatLon(x, y).lat}&lng=${tileToLatLon(x, y).lon}&zoom=15`;
}

const options: ParseArgsOptionsConfig = {
	help: { type: "boolean" },
	lat: { type: "string" },
	lon: { type: "string" },
	tx: { type: "string" },
	ty: { type: "string" },
	link: { type: "string" },
};

const parsedArgs = parseArgs({ options, allowPositionals: true });

const args = (() => {
	let a: Args = { help: false, lat: 0, lon: 0, tx: 0, ty: 0, link: "" };
	let operation: string = "";

	let help = parsedArgs.values.help;
	if (typeof help === "boolean") a.help = help;

	let lat = Number(parsedArgs.values.lat);
	if (typeof lat === "number") a.lat = lat;

	let lon = Number(parsedArgs.values.lon);
	if (typeof lon === "number") a.lon = lon;

	let tx = Number(parsedArgs.values.tx);
	if (typeof tx === "number") a.tx = tx;

	let ty = Number(parsedArgs.values.ty);
	if (typeof ty === "number") a.ty = ty;

	let link = parsedArgs.values.link;
	if (typeof link === "string") a.link = link;

	if (parsedArgs.positionals.length) operation = parsedArgs.positionals[0].toLowerCase();

	return { operation, ...a };
})();

if (args.help) {
	console.log(`
Usage: coords-to-tile [operation] [options] 

Operations:
  lltt - lat-lon-to-tile
  ttll - tile-to-lat-lon
	ltt - link-to-tile
	ttl - tile-to-link

Options:
  --help  Show this help message and exit.
  --lat   The latitude of the tile.
  --lon   The longitude of the tile.
  --tx    The X coordinate of the tile.
  --ty    The Y coordinate of the tile.
  --link  The link to the tile.
`);
	process.exit(0);
}

let output: string | Tile | LatLon = "";
switch (args.operation) {
	case "lltt":
		output = latLonToTile(args.lat, args.lon);
		break;

	case "ttll":
		output = tileToLatLon(args.tx, args.ty);
		break;

	case "ltt":
		output = linkToTile(args.link);
		break;

	case "ttl":
		output = tileToLink(args.tx, args.ty);
		break;

	default:
		output = "Invalid operation. Use --help to see available operations.";
		break;
}

console.log(output);
