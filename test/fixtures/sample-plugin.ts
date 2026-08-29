import type { Ui2ApiPlugin } from "../../src/plugin/types.js";
const plugin: Ui2ApiPlugin = {
  name: "sample", version: "1.0.0",
  manifest: { name: "sample", version: "1.0.0", author: "tester", description: "t", authorizedUse: "test", license: "MIT", ui2api: "0.1.0" },
  setup(ctx) {
    ctx.registerTool({ name: "echo", description: "echo", inputSchema: { type: "object", properties: { hi: {} } } },
      async (args) => ({ echo: args, dataDir: ctx.config.dataDir }));
  },
};
export default plugin;
