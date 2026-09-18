// Run the existing SDK tests against a built host without replacing local dependencies.
import { existsSync, realpathSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const host = resolve(process.env.PI_TEST_HOST);
const require = createRequire(join(host, "package.json"));
registerHooks({
	resolve(specifier, context, nextResolve) {
		// Select the test's SDK; package copies and host dependencies use native resolution.
		if (!context.parentURL?.startsWith(new URL("../", import.meta.url).href)) return nextResolve(specifier, context);
		if (specifier.startsWith("@earendil-works/pi-") || specifier === "typebox" || specifier.startsWith("typebox/")) {
			const parts = specifier.split("/");
			const name = specifier.startsWith("@") ? parts.splice(0, 2).join("/") : parts.shift();
			const root = name === "@earendil-works/pi-coding-agent" ? host
				: realpathSync(require.resolve.paths(name).map(path => join(path, name)).find(path => existsSync(join(path, "package.json"))));
			if (name === "typebox") return nextResolve(specifier, { ...context, parentURL: pathToFileURL(join(host, "package.json")).href });
			return { url: pathToFileURL(join(root, "dist", parts.length ? `${parts.join("/")}.js` : "index.js")).href, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});
