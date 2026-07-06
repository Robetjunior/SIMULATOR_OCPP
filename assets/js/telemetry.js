// Gerador de telemetria realística e determinística quando seed é informada.
// A energia acumulada sempre deriva da potência, evitando divergência entre
// Power.Active.Import, Current.Import e Energy.Active.Import.Register.

class Telemetry {
  constructor(config = {}) {
    this.maxPowerKW = config.maxPowerKW ?? 7.0;
    this.nominalVoltage = config.nominalVoltage ?? 230;
    this.maxCurrentA = config.maxCurrentA ?? 32;
    this.rampUpSeconds = config.rampUpSeconds ?? 20;
    this.taperStartSoc = config.taperStartSoc ?? 70;
    this.targetSoc = config.targetSoc ?? 80;
    this.initialSoc = config.initialSoc ?? 20;
    this.tempBase = config.tempBase ?? 28.0;
    this.tempRate = config.tempRate ?? 0.02;
    this.pricePerKWh = config.pricePerKWh ?? 1.99;
    this.batteryCapacityKWh = config.batteryCapacityKWh ?? 80;
    this.timeTargetMin = config.timeTargetMin ?? 5;
    this.startSoc = null;
    this.seed = null;
    this.random = Math.random;

    if (config.seed != null) {
      this.setSeed(config.seed);
    }

    this.reset();
  }

  createSeededRandom(seed) {
    let state = (Number(seed) >>> 0) || 1;
    return () => {
      state = (1664525 * state + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  setSeed(seed) {
    this.seed = Number(seed);
    this.random = this.createSeededRandom(this.seed);
  }

  reset() {
    this.elapsedSec = 0;
    this.energyWh = 0;
    this.powerKW = 0;
    this.voltageV = this.nominalVoltage;
    this.currentA = 0;
    this.temperatureC = this.tempBase;
    this.soc = this.initialSoc;
    this.sessionStart = null;
    this.running = false;
    this.paused = false;
  }

  start(now = Date.now()) {
    this.sessionStart = now;
    this.running = true;
    this.paused = false;
    this.startSoc = this.soc;
  }

  stop() {
    this.running = false;
    this.paused = false;
    this.powerKW = 0;
    this.currentA = 0;
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
    if (this.paused) {
      this.powerKW = 0;
      this.currentA = 0;
    }
  }

  setPricePerKWh(p) {
    if (!isFinite(p) || p <= 0) return;
    this.pricePerKWh = p;
  }

  setSocTarget(target) {
    this.targetSoc = Math.min(100, Math.max(this.taperStartSoc, target));
  }

  setInitialSoc(soc) {
    if (!isFinite(soc)) return;
    this.initialSoc = Math.max(0, Math.min(100, Number(soc)));
  }

  applyConfig(cfg = {}) {
    if (cfg.maxPowerKW != null) this.maxPowerKW = cfg.maxPowerKW;
    if (cfg.nominalVoltage != null) this.nominalVoltage = cfg.nominalVoltage;
    if (cfg.maxCurrentA != null) this.maxCurrentA = cfg.maxCurrentA;
    if (cfg.rampUpSeconds != null) this.rampUpSeconds = cfg.rampUpSeconds;
    if (cfg.taperStartSoc != null) this.taperStartSoc = cfg.taperStartSoc;
    if (cfg.targetSoc != null) this.setSocTarget(cfg.targetSoc);
    if (cfg.initialSoc != null) this.setInitialSoc(cfg.initialSoc);
    if (cfg.tempBase != null) this.tempBase = cfg.tempBase;
    if (cfg.tempRate != null) this.tempRate = cfg.tempRate;
    if (cfg.batteryCapacityKWh != null) this.batteryCapacityKWh = Math.max(1, cfg.batteryCapacityKWh);
    if (cfg.timeTargetMin != null) this.timeTargetMin = Math.max(1, cfg.timeTargetMin);
    if (cfg.seed != null) this.setSeed(cfg.seed);
  }

  noise(amp) {
    return (this.random() - 0.5) * amp * 2;
  }

  update(dt) {
    if (!this.running) {
      return this.snapshot();
    }

    this.elapsedSec += dt;

    if (this.paused) {
      this.voltageV = Math.max(210, this.nominalVoltage + this.noise(2));
      this.currentA = 0;
      this.powerKW = 0;
      this.temperatureC = Math.max(this.tempBase, this.temperatureC - 0.01 * dt);
      return this.snapshot();
    }

    const rampFactor = Math.min(1, this.elapsedSec / Math.max(1, this.rampUpSeconds));

    let taperFactor = 1;
    if (this.soc >= this.taperStartSoc) {
      const range = Math.max(1, 100 - this.taperStartSoc);
      const x = (this.soc - this.taperStartSoc) / range;
      taperFactor = Math.max(0.1, 1 - x * 0.9);
    }

    let targetPowerKW = this.maxPowerKW * rampFactor * taperFactor;
    targetPowerKW = Math.max(0, targetPowerKW + this.noise(0.05));

    this.voltageV = Math.max(210, this.nominalVoltage + this.noise(3));
    this.currentA = Math.min(this.maxCurrentA, (targetPowerKW * 1000) / Math.max(1, this.voltageV));
    this.powerKW = (this.voltageV * this.currentA) / 1000;

    const deltaWh = (this.powerKW * 1000 * dt) / 3600;
    this.energyWh += Math.max(0, deltaWh);

    this.temperatureC = Math.max(this.tempBase, this.temperatureC + this.tempRate * dt + this.noise(0.02));

    const deltaSoc = ((deltaWh / 1000) / this.batteryCapacityKWh) * 100;
    this.soc = Math.min(this.targetSoc, Math.min(100, this.soc + Math.max(0, deltaSoc)));

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
      paused: this.paused,
      seed: this.seed,
    };
  }
}

window.Telemetry = Telemetry;
