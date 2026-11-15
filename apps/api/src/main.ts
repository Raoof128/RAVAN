import { buildApp } from "./app.js";
import { environmentConfig } from "./config.js";
try {
  const config = environmentConfig();
  const app = await buildApp(config);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void app.close().catch(() => {
        process.exitCode = 1;
      });
    });
  await app.listen({ host: config.host, port: config.port });
  console.info(`Mov API listening on ${config.host}:${config.port}`);
} catch {
  console.error(
    "Mov startup failed. Check configuration, database permissions and runtime.",
  );
  process.exitCode = 1;
}
