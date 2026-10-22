// Select an existing host and its companion graph without changing installations.
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const hostPackage = process.env.PI_SDK_PACKAGE;
if (!hostPackage) throw new Error("Set PI_SDK_PACKAGE to the host pi-coding-agent package.json");
const parentURL = pathToFileURL(resolve(hostPackage)).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@earendil-works/") || specifier === "typebox" || specifier.startsWith("typebox/")) {
      return nextResolve(specifier, { ...context, parentURL });
    }
    return nextResolve(specifier, context);
  },
});
