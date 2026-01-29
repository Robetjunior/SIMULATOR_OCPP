// Simulador OCPP 1.6J com UI, telemetria e máquina de estados

(function () {
  // Utilidades
  const $ = (id) => document.getElementById(id);
  const format2 = (n) => Number(n).toFixed(2);
  const format3 = (n) => Number(n).toFixed(3);

  function logLine(text, dir = "info") {
    const out = $("logOutput");
    const ts = new Date().toLocaleTimeString();
    out.textContent += `[${ts}] ${dir.toUpperCase()} ${text}\n`;
    out.scrollTop = out.scrollHeight;
  }

  function setStatusBadge(state) {
    const badge = $("statusBadge");
    const cls = {
      Available: "status-available",
      Preparing: "status-preparing",
      Charging: "status-charging",
      SuspendedEV: "status-suspended",
      SuspendedEVSE: "status-suspended",
      Finishing: "status-finishing",
      Unavailable: "status-unavailable",
      Faulted: "status-faulted",
    }[state] || "status-available";
    badge.className = `badge ${cls}`;
    badge.textContent = state;
    // controle botões
    const startBtn = $("btnStart");
    const stopBtn = $("btnStop");
    if (stopBtn) stopBtn.disabled = !((state === ChargeState.Preparing) || (state === ChargeState.Charging)) || Boolean(uiFlags.stopping);
    if (startBtn) startBtn.disabled = !(state === ChargeState.Available || state === ChargeState.Preparing) || !isWsOpen() || Boolean(uiFlags.starting);
    const socBadge = $("socBadge");
    if (socBadge && socBadge.childNodes && socBadge.childNodes.length > 0) {
      const prefix = (state === ChargeState.Preparing || state === ChargeState.Charging) ? "Carregando:" : "Carregado:";
      try { socBadge.childNodes[0].nodeValue = prefix + " "; } catch(e){}
    }
  }

  function updateGauge(percent) {
    const p = Math.max(0, Math.min(100, percent));
    const deg = (p / 100) * 360;
    const el = $("socGauge");
    el.style.background = `conic-gradient(from -90deg, var(--accent) ${deg}deg, #374151 ${deg}deg)`;
    $("socValue").textContent = `${Math.round(p)}%`;
  }

  // OCPP Client
  class OCPPClient {
    constructor({ url, subprotocols = ["ocpp1.6j", "ocpp1.6"], onOpen, onClose, onMessage }) {
      this.url = url;
      this.subprotocols = subprotocols;
      this.ws = null;
      this.onOpen = onOpen || (() => {});
      this.onClose = onClose || (() => {});
      this.onMessage = onMessage || (() => {});
      this.msgIdCounter = 0;
      this.pending = new Map();
      this.heartbeatIntervalSec = 60;
      this.heartbeatTimer = null;
    }

    connect() {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
      this.ws = new WebSocket(this.url, this.subprotocols);
      this.ws.onopen = () => {
        logLine(`WebSocket conectado: ${this.url}`, "out");
        this.onOpen();
      };
      this.ws.onclose = (ev) => {
        logLine(`WebSocket fechado (code=${ev.code})`, "info");
        this.stopHeartbeat();
        this.onClose(ev);
      };
      this.ws.onerror = (err) => {
        logLine(`Erro WebSocket: ${err.message || err}`, "err");
      };
      this.ws.onmessage = (ev) => {
        this.handleMessage(ev.data);
      };
    }

    disconnect() {
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
    }

    nextId() {
      this.msgIdCounter += 1;
      return `msg_${Date.now()}_${this.msgIdCounter}`;
    }

    sendCall(action, payload) {
      const id = this.nextId();
      const frame = [2, id, action, payload];
      const raw = JSON.stringify(frame);
      try { console.log('[OCPP] CALL.out', { action, payload, rawFrame: frame }); } catch(e){}
      this.ws.send(raw);
      logLine(`=> ${action} ${JSON.stringify(payload)}`, "out");
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject, action });
        // timeout simples
        setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            reject(new Error(`Timeout aguardando resposta de ${action}`));
          }
        }, 20000);
      });
    }

    sendResult(id, payload) {
      const frame = [3, id, payload];
      this.ws.send(JSON.stringify(frame));
      logLine(`<= RESULT ${JSON.stringify(payload)}`, "in");
    }

    sendError(id, errCode = "InternalError", errDesc = "", details = {}) {
      const frame = [4, id, errCode, errDesc, details];
      this.ws.send(JSON.stringify(frame));
      logLine(`<= ERROR ${JSON.stringify(frame)}`, "err");
    }

    handleMessage(raw) {
      try {
        const msg = JSON.parse(raw);
        if (!Array.isArray(msg)) return;
        const [type, id, p3, p4] = msg;
        if (type === 3) {
          // Resposta para um call nosso
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            logLine(`<= ${pending.action} RES ${JSON.stringify(p3)}`, "in");
            pending.resolve(p3);
          }
          return;
        }
        if (type === 2) {
          // Chamada do CSMS para o CP
          const action = p3;
          const payload = p4;
          logLine(`<= CALL ${action} ${JSON.stringify(payload)}`, "in");
          this.onMessage({ id, action, payload });
          return;
        }
      } catch (e) {
        logLine(`Falha parse msg: ${e.message}`, "err");
      }
    }

    startHeartbeat(intervalSec) {
      this.heartbeatIntervalSec = intervalSec || this.heartbeatIntervalSec || 60;
      this.stopHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        this.sendCall("Heartbeat", { chargePointModel: "Sim-1.0" }).catch(() => {});
      }, this.heartbeatIntervalSec * 1000);
    }

    stopHeartbeat() {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
    }
  }

  // UI + Fluxo OCPP
  const state = new StateMachine(({ next }) => {
    setStatusBadge(next);
  });
  const telemetry = new Telemetry();

  let ocpp = null;
  let transactionId = null;
  let sessionMeterStart = 0;
  let meterValuesTimer = null;
  let uiTimer = null;
  let lastZeroPowerSec = 0;
  let telemetryDefaultMaxPowerKW = telemetry.maxPowerKW;
  let telemetryDefaultMaxCurrentA = telemetry.maxCurrentA;
  const setWsStatus = (text) => { const el = $("wsStatus"); if (el) el.textContent = text || ""; };
  const setFlowHint = (text) => { const el = $("flowHint"); if (el) el.textContent = text || ""; };
  let meterIntervalMs = 5000;

  let goalModalShown = false;
  function showGoalModal(percent) {
    if ($("goalModalMessage")) { $("goalModalMessage").textContent = `Bateria atingiu ${percent}% da meta definida.`; }
    if ($("goalModalBackdrop")) { $("goalModalBackdrop").classList.remove("hidden"); }
  }
  function hideGoalModal() {
    if ($("goalModalBackdrop")) { $("goalModalBackdrop").classList.add("hidden"); }
  }
  const uiFlags = { starting: false, stopping: false };
  function isWsOpen() { return !!(ocpp && ocpp.ws && ocpp.ws.readyState === WebSocket.OPEN); }
  function setStartLabel(text) { const b = $("btnStart"); if (b) b.textContent = text; }
  function setStopLabel(text) { const b = $("btnStop"); if (b) b.textContent = text; }

  function buildUrl() {
    const url = $("endpointUrl").value.trim();
    const cpId = $("chargePointId").value.trim();
    if (!url) return "";
    const base = url.endsWith("/") ? url.slice(0, -1) : url;
    if (base.includes("CentralSystemService")) {
      if (!/CentralSystemService\/[^/]+$/.test(base)) {
        if (!cpId) return "";
        return `${base}/${cpId}`;
      }
      return base;
    }
    if (!cpId) return "";
    return `${base}/ocpp/CentralSystemService/${cpId}`;
  }

  function getSubprotocols() {
    const s = $("subprotocols").value.trim();
    if (!s) return ["ocpp1.6j"];
    return s.split(",").map((x) => x.trim()).filter(Boolean);
  }

  function updateUI(metrics) {
    $("powerKW").textContent = format2(metrics.powerKW);
    $("voltageV").textContent = Math.round(metrics.voltageV);
    $("currentA").textContent = format2(metrics.currentA);
    $("energyKWh").textContent = format3(metrics.energyKWh);
    $("durationMin").textContent = metrics.durationMin;
    $("temperatureC").textContent = format2(metrics.temperatureC);
    $("priceUnit").textContent = format2(metrics.pricePerKWh);
    $("totalCost").textContent = format2(metrics.totalCost);
    updateGauge(metrics.soc);
    if ($("socBadgeValue")) { $("socBadgeValue").textContent = `${Math.round(metrics.soc)}%`; }
  }

  function startUiLoop() {
    if (uiTimer) return;
    uiTimer = setInterval(() => {
      const m = telemetry.update(1);
      updateUI(m);

      // Auto-parar ao atingir meta de SoC
      const targetSocCfg = Number($("targetSoc").value || telemetry.targetSoc || 80);
      if (transactionId && m.soc >= targetSocCfg) {
        if (!goalModalShown) { goalModalShown = true; showGoalModal(Math.round(m.soc)); }
        stopTransactionFlow("UserDefinedLimit");
        return;
      }

      // Suspenção se potência zera por 5s
      if (state.state === ChargeState.Charging) {
        if (m.powerKW < 0.05) {
          lastZeroPowerSec += 1;
          if (lastZeroPowerSec >= 5) {
            state.suspendEV();
          }
        } else {
          lastZeroPowerSec = 0;
          if (state.state === ChargeState.SuspendedEV || state.state === ChargeState.SuspendedEVSE) {
            state.resume();
            sendStatus("Charging");
          }
        }
      }
    }, 1000);
  }

  function stopUiLoop() {
    if (uiTimer) {
      clearInterval(uiTimer);
      uiTimer = null;
    }
  }

  function sendStatus(status, connectorId = Number($("connectorId").value || 1)) {
    if (!ocpp || !ocpp.ws || ocpp.ws.readyState !== WebSocket.OPEN) return;
    ocpp
      .sendCall("StatusNotification", {
        connectorId,
        errorCode: "NoError",
        status,
        timestamp: new Date().toISOString(),
      })
      .catch(() => {});
  }

  function installRemoteHook() {
    // Hook removido para evitar duplicidade com handleInbound
    // A lógica agora é centralizada no OCPPClient.handleMessage -> handleInbound
  }

  function bootSequence() {
    ocpp
      .sendCall("BootNotification", {
        chargePointVendor: "IGE2A",
        chargePointModel: "Sim1.6J",
        firmwareVersion: "1.0.0",
      })
      .then((res) => {
        logLine(`[OCPP] BootNotification.conf status=${res && res.status ? res.status : ""} interval=${res && res.interval ? res.interval : ""}`, "info");
        setFlowHint(`BootNotification.${res && res.status ? res.status : ""} — heartbeat ${(Number(res && res.interval) || 60)}s`);
        if (res && res.status === "Accepted") {
          const interval = Number(res.interval) || 60;
          ocpp.startHeartbeat(interval);
          sendStatus("Available");
        }
      })
      .catch((err) => logLine(`BootNotification falhou: ${err.message}`, "err"));
  }

  function authorizeFlow(idTag) {
    logLine(`[OCPP] Authorize.sent idTag=${idTag}`, "info");
    setFlowHint("Authorize enviado…");
    return ocpp
      .sendCall("Authorize", { idTag })
      .then((res) => {
        if (res && res.idTagInfo && res.idTagInfo.status === "Accepted") {
          state.authorizeAccepted();
          sendStatus("Preparing");
          logLine(`[OCPP] Authorize.conf status=Accepted`, "info");
          setFlowHint("Authorize aceito — iniciando StartTransaction…");
          return true;
        }
        logLine(`[OCPP] Authorize.conf status=${res && res.idTagInfo ? res.idTagInfo.status : "Unknown"}` , "err");
        setFlowHint("Authorize rejeitado — prosseguindo com StartTransaction para teste…");
        return false;
      });
  }

  function startTransactionFlow(opts) {
    const connectorId = Number((opts && opts.connectorId) || $("connectorId").value || 1);
    const idTag = String((opts && opts.idTag) || $("idTag").value.trim() || "DEMO-TAG");
    const initialWh = Math.ceil(telemetry?.energyWh || 0);
    const meterStartInput = Number($("meterStart").value || 0);
    const meterStart = Math.max(1, meterStartInput || initialWh);
    sessionMeterStart = meterStart;
    const targetSoc = Number($("targetSoc").value || 80);
    const fastMode = $("fastMode").checked;
    const userIntervalSec = Number($("meterIntervalSec")?.value || 0);
    const realProfile = !!$("realProfile")?.checked;
    telemetry.reset();
    telemetry.setPricePerKWh(Number($("pricePerKWh").value || telemetry.pricePerKWh));
    telemetry.applyConfig({ targetSoc, timeTargetMin: 5 });
    if (fastMode) {
      // timeTargetMin: 1.5 min = 90s
      telemetry.applyConfig({ maxPowerKW: 50, rampUpSeconds: 2, taperStartSoc: 95, batteryCapacityKWh: 50, timeTargetMin: 1.5 });
      meterIntervalMs = 2000;
    } else {
      telemetry.applyConfig({ maxPowerKW: 7, rampUpSeconds: 20, taperStartSoc: 70, batteryCapacityKWh: 80 });
      meterIntervalMs = 5000;
    }
    if (userIntervalSec && userIntervalSec > 0) {
      meterIntervalMs = userIntervalSec * 1000;
    }
    telemetry.start(Date.now());
    telemetryDefaultMaxPowerKW = telemetry.maxPowerKW;
    telemetryDefaultMaxCurrentA = telemetry.maxCurrentA;
    $("startTime").textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    goalModalShown = false;
    updateUI(telemetry.snapshot());
    startUiLoop();

    uiFlags.starting = true;
    setStartLabel("Iniciando…");
    state.setState(ChargeState.Preparing);
    setStatusBadge(state.state);
    setFlowHint("Iniciando sessão — Authorize ➜ StartTransaction ➜ Charging…");
    authorizeFlow(idTag)
      .then((ok) => {
        logLine(`[OCPP] StartTransaction.sent connectorId=${connectorId} meterStart=${meterStart} idTag=${idTag}`, "info");
        setFlowHint("StartTransaction enviado…");
        return ocpp.sendCall("StartTransaction", {
          connectorId,
          idTag,
          timestamp: new Date().toISOString(),
          meterStart,
        });
      })
      .then((res) => {
        transactionId = res && (res.transactionId || res.transaction_id) ? (res.transactionId || res.transaction_id) : transactionId;
        if (!transactionId) {
          return new Promise((resolve) => setTimeout(resolve, 800)).then(() =>
            ocpp
              .sendCall("StartTransaction", {
                connectorId,
                idTag,
                timestamp: new Date().toISOString(),
                meterStart,
              })
              .then((r2) => {
                transactionId = r2 && (r2.transactionId || r2.transaction_id) ? (r2.transactionId || r2.transaction_id) : transactionId;
                return r2;
              })
          );
        }
        return res;
      })
      .then((res) => {
        transactionId = res && (res.transactionId || res.transaction_id) ? (res.transactionId || res.transaction_id) : transactionId;
        try { window.__lastTxId = transactionId; } catch(e){}
        logLine(`[OCPP] StartTransaction.conf transactionId=${transactionId || ""}`, transactionId ? "info" : "err");
        state.startTransaction();
        sendStatus("Charging");
        logLine(`[OCPP] StatusNotification.Charging`, "info");
        setFlowHint(`Charging ativo — transactionId=${transactionId || "?"}`);
        uiFlags.starting = false;
        setStartLabel("Iniciar Carregamento");
        setStatusBadge(state.state);
        // MeterValues com contexto de início da transação
        sendBeginMeterValues({
          connectorId,
          transactionId,
          meterStart,
          realProfile,
        });
        startUiLoop();
        startMeterValues();
      })
      .catch((err) => { uiFlags.starting = false; setStartLabel("Iniciar Carregamento"); setStatusBadge(state.state); logLine(`Início de sessão falhou: ${err.message}`, "err"); });
  }

  async function startChargingSession(opts) {
    const connectorId = Number((opts && opts.connectorId) || $("connectorId").value || 1);
    
    // Verificação de Cabo Conectado
    const cableConnected = $("cableConnected") && $("cableConnected").checked;
    if (!cableConnected) {
      logLine(`[OCPP] Falha ao iniciar: Cabo desconectado. Conecte o cabo ao EV.`, "err");
      setFlowHint("Aguardando conexão do cabo...");
      // Se for RemoteStart, o CSMS já recebeu Accepted mas não receberá StartTransaction, causando timeout.
      // Isso reproduz exatamente o erro reportado quando o cabo não está conectado.
      uiFlags.starting = false;
      setStartLabel("Iniciar Carregamento");
      return;
    }

    const idTag = String((opts && opts.idTag) || $("idTag").value.trim() || "DEMO-TAG");
    const skipAuthorize = !!(opts && opts.skipAuthorize);
    const initialWh = Math.ceil(telemetry?.energyWh || 0);
    const meterStartInput = Number($("meterStart").value || 0);
    const meterStart = Math.max(1, meterStartInput || initialWh);
    const targetSoc = Number($("targetSoc").value || 80);
    const fastMode = $("fastMode").checked;
    const userIntervalSec = Number($("meterIntervalSec")?.value || 0);
    const realProfile = !!$("realProfile")?.checked;
    telemetry.reset();
    telemetry.setPricePerKWh(Number($("pricePerKWh").value || telemetry.pricePerKWh));
    telemetry.applyConfig({ targetSoc, timeTargetMin: 5 });
    if (fastMode) {
      // timeTargetMin: 1.5 min = 90s
      telemetry.applyConfig({ maxPowerKW: 50, rampUpSeconds: 2, taperStartSoc: 95, batteryCapacityKWh: 50, timeTargetMin: 1.5 });
      meterIntervalMs = 2000;
    } else {
      telemetry.applyConfig({ maxPowerKW: 7, rampUpSeconds: 20, taperStartSoc: 70, batteryCapacityKWh: 80 });
      meterIntervalMs = 5000;
    }
    if (userIntervalSec && userIntervalSec > 0) {
      meterIntervalMs = userIntervalSec * 1000;
    }
    telemetry.start(Date.now());
    telemetryDefaultMaxPowerKW = telemetry.maxPowerKW;
    telemetryDefaultMaxCurrentA = telemetry.maxCurrentA;
    $("startTime").textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    goalModalShown = false;
    updateUI(telemetry.snapshot());
    startUiLoop();

    uiFlags.starting = true;
    setStartLabel("Iniciando…");
    
    // Notifica que o EV foi conectado (Preparing) antes de iniciar a transação
    // Isso é crucial para RemoteStartTransaction para evitar timeout_start no CSMS
    state.setState(ChargeState.Preparing);
    sendStatus("Preparing", connectorId);
    logLine(`[OCPP] StatusNotification.Preparing sent (Cable Plugged)`, "info");
    
    setStatusBadge(state.state);
    setFlowHint("Iniciando sessão — Authorize ➜ StartTransaction ➜ Charging…");
    try {
      if (!skipAuthorize) {
        await authorizeFlow(idTag);
      } else {
        logLine(`[OCPP] Skipping Authorize for RemoteStart`, "info");
      }
      let got = false;
      for (let tries = 1; tries <= 3; tries++) {
        logLine(`[OCPP] Start.watchdog.attempt=${tries}/3`, "info");
        logLine(`[OCPP] StartTransaction.sent connectorId=${connectorId} meterStart=${meterStart} idTag=${idTag}`, "info");
        const res = await ocpp
          .sendCall("StartTransaction", {
            connectorId,
            idTag,
            timestamp: new Date().toISOString(),
            meterStart,
          })
          .catch((err) => { logLine(`StartTransaction erro: ${err.message}`, "err"); return null; });
        transactionId = res && (res.transactionId || res.transaction_id) ? (res.transactionId || res.transaction_id) : transactionId;
        if (transactionId) { got = true; break; }
        if (tries < 3) {
          logLine(`[OCPP] Start.watchdog.retry_next=${tries + 1}/3`, "err");
          await new Promise((r) => setTimeout(r, tries === 1 ? 1500 : 3000));
        }
      }
      if (!got) {
        logLine(`[OCPP] Start.watchdog.giveup`, "err");
        uiFlags.starting = false;
        setStartLabel("Iniciar Carregamento");
        setStatusBadge(state.state);
        return;
      }
      try { window.__lastTxId = transactionId; } catch(e){}
      logLine(`[OCPP] StartTransaction.conf transactionId=${transactionId || ""}`, transactionId ? "info" : "err");
      state.startTransaction();
      sendStatus("Charging");
      logLine(`[OCPP] StatusNotification.Charging`, "info");
      setFlowHint(`Charging ativo — transactionId=${transactionId || "?"}`);
      uiFlags.starting = false;
      setStartLabel("Iniciar Carregamento");
      setStatusBadge(state.state);
      sendBeginMeterValues({ connectorId, transactionId, meterStart, realProfile });
      startUiLoop();
      startMeterValues();
    } catch (err) {
      uiFlags.starting = false;
      setStartLabel("Iniciar Carregamento");
      setStatusBadge(state.state);
      logLine(`Início de sessão falhou: ${err.message}`, "err");
    }
  }

  function resetUiIndicators() {
    $("powerKW").textContent = format2(0);
    $("voltageV").textContent = Math.round(telemetry.nominalVoltage || 220);
    $("currentA").textContent = format2(0);
    $("energyKWh").textContent = format3(0);
    $("durationMin").textContent = 0;
    $("temperatureC").textContent = format2(0);
    $("priceUnit").textContent = format2(telemetry.pricePerKWh);
    $("totalCost").textContent = format2(0);
    updateGauge(0);
    if ($("socBadgeValue")) { $("socBadgeValue").textContent = "0%"; }
    $("startTime").textContent = "--:--";
  }

  function stopTransactionFlow(reason = "Local") {
    const connectorId = Number($("connectorId").value || 1);
    const idTag = $("idTag").value.trim() || "DEMO-TAG";
    const meterStop = Number($("meterStop").value || Math.ceil(sessionMeterStart + telemetry.energyWh));
    const realProfile = !!$("realProfile")?.checked;

    uiFlags.stopping = true;
    setStopLabel("Parando…");
    setStatusBadge(state.state);
    stopMeterValues();
    setFlowHint("Parando sessão…");

    // MeterValues com contexto de fim da transação
    sendEndMeterValues({
      connectorId,
      transactionId,
      meterStop,
      realProfile,
    });

    sendStatus("Finishing", connectorId);
    logLine(`[OCPP] StatusNotification.Finishing`, "info");

    ocpp
      .sendCall("StopTransaction", {
        transactionId,
        timestamp: new Date().toISOString(),
        meterStop,
        idTag,
        reason,
      })
      .then(() => {
        saveSessionHistory();
        stopUiLoop();
        resetUiIndicators();
        sendStatus("Available", connectorId);
        logLine(`[OCPP] StatusNotification.Available`, "info");
        setFlowHint(`BootNotification.Accepted — heartbeat ${Number(ocpp && ocpp.heartbeatIntervalSec) || 60}s`);
        transactionId = null;
        uiFlags.stopping = false;
        setStopLabel("Parar Carregamento");
        setStartLabel("Iniciar Carregamento");
        try { state.setState(ChargeState.Available); } catch(e){}
        setStatusBadge(state.state);
      })
      .catch((err) => { uiFlags.stopping = false; setStopLabel("Parar Carregamento"); setStatusBadge(state.state); logLine(`StopTransaction erro: ${err.message}`, "err"); });
  }

  function startMeterValues() {
    if (meterValuesTimer) return;
    meterValuesTimer = setInterval(() => {
      const connectorId = Number($("connectorId").value || 1);
      const realProfile = !!$("realProfile")?.checked;
      const m = telemetry.snapshot();
      const payload = {
        connectorId,
        transactionId,
        meterValue: [
          {
            timestamp: new Date().toISOString(),
            sampledValue: (() => {
              const arr = [];
              arr.push({ value: Math.round(sessionMeterStart + m.energyWh).toString(), context: "Sample.Periodic", format: "Raw", measurand: "Energy.Active.Import.Register", unit: "Wh", location: "Outlet" });
              arr.push({ value: m.powerKW.toFixed(3), context: "Sample.Periodic", format: "Raw", measurand: "Power.Active.Import", unit: "kW", location: "Outlet" });
              arr.push({ value: Math.round(m.voltageV).toString(), context: "Sample.Periodic", format: "Raw", measurand: "Voltage", unit: "V", phase: "L1-N", location: "Outlet" });
              arr.push({ value: m.currentA.toFixed(2), context: "Sample.Periodic", format: "Raw", measurand: "Current.Import", unit: "A", phase: "L1", location: "Outlet" });
              arr.push({ value: m.temperatureC.toFixed(2), context: "Sample.Periodic", format: "Raw", measurand: "Temperature", unit: "Celsius", location: "Body" });
              // Enviar SoC sempre para compatibilidade com CSMS
              arr.push({ value: Math.round(m.soc).toString(), context: "Sample.Periodic", format: "Raw", measurand: "SoC", unit: "Percent" });
              return arr;
            })(),
          },
        ],
      };
      logLine(`[OCPP] MeterValues.sent periodic`, "info");
      ocpp.sendCall("MeterValues", payload).catch(() => {});
    }, meterIntervalMs);
  }

  function stopMeterValues() {
    if (meterValuesTimer) {
      clearInterval(meterValuesTimer);
      meterValuesTimer = null;
    }
  }

  function triggerStartWithWatchdog({ idTag, connectorId }) {
    let tries = 0;
    const run = () => {
      tries += 1;
      logLine(`[OCPP] Start.watchdog.attempt=${tries}/3`, "info");
      try { startTransactionFlow({ idTag, connectorId }); } catch(e){}
      if (tries < 3) {
        const delay = tries === 1 ? 1500 : 3000;
        setTimeout(() => {
          if (!transactionId) {
            logLine(`[OCPP] Start.watchdog.retry_next=${tries + 1}/3`, "err");
            run();
          }
        }, delay);
      }
    };
    try { sendStatus("Preparing", connectorId); } catch(e){}
    run();
  }

  function handleRemoteStart({ idTag, connectorId }) {
    logLine(`[OCPP] RemoteStart.received idTag=${idTag} connectorId=${connectorId}`, "info");
    logLine(`RemoteStart recebido idTag=${idTag} connectorId=${connectorId}`, "info");
    try { console.log('[OCPP] RemoteStart.received', { idTag, connectorId }); } catch(e){}
    try { state.setState(ChargeState.Preparing); setStatusBadge(state.state); } catch(e){}
    try { sendStatus("Preparing", connectorId); } catch(e){}
    try { startChargingSession({ idTag, connectorId }); } catch(e){}
  }

  function sendBeginMeterValues({ connectorId, transactionId, meterStart, realProfile }) {
    if (!ocpp || !ocpp.ws || ocpp.ws.readyState !== WebSocket.OPEN) return;
    const m = telemetry.snapshot();
    const sampled = [];
    sampled.push({ value: Math.round(meterStart).toString(), context: "Transaction.Begin", format: "Raw", measurand: "Energy.Active.Import.Register", unit: "Wh", location: "Outlet" });
    sampled.push({ value: m.powerKW.toFixed(3), context: "Transaction.Begin", format: "Raw", measurand: "Power.Active.Import", unit: "kW", location: "Outlet" });
    sampled.push({ value: Math.round(m.voltageV).toString(), context: "Transaction.Begin", format: "Raw", measurand: "Voltage", unit: "V", phase: "L1-N", location: "Outlet" });
    sampled.push({ value: m.currentA.toFixed(2), context: "Transaction.Begin", format: "Raw", measurand: "Current.Import", unit: "A", phase: "L1", location: "Outlet" });
    sampled.push({ value: m.temperatureC.toFixed(2), context: "Transaction.Begin", format: "Raw", measurand: "Temperature", unit: "Celsius", location: "Body" });
    sampled.push({ value: Math.round(m.soc).toString(), context: "Transaction.Begin", format: "Raw", measurand: "SoC", unit: "Percent" });
    const payload = {
      connectorId,
      transactionId,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: sampled,
        },
      ],
    };
    logLine(`[OCPP] MeterValues.sent begin`, "info");
    ocpp.sendCall("MeterValues", payload).catch(() => {});
  }

  function sendEndMeterValues({ connectorId, transactionId, meterStop, realProfile }) {
    if (!ocpp || !ocpp.ws || ocpp.ws.readyState !== WebSocket.OPEN) return;
    const m = telemetry.snapshot();
    const sampled = [];
    sampled.push({ value: Math.round(meterStop).toString(), context: "Transaction.End", format: "Raw", measurand: "Energy.Active.Import.Register", unit: "Wh", location: "Outlet" });
    sampled.push({ value: m.powerKW.toFixed(3), context: "Transaction.End", format: "Raw", measurand: "Power.Active.Import", unit: "kW", location: "Outlet" });
    sampled.push({ value: Math.round(m.voltageV).toString(), context: "Transaction.End", format: "Raw", measurand: "Voltage", unit: "V", phase: "L1-N", location: "Outlet" });
    sampled.push({ value: m.currentA.toFixed(2), context: "Transaction.End", format: "Raw", measurand: "Current.Import", unit: "A", phase: "L1", location: "Outlet" });
    sampled.push({ value: m.temperatureC.toFixed(2), context: "Transaction.End", format: "Raw", measurand: "Temperature", unit: "Celsius", location: "Body" });
    sampled.push({ value: Math.round(m.soc).toString(), context: "Transaction.End", format: "Raw", measurand: "SoC", unit: "Percent" });
    const payload = {
      connectorId,
      transactionId,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: sampled,
        },
      ],
    };
    ocpp.sendCall("MeterValues", payload).catch(() => {});
  }

  function saveSessionHistory() {
    const m = telemetry.snapshot();
    const item = {
      startTime: m.sessionStart ? new Date(m.sessionStart).toISOString() : null,
      endTime: new Date().toISOString(),
      durationMin: m.durationMin,
      energyKWh: m.energyKWh,
      avgPowerKW: m.durationMin > 0 ? (m.energyKWh / (m.durationMin / 60)) : m.powerKW,
      totalCost: m.totalCost,
      pricePerKWh: m.pricePerKWh,
    };
    const key = `ocpp.sessions.${$("chargePointId").value || "default"}`;
    const arr = JSON.parse(localStorage.getItem(key) || "[]");
    arr.push(item);
    localStorage.setItem(key, JSON.stringify(arr));
    renderHistory(arr);
  }

  function renderHistory(arr) {
    const ul = $("historyList");
    ul.innerHTML = "";
    if (!arr) return;
    arr.slice().reverse().forEach((s) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <span>Início: ${s.startTime ? new Date(s.startTime).toLocaleString() : "--"}</span>
        <span>Duração: ${s.durationMin} min</span>
        <span>Energia: ${format3(s.energyKWh)} kWh</span>
        <span>Custo: R$ ${format2(s.totalCost)}</span>
        <span>Potência média: ${format2(s.avgPowerKW)} kW</span>
      `;
      ul.appendChild(li);
    });
  }

  function exportHistory() {
    const key = `ocpp.sessions.${$("chargePointId").value || "default"}`;
    const arr = JSON.parse(localStorage.getItem(key) || "[]");
    const blob = new Blob([JSON.stringify(arr, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sessions-${$("chargePointId").value || "default"}.json`;
    document.body.appendChild(a);
    a.click();
    URL.revokeObjectURL(url);
    a.remove();
  }

  // Handlers de chamadas CSMS -> CP
  function handleInbound({ id, action, payload }) {
    switch (action) {
      case "RemoteStartTransaction": {
        ocpp.sendResult(id, { status: "Accepted" });
        startChargingSession({ 
          idTag: String((payload && payload.idTag) || $("idTag").value || "IGEA-USER-001"), 
          connectorId: Number((payload && payload.connectorId) || $("connectorId").value || 1),
          skipAuthorize: true
        });
        break;
      }
      case "RemoteStopTransaction": {
        ocpp.sendResult(id, { status: "Accepted" });
        stopTransactionFlow("Remote");
        break;
      }
      case "Reset": {
        ocpp.sendResult(id, { status: "Accepted" });
        // Simples: reinicia estado
        state.setState(ChargeState.Available);
        break;
      }
      case "UnlockConnector": {
        ocpp.sendResult(id, { status: "Accepted" });
        break;
      }
      case "ChangeAvailability": {
        ocpp.sendResult(id, { status: "Accepted" });
        break;
      }
      case "ChangeConfiguration": {
        ocpp.sendResult(id, { status: "Accepted" });
        break;
      }
      case "SetChargingProfile": {
        try {
          const cp = payload && payload.chargingProfile;
          const sch = cp && cp.chargingSchedule;
          const unit = sch && sch.chargingRateUnit;
          const periods = sch && sch.chargingSchedulePeriod;
          const first = Array.isArray(periods) && periods[0];
          if (unit === "W" && first && first.limit != null) {
            const limitKW = Number(first.limit) / 1000;
            telemetry.applyConfig({ maxPowerKW: Math.max(0.5, limitKW) });
          } else if (unit === "A" && first && first.limit != null) {
            const limitA = Number(first.limit);
            const limitKW = (limitA * telemetry.nominalVoltage) / 1000;
            telemetry.applyConfig({ maxCurrentA: Math.max(1, limitA), maxPowerKW: Math.max(0.5, limitKW) });
          }
        } catch(e){}
        ocpp.sendResult(id, { status: "Accepted" });
        break;
      }
      case "ClearChargingProfile": {
        telemetry.applyConfig({ maxPowerKW: telemetryDefaultMaxPowerKW, maxCurrentA: telemetryDefaultMaxCurrentA });
        ocpp.sendResult(id, { status: "Accepted" });
        break;
      }
      default: {
        ocpp.sendError(id, "NotSupported", `Ação ${action} não suportada`, {});
      }
    }
  }

  // Bind UI
  function init() {
    // Parse URL params
    const params = new URLSearchParams(window.location.search);
    const pCpId = params.get("id") || params.get("cpId");
    const pUrl = params.get("url") || params.get("endpoint");
    const pConn = params.get("connector") || params.get("connectorId");
    const pTag = params.get("tag") || params.get("idTag");

    // Pre-popular campos com valores úteis ou params
    $("endpointUrl").value = pUrl || "ws://127.0.0.1:3000/ocpp/CentralSystemService/DRBAKANA-TEST-03";
    $("subprotocols").value = "ocpp1.6j";
    $("chargePointId").value = pCpId || "DRBAKANA-TEST-03";
    $("connectorId").value = pConn || 1;
    $("idTag").value = pTag || "IGEA-USER-001";
    
    // Ajusta endpoint se CP ID mudou via param mas URL não
    if (pCpId && !pUrl && $("endpointUrl").value.includes("CentralSystemService/")) {
        const parts = $("endpointUrl").value.split("CentralSystemService/");
        $("endpointUrl").value = `${parts[0]}CentralSystemService/${pCpId}`;
    }

    $("meterStart").value = 0;
    $("meterStop").value = 0;
    $("pricePerKWh").value = telemetry.pricePerKWh;
    $("cpName").textContent = $("chargePointId").value || "Charge Point";
    setWsStatus("");

    // Defaults para novos controles
    if ($("meterIntervalSec")) $("meterIntervalSec").value = 10;
    if ($("realProfile")) $("realProfile").checked = true;

    // History inicial isolado
    const key = `ocpp.sessions.${$("chargePointId").value || "default"}`;
    renderHistory(JSON.parse(localStorage.getItem(key) || "[]"));

    $("btnConnect").onclick = () => {
      const url = buildUrl();
      const subs = getSubprotocols();
      if (!url) {
        logLine("Endpoint inválido. Configure URL e Id CP.", "err");
        return;
      }
      const attempts = [];
      if (subs && subs.length > 1) {
        attempts.push(subs);
        attempts.push([subs[0]]);
        attempts.push([subs[1]]);
      } else {
        attempts.push(subs || ["ocpp1.6"]);
        attempts.push(["ocpp1.6"]);
        attempts.push(["ocpp1.6j"]);
      }
      let idx = 0;
      const tryNext = () => {
        const s = attempts[idx] || attempts[attempts.length - 1];
        setWsStatus("Conectando…");
        logLine(`Tentando conectar ${url} com subprotocol(s): ${s.join(",")}`, "info");
        let opened = false;
        ocpp = new OCPPClient({
          url,
          subprotocols: s,
          onOpen: () => { opened = true; setWsStatus("Conectado"); setFlowHint("Conectado — enviando BootNotification…"); logLine(`[OCPP] BootNotification.sent`, "info"); bootSequence(); installRemoteHook(); },
          onClose: () => {
            if (!opened && idx < attempts.length - 1) {
              idx += 1;
              logLine("Handshake falhou. Alternando subprotocol(s).", "err");
              tryNext();
              return;
            }
            setWsStatus("Desconectado");
          },
          onMessage: handleInbound,
        });
        ocpp.connect();
      };
      tryNext();
    };

    $("btnDisconnect").onclick = () => {
      if (ocpp) ocpp.disconnect();
    };

    $("btnStart").onclick = () => {
      if (!ocpp || !ocpp.ws || ocpp.ws.readyState !== WebSocket.OPEN) {
        logLine("Conecte ao CSMS antes de iniciar.", "err");
        return;
      }
      startChargingSession();
    };

    $("btnStop").onclick = () => {
      if (!transactionId) return;
      stopTransactionFlow("Local");
    };

    $("btnClearLog").onclick = () => {
      $("logOutput").textContent = "";
    };

    $("btnExportHistory").onclick = exportHistory;

    $("pricePerKWh").onchange = (e) => {
      telemetry.setPricePerKWh(Number(e.target.value || telemetry.pricePerKWh));
    };

    // Modal handlers
    if ($("goalModalClose")) {
      $("goalModalClose").onclick = hideGoalModal;
    }
  }

  document.addEventListener("DOMContentLoaded", init);
  // Auto-conectar ao carregar para realizar verificações no CP solicitado
  document.addEventListener("DOMContentLoaded", () => {
    // Valores já tratados no init via URL params ou defaults
    window.DEFAULT_IDTAG = $("idTag").value || "IGEA-USER-001";
    window.DEFAULT_CONNECTOR_ID = Number($("connectorId").value || 1);
    
    // Auto-conectar apenas se flag 'autoconnect' estiver na URL
    const params = new URLSearchParams(window.location.search);
    if (params.has("autoconnect") || params.has("auto")) {
      setTimeout(() => { if ($("btnConnect")) $("btnConnect").click(); }, 300);
    }
  });
  startTransactionFlow = startChargingSession;
  window.startTransactionFlow = startTransactionFlow;
  window.startChargingSession = startChargingSession;
  window.stopTransactionFlow = stopTransactionFlow;
  window.handleRemoteStart = handleRemoteStart;
  window.getOcppWs = function () { return ocpp && ocpp.ws ? ocpp.ws : null; };
  window.debugConnectCP = function () { const b = $("btnConnect"); if (b) b.click(); };
  window.debugStartFlow = function (opts) { startChargingSession(opts || {}); };
  window.debugStartTx = function (opts) { startChargingSession(opts || {}); };
  window.debugStopTx = function () { stopTransactionFlow("Local"); };
  window.debugStopFlow = function () { stopTransactionFlow("Local"); };
  window.ocppConnection = {
    connect: function () { const b = $("btnConnect"); if (b) b.click(); },
    disconnect: function () { const b = $("btnDisconnect"); if (b) b.click(); },
    ws: function () { return ocpp && ocpp.ws ? ocpp.ws : null; },
  };
  window.ocppMessages = {
    BootNotification: function (p) { return ocpp && ocpp.sendCall("BootNotification", p || { chargePointVendor: "IGE2A", chargePointModel: "Sim1.6J", firmwareVersion: "1.0.0" }); },
    Heartbeat: function () { return ocpp && ocpp.sendCall("Heartbeat", { chargePointModel: "Sim-1.0" }); },
    Authorize: function (idTag) { return ocpp && ocpp.sendCall("Authorize", { idTag: String(idTag || $("idTag").value || "IGEA-USER-001") }); },
    StartTransaction: function (payload) { return ocpp && ocpp.sendCall("StartTransaction", payload); },
    StatusNotification: function (payload) { return ocpp && ocpp.sendCall("StatusNotification", payload); },
    MeterValues: function (payload) { return ocpp && ocpp.sendCall("MeterValues", payload); },
    StopTransaction: function (payload) { return ocpp && ocpp.sendCall("StopTransaction", payload); },
  };
  window.__ocppSendCall = function (action, payload) { if (!ocpp || !ocpp.ws || ocpp.ws.readyState !== WebSocket.OPEN) { try { console.log('[OCPP] CALL.skip', { action, reason: 'ws not open' }); } catch(e){} return Promise.reject(new Error('WS not open')); } return ocpp.sendCall(action, payload); };
  window.telemetryAPI = {
    snapshot: function(){ try { return telemetry && telemetry.snapshot ? telemetry.snapshot() : null; } catch(e){ return null; } },
    state: function(){ try { return state && state.state ? state.state : null; } catch(e){ return null; } },
    transactionId: function(){ try { return transactionId || null; } catch(e){ return null; } },
  };
  (function(){
    // IIFE de hooks remotos removida para evitar duplicidade
  })();
})();
