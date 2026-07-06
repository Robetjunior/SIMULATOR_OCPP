import type { ChargerStatus, TimelineEvent } from "./types";

export class TimelineRecorder {
  private events: TimelineEvent[] = [];

  record(type: string, status: ChargerStatus, payload: Record<string, unknown> = {}): void {
    this.events.push({
      type,
      at: new Date().toISOString(),
      status,
      payload,
    });
  }

  toJSON(): TimelineEvent[] {
    return this.events.slice();
  }
}
