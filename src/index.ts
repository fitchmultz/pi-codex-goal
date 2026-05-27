import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerGoalRuntimeController } from "./goal-runtime-controller.js";

export { __testHooks } from "./runtime-config.js";

export default function (pi: ExtensionAPI): void {
  registerGoalRuntimeController(pi);
}
