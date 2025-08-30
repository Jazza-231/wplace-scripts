const SIZE = 2048; // tiles are 0..2047

export function latLonToTile(latDeg: number, lonDeg: number) {
	const x = Math.floor(((lonDeg + 180) / 360) * SIZE);
	const φ = Math.max(
		Math.min((latDeg * Math.PI) / 180, (85.05112878 * Math.PI) / 180),
		(-85.05112878 * Math.PI) / 180,
	);
	const yNorm = (1 - Math.log(Math.tan(φ / 2 + Math.PI / 4)) / Math.PI) / 2;
	const y = Math.floor(yNorm * SIZE);
	return { x: clamp(x, 0, SIZE - 1), y: clamp(y, 0, SIZE - 1) };
}

export function tileToLatLon(x: number, y: number) {
	const lon = (x / SIZE) * 360 - 180;
	const n = Math.PI - (2 * Math.PI * y) / SIZE;
	const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
	return { lat, lon };
}

function clamp(n: number, a: number, b: number) {
	return Math.min(Math.max(n, a), b);
}

function linkToTile(link: string) {
	const latLngRegex = /lat=(-?\d+\.\d+)&lng=(-?\d+\.\d+)/;
	const match = link.match(latLngRegex);
	if (!match) throw new Error(`Invalid link: ${link}`);
	const [, lat, lon] = match;

	return latLonToTile(Number(lat), Number(lon));
}

function tileToLink(x: number, y: number) {
	return `https://wplace.live/?lat=${tileToLatLon(x, y).lat}&lng=${tileToLatLon(x, y).lon}&zoom=11`;
}
