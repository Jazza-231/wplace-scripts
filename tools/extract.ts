const extract = "../go/extract/main.go";
const combine = "../go/combine/main.go";
const massCrop = "../go/mass-crop/main.go";
const gif = "..gif.ps1";

// Todo, actually call this shi I'm too burnt out rn

class Options {
	global: {
		startIndex: number;
		endIndex: number;
		leftX: number;
		rightX: number;
		topY: number;
		bottomY: number;
		workers: number;
		basePath: string;
	};

	extract: {
		sevenZipPath: string;
	};

	combine: {
		deleteOriginals: boolean;
	};

	massCrop: {
		x: number;
		y: number;
		cropRect: { left: number; top: number; right: number; bottom: number };
	};

	gif: {
		fps: number;
		x: number;
		y: number;
		startIndex: number;
	};

	constructor() {
		this.global = {
			startIndex: 1,
			endIndex: 153,
			leftX: 431,
			rightX: 432,
			topY: 840,
			bottomY: 840,
			workers: 24,
			basePath: "C:/Users/jazza/Downloads/wplace",
		};

		this.extract = {
			sevenZipPath: "C:/Program Files/7-Zip/7z.exe",
		};

		this.combine = {
			deleteOriginals: true,
		};

		this.massCrop = {
			x: this.global.leftX,
			y: this.global.bottomY,
			cropRect: { left: 0, top: 197, right: 656, bottom: 677 },
		};

		this.gif = {
			fps: 20,
			x: this.global.leftX,
			y: this.global.bottomY,
			startIndex: 0 || this.global.startIndex,
		};
	}
}

export const options = new Options();
