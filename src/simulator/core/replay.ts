import { ChargerRuntime } from "./chargerRuntime";
import type { SessionScenario } from "./types";

export function deterministicReplay(scenario: SessionScenario, seed: number, ticks = 10) {
  const runtime = new ChargerRuntime({ scenario, seed });
  runtime.onBootResponse("Accepted", scenario.heartbeatIntervalSec);
  runtime.startSession();
  for (let i = 0; i < ticks; i += 1) {
    runtime.tick(1);
  }
  const finalSample = runtime.stopSession();
  const normalizedTimeline = runtime.timeline.toJSON().map((event, index) => ({
    ...event,
    at: `step-${index}`,
  }));
  return {
    finalSample: {
      ...finalSample,
      timestamp: "final-sample",
    },
    timeline: normalizedTimeline,
  };
}
