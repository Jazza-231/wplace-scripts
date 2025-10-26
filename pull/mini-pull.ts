import { configDotenv } from "dotenv";
import { parseArgs } from "util";

configDotenv({ quiet: true });

const args = parseArgs({
	options: { from: { type: "string", short: "f" }, to: { type: "string", short: "t" } },
}).values;

console.log(args);
