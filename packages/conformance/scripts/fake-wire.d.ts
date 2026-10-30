import type { WireFlavor } from "../src/fixtures";
/** Script data lives outside workspace manifests. No process is started until called. */
export declare function runWireFake(flavor: Exclude<WireFlavor, "claude">): Promise<void>;
