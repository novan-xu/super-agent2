import { startFromEnvironment } from "./start.js";

const hub = await startFromEnvironment(process.env, { report: (line) => process.stderr.write(`${line}\n`) });

if (hub === undefined) {
  process.exitCode = 1;
} else {
  let stopping = false;
  const stop = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    hub.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
