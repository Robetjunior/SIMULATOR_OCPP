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
  }

  setState(next) {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.onChange({ prev, next });
  }

  authorizeAccepted() {
    this.setState(ChargeState.Preparing);
  }

  startTransaction() {
    this.setState(ChargeState.Charging);
  }

  suspendEV() { this.setState(ChargeState.SuspendedEV); }
  suspendEVSE() { this.setState(ChargeState.SuspendedEVSE); }
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