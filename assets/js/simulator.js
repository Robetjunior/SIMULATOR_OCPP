// Simulador OCPP 1.6J com UI, telemetria e máquina de estados

(function () {
  // Utilidades
  const $ = (id) => document.getElementById(id);
  const format2 = (n) => Number(n).toFixed(2);
  const format3 = (n) => Number(n).toFixed(3);

  function logLine(text, dir = "info") {
    const out = $("logOutput");
    const ts = new Date().toLocaleTimeString();
    const logMsg = `[${ts}] ${dir.toUpperCase()} ${text}`;
    if (out) {
      out.textContent += logMsg + "\n";
      out.scrollTop = out.scrollHeight;
    }
    console.log(logMsg);
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
      try { console.log(`[OCPP] CALL.out ${action} ${JSON.stringify(payload)}`); } catch(e){}
      this.ws.send(raw);
      logLine(`=> ${action} ${JSON.stringify(payload)}`, "out");
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            reject(new Error(`Timeout aguardando resposta de ${action}`));
          }
        }, 20000);
        this.pending.set(id, { resolve, reject, action, timeoutId });
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
            clearTimeout(pending.timeoutId);
            logLine(`<= ${pending.action} RES ${JSON.stringify(p3)}`, "in");
            pending.resolve(p3);
          }
          return;
        }
        if (type === 4) {
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            clearTimeout(pending.timeoutId);
            const err = new Error(`CALLERROR ${pending.action}: ${p3 || "UnknownError"} ${p4 || ""}`.trim());
            err.ocpp = { errorCode: p3, errorDescription: p4, details: msg[4] || {} };
            logLine(`<= ${pending.action} ERROR ${JSON.stringify(err.ocpp)}`, "err");
            pending.reject(err);
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
        this.sendCall("Heartbeat", {}).catch(() => {});
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
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let manualDisconnect = false;
  let autoReconnectEnabled = false;
  let bootRetryTimer = null;
  let sessionTimeline = [];
  let currentFault = null;
  let activeScenarioName = "normal";

  const SCENARIOS = {
    normal: { name: "normal", includeSoc: true, includeTemperature: true, pauseReason: null, injectFaultAtSec: null, postpaid: false },
    ev_pause: { name: "ev_pause", includeSoc: true, includeTemperature: true, pauseReason: "SuspendedEV", pauseAtSec: 20, pauseDurationSec: 10, postpaid: false },
    evse_pause: { name: "evse_pause", includeSoc: true, includeTemperature: true, pauseReason: "SuspendedEVSE", pauseAtSec: 20, pauseDurationSec: 10, postpaid: false },
    fault: { name: "fault", includeSoc: true, includeTemperature: true, injectFaultAtSec: 25, faultCode: "GroundFailure", postpaid: false },
    postpaid_full: { name: "postpaid_full", includeSoc: true, includeTemperature: true, stopReason: "Local", postpaid: true },
    missing_soc: { name: "missing_soc", includeSoc: false, includeTemperature: true, postpaid: false },
    missing_temperature: { name: "missing_temperature", includeSoc: true, includeTemperature: false, postpaid: false },
  };

  function recordTimeline(type, payload = {}) {
    sessionTimeline.push({
      type,
      at: new Date().toISOString(),
      state: state && state.state ? state.state : null,
      transactionId: transactionId || null,
      payload,
    });
  }

  function clearBootRetry() {
    if (bootRetryTimer) {
      clearTimeout(bootRetryTimer);
      bootRetryTimer = null;
    }
  }

  function getScenarioName() {
    return ($("scenarioName") && $("scenarioName").value) || activeScenarioName || "normal";
  }

  function getScenarioDefinition() {
    const scenario = SCENARIOS[getScenarioName()];
    return scenario || SCENARIOS.normal;
  }

  function parseBooleanParam(value) {
    if (value == null) return null;
    const normalized = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return null;
  }

  function getMeasurementFlags(realProfile) {
    const scenario = getScenarioDefinition();
    const includeSoc = scenario.includeSoc !== false && !realProfile;
    const includeTemperature = scenario.includeTemperature !== false && !realProfile;
    return { includeSoc, includeTemperature };
  }

  function buildFaultStatusPayload() {
    const code = (currentFault && currentFault.errorCode) || "OtherError";
    return { errorCode: code, info: currentFault && currentFault.info ? currentFault.info : "" };
  }

  function transitionState(next, opts = {}) {
    const changed = state.setState(next);
    setStatusBadge(state.state);
    if (changed && opts.sendStatus !== false) {
      const connectorId = Number((opts && opts.connectorId) || $("connectorId").value || 1);
      const errorCode = opts.errorCode || (next === ChargeState.Faulted ? buildFaultStatusPayload().errorCode : "NoError");
      sendStatus(next, connectorId, errorCode);
    }
    if (changed) {
      recordTimeline("state_transition", { next, connectorId: opts.connectorId || Number($("connectorId").value || 1), errorCode: opts.errorCode || null });
    }
    return changed;
  }

  function injectFault(errorCode = "OtherError", info = "Fault injected by scenario") {
    currentFault = { errorCode, info };
    telemetry.setPaused(true);
    stopMeterValues();
    transitionState(ChargeState.Faulted, { errorCode });
    setFlowHint(`Falha simulada: ${errorCode}`);
    logLine(`[OCPP] StatusNotification.Faulted errorCode=${errorCode}`, "err");
    recordTimeline("fault_injected", { errorCode, info });
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(connectFn) {
    if (!autoReconnectEnabled || manualDisconnect || reconnectTimer) return;
    reconnectAttempt += 1;
    const delayMs = Math.min(15000, Math.max(1000, 1000 * Math.pow(2, Math.min(reconnectAttempt - 1, 4))));
    setWsStatus(`Reconectando em ${Math.ceil(delayMs / 1000)}s…`);
    setFlowHint(`CSMS indisponivel — tentativa ${reconnectAttempt}`);
    logLine(`WebSocket fechado. Agendando reconexão em ${delayMs}ms (tentativa ${reconnectAttempt}).`, "err");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectFn(true);
    }, delayMs);
  }

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
      const scenario = getScenarioDefinition();
      const elapsed = telemetry.elapsedSec || 0;

      if (transactionId && !currentFault && scenario.injectFaultAtSec && elapsed >= scenario.injectFaultAtSec) {
        injectFault(scenario.faultCode || "OtherError", `Scenario ${scenario.name}`);
        return;
      }

      if (transactionId && !currentFault && scenario.pauseReason && scenario.pauseAtSec != null) {
        const pauseEnd = scenario.pauseAtSec + (scenario.pauseDurationSec || 0);
        if (elapsed >= scenario.pauseAtSec && elapsed < pauseEnd) {
          telemetry.setPaused(true);
          transitionState(scenario.pauseReason, { sendStatus: true });
        } else if (elapsed >= pauseEnd && (state.state === ChargeState.SuspendedEV || state.state === ChargeState.SuspendedEVSE)) {
          telemetry.setPaused(false);
          transitionState(ChargeState.Charging, { sendStatus: true });
        }
      }

      // Auto-parar ao atingir meta de SoC
      const targetSocCfg = Number($("targetSoc").value || telemetry.targetSoc || 80);
      if (transactionId && !currentFault && m.soc >= targetSocCfg) {
        if (!goalModalShown) { goalModalShown = true; showGoalModal(Math.round(m.soc)); }
        stopTransactionFlow("UserDefinedLimit");
        return;
      }

      // Suspensão automática quando cenário ou carga zeram potência por tempo suficiente.
      if (state.state === ChargeState.Charging) {
        if (m.powerKW < 0.05) {
          lastZeroPowerSec += 1;
          if (lastZeroPowerSec >= 5) {
            telemetry.setPaused(true);
            transitionState(ChargeState.SuspendedEV, { sendStatus: true });
          }
        } else {
          lastZeroPowerSec = 0;
          if (state.state === ChargeState.SuspendedEV || state.state === ChargeState.SuspendedEVSE) {
            telemetry.setPaused(false);
            transitionState(ChargeState.Charging, { sendStatus: true });
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

  function sendStatus(status, connectorId = Number($("connectorId").value || 1), errorCode = "NoError") {
    if (!ocpp || !ocpp.ws || ocpp.ws.readyState !== WebSocket.OPEN) return;
    ocpp
      .sendCall("StatusNotification", {
        connectorId,
        errorCode,
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
    clearBootRetry();
    recordTimeline("boot_start", { chargePointId: $("chargePointId").value || "" });
    ocpp
      .sendCall("BootNotification", {
        chargePointVendor: "IGE2A",
        chargePointModel: "Sim1.6J",
        firmwareVersion: "1.0.0",
      })
      .then((res) => {
        logLine(`[OCPP] BootNotification.conf status=${res && res.status ? res.status : ""} interval=${res && res.interval ? res.interval : ""}`, "info");
        setFlowHint(`BootNotification.${res && res.status ? res.status : ""} — heartbeat ${(Number(res && res.interval) || 60)}s`);
        recordTimeline("boot_conf", res || {});
        if (res && res.status === "Accepted") {
          const interval = Number(res.interval) || 60;
          ocpp.startHeartbeat(interval);
          currentFault = null;
          transitionState(ChargeState.Available, { sendStatus: true });
          return;
        }
        if (res && res.status === "Pending") {
          const retryMs = Math.max(5000, (Number(res.interval) || 30) * 1000);
          setWsStatus("Boot pendente");
          logLine(`BootNotification pendente. Nova tentativa em ${Math.ceil(retryMs / 1000)}s.`, "info");
          clearBootRetry();
          bootRetryTimer = setTimeout(() => bootSequence(), retryMs);
          return;
        }
        if (res && res.status === "Rejected") {
          setWsStatus("Boot rejeitado");
          setFlowHint("BootNotification rejeitado pelo CSMS");
          transitionState(ChargeState.Unavailable, { sendStatus: false });
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
          transitionState(ChargeState.Preparing, { sendStatus: true });
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
    return startChargingSession(opts);
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
    sessionMeterStart = meterStart;
    const targetSoc = Number($("targetSoc").value || 80);
    const fastMode = $("fastMode").checked;
    const userIntervalSec = Number($("meterIntervalSec")?.value || 0);
    const realProfile = !!$("realProfile")?.checked;
    const fastInitialSoc = Math.max(20, Math.min(targetSoc - 1, targetSoc - 10));
    const seed = Number(($("seedValue") && $("seedValue").value) || Date.now());
    const scenario = getScenarioDefinition();
    const measurementFlags = getMeasurementFlags(realProfile);
    currentFault = null;
    sessionTimeline = [];
    activeScenarioName = scenario.name;
    recordTimeline("session_start_requested", {
      connectorId,
      idTag,
      scenario: activeScenarioName,
      realProfile,
      includeSoc: measurementFlags.includeSoc,
      includeTemperature: measurementFlags.includeTemperature,
    });
    telemetry.reset();
    telemetry.setPricePerKWh(Number($("pricePerKWh").value || telemetry.pricePerKWh));
    telemetry.applyConfig({ targetSoc, initialSoc: 20, timeTargetMin: 5, seed });
    if (fastMode) {
      telemetry.applyConfig({
        maxPowerKW: 50,
        rampUpSeconds: 2,
        taperStartSoc: 95,
        batteryCapacityKWh: 12,
        nominalVoltage: 400,
        maxCurrentA: 125,
        initialSoc: fastInitialSoc,
      });
      meterIntervalMs = 2000;
      setFlowHint(`Modo rápido ativo — SoC inicial ${fastInitialSoc}% e meta ${targetSoc}% para concluir em cerca de 1min30s.`);
    } else {
      telemetry.applyConfig({ maxPowerKW: 7, rampUpSeconds: 20, taperStartSoc: 70, batteryCapacityKWh: 40, nominalVoltage: 230, maxCurrentA: 32, initialSoc: 20 });
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
    transitionState(ChargeState.Preparing, { connectorId, sendStatus: true });
    logLine(`[OCPP] StatusNotification.Preparing sent (Cable Plugged)`, "info");
    logLine(`[OCPP] Session.measurements realProfile=${realProfile} includeSoc=${measurementFlags.includeSoc} includeTemperature=${measurementFlags.includeTemperature} scenario=${scenario.name}`, "info");
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
      telemetry.setPaused(false);
      transitionState(ChargeState.Charging, { connectorId, sendStatus: true });
      logLine(`[OCPP] StatusNotification.Charging`, "info");
      setFlowHint(`Charging ativo — transactionId=${transactionId || "?"}`);
      uiFlags.starting = false;
      setStartLabel("Iniciar Carregamento");
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

  function addSample(sampled, value, extra) {
    if (value == null || Number.isNaN(Number(value))) return;
    sampled.push({ value: String(value), ...extra });
  }

  function buildSampledValues(context, meterRegister, metrics, realProfile) {
    const sampled = [];
    const flags = getMeasurementFlags(realProfile);
    addSample(sampled, Math.round(meterRegister), { context, format: "Raw", measurand: "Energy.Active.Import.Register", unit: "Wh", location: "Outlet" });
    addSample(sampled, Number(metrics.powerKW).toFixed(3), { context, format: "Raw", measurand: "Power.Active.Import", unit: "kW", location: "Outlet" });
    addSample(sampled, Math.round(metrics.voltageV), { context, format: "Raw", measurand: "Voltage", unit: "V", phase: "L1-N", location: "Outlet" });
    addSample(sampled, Number(metrics.currentA).toFixed(2), { context, format: "Raw", measurand: "Current.Import", unit: "A", phase: "L1", location: "Outlet" });
    if (flags.includeTemperature) {
      addSample(sampled, Number(metrics.temperatureC).toFixed(2), { context, format: "Raw", measurand: "Temperature", unit: "Celsius", location: "Body" });
    }
    if (flags.includeSoc) {
      addSample(sampled, Math.round(metrics.soc), { context, format: "Raw", measurand: "SoC", unit: "Percent" });
    }
    return sampled;
  }

  function stopTransactionFlow(reason = "Local") {
    if (!transactionId && state.state !== ChargeState.Faulted) return;
    const connectorId = Number($("connectorId").value || 1);
    const idTag = $("idTag").value.trim() || "DEMO-TAG";
    const realProfile = !!$("realProfile")?.checked;
    telemetry.setPaused(true);
    const finalMetrics = telemetry.update(0);
    const meterStop = Number($("meterStop").value || Math.ceil(sessionMeterStart + finalMetrics.energyWh));

    uiFlags.stopping = true;
    setStopLabel("Parando…");
    setStatusBadge(state.state);
    stopMeterValues();
    setFlowHint("Parando sessão…");

    transitionState(ChargeState.Finishing, { connectorId, sendStatus: true });
    logLine(`[OCPP] StatusNotification.Finishing`, "info");
    sendEndMeterValues({ connectorId, transactionId, meterStop, realProfile, metrics: finalMetrics });

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
        telemetry.stop();
        stopUiLoop();
        resetUiIndicators();
        currentFault = null;
        transitionState(ChargeState.Available, { connectorId, sendStatus: true });
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
      if (!transactionId || currentFault) return;
      const connectorId = Number($("connectorId").value || 1);
      const realProfile = !!$("realProfile")?.checked;
      const m = telemetry.snapshot();
      const payload = {
        connectorId,
        transactionId,
        meterValue: [
          {
            timestamp: new Date().toISOString(),
            sampledValue: buildSampledValues("Sample.Periodic", sessionMeterStart + m.energyWh, m, realProfile),
          },
        ],
      };
      logLine(`[OCPP] MeterValues.sent periodic`, "info");
      recordTimeline("meter_values_periodic", { meterRegister: Math.round(sessionMeterStart + m.energyWh) });
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
    try { transitionState(ChargeState.Preparing, { connectorId, sendStatus: true }); } catch(e){}
    try { startChargingSession({ idTag, connectorId }); } catch(e){}
  }

  function sendBeginMeterValues({ connectorId, transactionId, meterStart, realProfile }) {
    if (!ocpp || !ocpp.ws || ocpp.ws.readyState !== WebSocket.OPEN) return;
    const m = telemetry.snapshot();
    const payload = {
      connectorId,
      transactionId,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: buildSampledValues("Transaction.Begin", meterStart, m, realProfile),
        },
      ],
    };
    logLine(`[OCPP] MeterValues.sent begin`, "info");
    recordTimeline("meter_values_begin", { meterRegister: Math.round(meterStart) });
    ocpp.sendCall("MeterValues", payload).catch(() => {});
  }

  function sendEndMeterValues({ connectorId, transactionId, meterStop, realProfile, metrics }) {
    if (!ocpp || !ocpp.ws || ocpp.ws.readyState !== WebSocket.OPEN) return;
    const m = metrics || telemetry.snapshot();
    const payload = {
      connectorId,
      transactionId,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: buildSampledValues("Transaction.End", meterStop, m, realProfile),
        },
      ],
    };
    recordTimeline("meter_values_end", { meterRegister: Math.round(meterStop) });
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
      scenario: activeScenarioName,
      timeline: sessionTimeline.slice(),
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
        currentFault = null;
        telemetry.stop();
        transitionState(ChargeState.Available, { sendStatus: true });
        break;
      }
      case "UnlockConnector": {
        ocpp.sendResult(id, { status: "Accepted" });
        break;
      }
      case "ChangeAvailability": {
        if (payload && payload.type === "Inoperative") {
          transitionState(ChargeState.Unavailable, { sendStatus: true });
        } else {
          transitionState(ChargeState.Available, { sendStatus: true });
        }
        ocpp.sendResult(id, { status: "Accepted" });
        break;
      }
      case "ChangeConfiguration": {
        if (payload && payload.key === "HeartbeatInterval") {
          const intervalSec = Number(payload.value);
          if (intervalSec > 0) {
            ocpp.startHeartbeat(intervalSec);
          }
        }
        if (payload && payload.key === "MeterValueSampleInterval") {
          const intervalSec = Number(payload.value);
          if (intervalSec > 0) {
            meterIntervalMs = intervalSec * 1000;
            if (transactionId) {
              stopMeterValues();
              startMeterValues();
            }
          }
        }
        ocpp.sendResult(id, { status: "Accepted" });
        break;
      }
      case "TriggerMessage": {
        const requestedMessage = payload && payload.requestedMessage;
        ocpp.sendResult(id, { status: "Accepted" });
        if (requestedMessage === "BootNotification") bootSequence();
        if (requestedMessage === "Heartbeat") ocpp.sendCall("Heartbeat", {}).catch(() => {});
        if (requestedMessage === "StatusNotification") sendStatus(state.state || "Available");
        if (requestedMessage === "MeterValues" && transactionId) {
          const realProfile = !!$("realProfile")?.checked;
          const m = telemetry.snapshot();
          ocpp.sendCall("MeterValues", {
            connectorId: Number($("connectorId").value || 1),
            transactionId,
            meterValue: [{ timestamp: new Date().toISOString(), sampledValue: buildSampledValues("Sample.Periodic", sessionMeterStart + m.energyWh, m, realProfile) }],
          }).catch(() => {});
        }
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
    const pScenario = params.get("scenario");
    const pSeed = params.get("seed");
    const pRealProfile = parseBooleanParam(params.get("realProfile"));

    // Pre-popular campos com valores úteis ou params
    $("endpointUrl").value = pUrl || "ws://34.60.202.171:80/ocpp/CentralSystemService/DRBAKANA-TEST-03";
    $("subprotocols").value = "ocpp1.6j";
    $("chargePointId").value = pCpId || "DRBAKANA-TEST-03";
    $("connectorId").value = pConn || 1;
    $("idTag").value = pTag || "IGEA-USER-001";
    
    // Ajusta endpoint se CP ID mudou via param mas URL não
    if (pCpId && $("endpointUrl").value.includes("CentralSystemService/")) {
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
    if ($("realProfile")) $("realProfile").checked = pRealProfile === null ? false : pRealProfile;
    if ($("scenarioName")) {
      $("scenarioName").value = pScenario && SCENARIOS[pScenario] ? pScenario : "normal";
      activeScenarioName = $("scenarioName").value;
    }
    if ($("seedValue")) $("seedValue").value = pSeed || "12345";

    // History inicial isolado
    const key = `ocpp.sessions.${$("chargePointId").value || "default"}`;
    renderHistory(JSON.parse(localStorage.getItem(key) || "[]"));

    const connectFlow = (isReconnect = false) => {
      const url = buildUrl();
      const subs = getSubprotocols();
      if (!url) {
        logLine("Endpoint inválido. Configure URL e Id CP.", "err");
        return;
      }
      manualDisconnect = false;
      autoReconnectEnabled = true;
      clearReconnectTimer();
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
        setWsStatus(isReconnect ? "Reconectando…" : "Conectando…");
        logLine(`Tentando conectar ${url} com subprotocol(s): ${s.join(",")}`, isReconnect ? "err" : "info");
        let opened = false;
        ocpp = new OCPPClient({
          url,
          subprotocols: s,
          onOpen: () => {
            opened = true;
            reconnectAttempt = 0;
            clearReconnectTimer();
            setWsStatus("Conectado");
            setFlowHint("Conectado — enviando BootNotification…");
            logLine(`[OCPP] BootNotification.sent`, "info");
            bootSequence();
            installRemoteHook();
          },
          onClose: () => {
            if (!opened && idx < attempts.length - 1) {
              idx += 1;
              logLine("Handshake falhou. Alternando subprotocol(s).", "err");
              tryNext();
              return;
            }
            setWsStatus("Desconectado");
            scheduleReconnect(() => connectFlow(true));
          },
          onMessage: handleInbound,
        });
        ocpp.connect();
      };
      tryNext();
    };

    $("btnConnect").onclick = () => {
      connectFlow(false);
    };

    $("btnDisconnect").onclick = () => {
      manualDisconnect = true;
      autoReconnectEnabled = false;
      reconnectAttempt = 0;
      clearReconnectTimer();
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
    if ($("scenarioName")) {
      $("scenarioName").onchange = (e) => {
        activeScenarioName = e.target.value || "normal";
        const isRealistic = activeScenarioName === "missing_soc" || activeScenarioName === "missing_temperature";
        if ($("realProfile") && isRealistic) $("realProfile").checked = false;
      };
    }

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
    Heartbeat: function () { return ocpp && ocpp.sendCall("Heartbeat", {}); },
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
