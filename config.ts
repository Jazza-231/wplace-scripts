// This is SPECIFICALLY for DEFAULTS, env overrides are done in their own files.
import os from "os";

type OperatingSystems = "windows" | "linux" | "unknown";
type OSDefaults = {
	[operatingSystem in OperatingSystems]: {
		/** Path to the wplace folder; WP_WPLACE_PATH env var */
		WPLACE_PATH: string;
		/** Path to the 7z executable; no env var, is only used in wplace.ts */
		SEVEN_ZIP_PATH: string;
	};
};

export function getOperatingSystem(): OperatingSystems {
	const platform = os.platform();
	if (platform === "win32") {
		return "windows";
	} else if (platform === "linux") {
		return "linux";
	}

	return "unknown";
}

const osDefaults: OSDefaults = {
	windows: {
		WPLACE_PATH: "C:/Users/jazza/Downloads/wplace",
		SEVEN_ZIP_PATH: "C:/Program Files/7-Zip/7z.exe",
	},
	linux: {
		WPLACE_PATH: "/srv/wplace",
		SEVEN_ZIP_PATH: "/usr/bin/7z",
	},
	unknown: {
		WPLACE_PATH: "/wplace",
		SEVEN_ZIP_PATH: "7z", // Assume in PATH
	},
};

/**
 * The default configuration values used throughout the scripts.
 * These can be overridden, usually, via command line arguments
 * The path-related values are resolved automatically based on the operating system,
 * or a specific operating system's values can be used if prepended with the OS name.
 */
export const DEFAULT_CONFIG = {
	/** Number of splits to use; WP_SPLITS env var */
	SPLITS: 6,
	/** Number of concurrent tasks to run; WP_CONCURRENT env var */
	CONCURRENT: 1200,
	/** INCLUSIVE, the bounds of tiles to process; no env var, isn't configurable */
	TILE_BOUNDS: {
		minX: 0,
		maxX: 2047,
		minY: 0,
		maxY: 2047,
	},

	...osDefaults,

	...osDefaults[getOperatingSystem()],
} as const;
