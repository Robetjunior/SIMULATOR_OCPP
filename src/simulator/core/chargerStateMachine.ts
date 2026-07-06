import type { ChargerStatus } from "./types";

const allowedTransitions: Record<ChargerStatus, ChargerStatus[]> = {
  Available: ["Preparing", "Faulted", "Unavailable"],
  Preparing: ["Charging", "Available", "Faulted", "Unavailable"],
  Charging: ["SuspendedEV", "SuspendedEVSE", "Finishing", "Faulted"],
  SuspendedEV: ["Charging", "Finishing", "Faulted"],
  SuspendedEVSE: ["Charging", "Finishing", "Faulted"],
  Finishing: ["Available", "Faulted"],
  Unavailable: ["Available", "Faulted"],
  Faulted: ["Available", "Unavailable"],
};

export class ChargerStateMachine {
  private current: ChargerStatus = "Available";

  get state(): ChargerStatus {
    return this.current;
  }

  transition(next: ChargerStatus): boolean {
    if (next === this.current) return false;
    const valid = allowedTransitions[this.current] || [];
    if (!valid.includes(next)) {
      return false;
    }
    this.current = next;
    return true;
  }
}
