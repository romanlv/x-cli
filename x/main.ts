import { main } from "../core/cli";
import { xDomain } from "./domain";

// X watches for automation and limits each account, so: the installed Chrome over Playwright's, and
// one request's browsers at a time (knowledge/bot-detection.md).
process.env.XCLI_BROWSER_CHANNEL ??= "chrome";
process.env.XCLI_MAX_RUNNING ??= "1";

await main(xDomain());
