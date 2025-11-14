// Gerador de telemetria realística
// Potência (kW): ramp-up 10–30s, platô próximo ao máximo, taper nos últimos 10–15% de SoC
// Tensão (V): fixo com pequena variação
// Corrente (A): P = V * I
// Energia (kWh): integral da potência
// Temperatura (°C): cresce lentamente com ruído
// SoC (%): incremento progressivo com taper

class Telemetry {
  constructor(config = {}) {
    this.maxPowerKW = config.maxPowerKW ?? 7.0; // ex.: 7 kW AC
    this.nominalVoltage = config.nominalVoltage ?? 400; // ex.: 400 V
    this.maxCurrentA = config.maxCurrentA ?? 16; // limite do conector
    this.rampUpSeconds = config.rampUpSeconds ?? 20;
    this.taperStartSoc = config.taperStartSoc ?? 70; // inicia taper
    this.targetSoc = config.targetSoc ?? 80; // termina sessão ao atingir
    this.tempBase = config.tempBase ?? 28.0;
    this.tempRate = config.tempRate ?? 0.02; // °C/s
    this.pricePerKWh = config.pricePerKWh ?? 1.99;
    this.batteryCapacityKWh = config.batteryCapacityKWh ?? 80; // capacidade da bateria
    this.timeTargetMin = config.timeTargetMin ?? 5; // concluir em até 5 min
    this.startSoc = null;

    this.reset();
  }

  reset() {
    this.elapsedSec = 0;
    this.energyWh = 0; // acumulado
    this.powerKW = 0;
    this.voltageV = this.nominalVoltage;
    this.currentA = 0;
    this.temperatureC = this.tempBase;
    this.soc = 20; // estado inicial de carga
    this.sessionStart = null;
    this.running = false;
  }

  start(now = Date.now()) {
    this.sessionStart = now;
    this.running = true;
    this.startSoc = this.soc;
  }

  stop() {
    this.running = false;
  }

  setPricePerKWh(p) {
    if (!isFinite(p) || p <= 0) return;
    this.pricePerKWh = p;
  }

  setSocTarget(target) {
    this.targetSoc = Math.min(100, Math.max(this.taperStartSoc, target));
  }

  applyConfig(cfg = {}) {
    if (cfg.maxPowerKW != null) this.maxPowerKW = cfg.maxPowerKW;
    if (cfg.nominalVoltage != null) this.nominalVoltage = cfg.nominalVoltage;
    if (cfg.maxCurrentA != null) this.maxCurrentA = cfg.maxCurrentA;
    if (cfg.rampUpSeconds != null) this.rampUpSeconds = cfg.rampUpSeconds;
    if (cfg.taperStartSoc != null) this.taperStartSoc = cfg.taperStartSoc;
    if (cfg.targetSoc != null) this.setSocTarget(cfg.targetSoc);
    if (cfg.tempBase != null) this.tempBase = cfg.tempBase;
    if (cfg.tempRate != null) this.tempRate = cfg.tempRate;
    if (cfg.batteryCapacityKWh != null) this.batteryCapacityKWh = Math.max(1, cfg.batteryCapacityKWh);
    if (cfg.timeTargetMin != null) this.timeTargetMin = Math.max(1, cfg.timeTargetMin);
  }

  // Atualiza em dt segundos
  update(dt) {
    if (!this.running) {
      return this.snapshot();
    }
    this.elapsedSec += dt;

    // Ruídos pequenos
    const noise = (amp) => (Math.random() - 0.5) * amp * 2;

    // Ramp-up
    const rampFactor = Math.min(1, this.elapsedSec / this.rampUpSeconds);

    // Taper baseado no SoC
    let taperFactor = 1;
    if (this.soc >= this.taperStartSoc) {
      const range = 100 - this.taperStartSoc;
      const x = (this.soc - this.taperStartSoc) / range; // 0..1
      taperFactor = Math.max(0.1, 1 - x * 0.9); // reduz até ~10%
    }

    // Potência alvo com ramp + taper
    let targetPowerKW = this.maxPowerKW * rampFactor * taperFactor;
    targetPowerKW = Math.max(0, targetPowerKW + noise(0.05));

    // Deriva tensão: pequena variação em torno do nominal
    this.voltageV = Math.max(210, this.nominalVoltage + noise(3));

    // Corrente derivada (limitada)
    this.currentA = Math.min(this.maxCurrentA, (targetPowerKW * 1000) / this.voltageV);
    this.powerKW = (this.voltageV * this.currentA) / 1000;

    // Energia (Wh)
    const powerW = this.powerKW * 1000;
    const dWh = (powerW * dt) / 3600;
    this.energyWh += dWh;

    // Temperatura
    this.temperatureC += this.tempRate * dt + noise(0.02);

    // SoC: incremento proporcional à energia relativa à capacidade + garantia por tempo-alvo
    const dKWh = dWh / 1000;
    const dSocEnergy = (dKWh / this.batteryCapacityKWh) * 100;
    let dSocTime = 0;
    if (this.timeTargetMin && this.startSoc != null) {
      const remainingSoc = Math.max(0, this.targetSoc - this.soc);
      const remainingSec = Math.max(1, this.timeTargetMin * 60 - this.elapsedSec);
      const plannedRatePerSec = (this.targetSoc - this.startSoc) / (this.timeTargetMin * 60);
      dSocTime = Math.min(remainingSoc, plannedRatePerSec * dt);
    }
    const dSoc = Math.max(dSocEnergy, dSocTime);
    this.soc = Math.min(this.targetSoc, Math.min(100, this.soc + dSoc));

    // Suspensão se potência ~0 por alguns segundos (simulação simplificada)
    // Tratamento de suspensão é feito pela máquina de estados externamente.

    return this.snapshot();
  }

  snapshot() {
    const durationMin = Math.floor(this.elapsedSec / 60);
    const energyKWh = this.energyWh / 1000;
    const totalCost = energyKWh * this.pricePerKWh;
    return {
      powerKW: this.powerKW,
      voltageV: this.voltageV,
      currentA: this.currentA,
      energyWh: this.energyWh,
      energyKWh,
      durationMin,
      temperatureC: this.temperatureC,
      soc: this.soc,
      pricePerKWh: this.pricePerKWh,
      totalCost,
      sessionStart: this.sessionStart,
    };
  }
}

window.Telemetry = Telemetry;