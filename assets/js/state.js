// Máquina de estados do carregamento
// Estados: Available -> Preparing -> Charging -> SuspendedEV/EVSE -> Finishing -> Available

const ChargeState = Object.freeze({
  Available: "Available",
  Preparing: "Preparing",
  Charging: "Charging",
  SuspendedEV: "SuspendedEV",
  SuspendedEVSE: "SuspendedEVSE",
  Finishing: "Finishing",
  Unavailable: "Unavailable",
  Faulted: "Faulted",
});

class StateMachine {
  constructor(onChange) {
    this.state = ChargeState.Available;
    this.onChange = typeof onChange === "function" ? onChange : () => {};
    this.allowedTransitions = {
      Available: [ChargeState.Preparing, ChargeState.Faulted, ChargeState.Unavailable],
      Preparing: [ChargeState.Charging, ChargeState.Available, ChargeState.Faulted, ChargeState.Unavailable],
      Charging: [ChargeState.SuspendedEV, ChargeState.SuspendedEVSE, ChargeState.Finishing, ChargeState.Faulted],
      SuspendedEV: [ChargeState.Charging, ChargeState.Finishing, ChargeState.Faulted],
      SuspendedEVSE: [ChargeState.Charging, ChargeState.Finishing, ChargeState.Faulted],
      Finishing: [ChargeState.Available, ChargeState.Faulted],
      Unavailable: [ChargeState.Available, ChargeState.Faulted],
      Faulted: [ChargeState.Available, ChargeState.Unavailable],
    };
  }

  setState(next) {
    if (this.state === next) return;
    const allowed = this.allowedTransitions[this.state] || [];
    if (!allowed.includes(next)) {
      return false;
    }
    const prev = this.state;
    this.state = next;
    this.onChange({ prev, next });
    return true;
  }

  authorizeAccepted() {
    this.setState(ChargeState.Preparing);
  }

  startTransaction() {
    this.setState(ChargeState.Charging);
  }

  suspendEV() { this.setState(ChargeState.SuspendedEV); }
  suspendEVSE() { this.setState(ChargeState.SuspendedEVSE); }
  fault() { this.setState(ChargeState.Faulted); }
  unavailable() { this.setState(ChargeState.Unavailable); }
  resume() {
    // volta para Charging
    this.setState(ChargeState.Charging);
  }

  stopTransaction() {
    this.setState(ChargeState.Finishing);
    // retorno a Available é tratado externamente após alguns segundos
  }

  finishToAvailable(delayMs = 2000) {
    setTimeout(() => this.setState(ChargeState.Available), delayMs);
  }
}

window.ChargeState = ChargeState;
window.StateMachine = StateMachine;
