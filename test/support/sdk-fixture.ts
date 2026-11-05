import { InMemoryCredentialStore, fauxProvider, type Model } from "@earendil-works/pi-ai";
import {
  createExtensionRuntime,
  ExtensionRunner,
  initTheme,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type ExtensionUIContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";

const modelRuntime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsPath: null,
  allowModelNetwork: false,
  refreshOnCreate: false,
});
export const testModelRegistry = new ModelRegistry(modelRuntime);
const runner = new ExtensionRunner(
  [],
  createExtensionRuntime(),
  "/tmp",
  SessionManager.inMemory("/tmp"),
  testModelRegistry,
);

export function testTheme(name = "dark"): Theme {
  initTheme(name, false);
  return runner.getUIContext().theme;
}

export function testUi(): ExtensionUIContext {
  return { ...runner.getUIContext(), theme: testTheme(), confirm: async () => true };
}

export function testModel(contextWindow: number): Model<string> {
  return fauxProvider({
    provider: "test",
    models: [{ id: "test-model", contextWindow }],
  }).getModel();
}

/** Construction does not start the renderer or take over stdin. */
export function testTui(): TuiMainScreen {
  return new TuiMainScreen(new ProcessTerminal());
}
