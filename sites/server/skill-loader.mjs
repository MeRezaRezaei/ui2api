import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("./index.ts", import.meta.url));

export function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", serverPath], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ...extraEnv },
  });
  return child;
}

// If run directly, start the server and keep the process alive.
if (import.meta.url === `file://${process.argv[1]}`) {
  const child = startServer();
  child.on("exit", (code) => process.exit(code ?? 0));
}
