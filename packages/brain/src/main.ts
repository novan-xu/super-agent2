import { systemClock } from "@super-agent2/programs";
import { startFromEnvironment } from "./start.js";

const running = startFromEnvironment(process.env, systemClock, (line) => process.stderr.write(`${line}\n`));

if (running === undefined) {
  process.exitCode = 1;
} else {
  let stopping = false;
  const stop = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    running.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
