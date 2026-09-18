// Type-check the real package configs against a selected built Pi host.
// Paths affect TypeScript only; no node_modules links or dependency replacement.
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const repo = process.cwd();
const [hostArgument, ...configs] = process.argv.slice(2);
if (!hostArgument) throw new Error("Usage: node scripts/check-pi-host.mjs /path/to/pi-coding-agent [tsconfig.json ...]");
const host = resolve(hostArgument);
const require = createRequire(join(repo, "package.json"));
const ts = require("typescript");
const hostRequire = createRequire(join(host, "package.json"));
const paths = {};
for (const name of ["pi-ai", "pi-agent-core", "pi-coding-agent", "pi-tui"]) {
	const specifier = `@earendil-works/${name}`;
	const directory = name === "pi-coding-agent" ? host : hostRequire.resolve.paths(specifier)
		.map(path => join(path, specifier))
		.find(path => existsSync(join(path, "package.json")));
	if (!directory) throw new Error(`Cannot resolve ${specifier} from ${host}`);
	const root = realpathSync(directory);
	if (!existsSync(join(root, "dist/index.d.ts"))) throw new Error(`Build the selected host first: ${root}`);
	paths[specifier] = [join(root, "dist/index.d.ts")];
	paths[`${specifier}/*`] = [join(root, "dist/*.d.ts")];
}
console.log(JSON.stringify({ repo, host, paths, configs }, null, 2));
let failed = false;
for (const config of configs.length ? configs : ["tsconfig.json"]) {
	const parsed = ts.getParsedCommandLineOfConfigFile(resolve(repo, config), { paths, noEmit: true }, {
		...ts.sys,
		onUnRecoverableConfigFileDiagnostic(diagnostic) {
			console.error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
			failed = true;
		},
	});
	if (!parsed) continue;
	const program = ts.createProgram(parsed.fileNames, parsed.options);
	const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
	console.log(`${config}: ${parsed.fileNames.length} root files`);
	console.log(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
		getCanonicalFileName: path => path,
		getCurrentDirectory: () => repo,
		getNewLine: () => "\n",
	}));
	failed ||= diagnostics.length > 0;
}
process.exitCode = failed ? 1 : 0;
