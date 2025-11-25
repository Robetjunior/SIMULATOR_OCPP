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
    if (stopBtn) stopBtn.disabled = state !== ChargeState.Charging || Boolean(uiFlags.stopping);
    if (startBtn) startBtn.disabled = !(state === ChargeState.Available || state === ChargeState.Preparing) || !isWsOpen() || Boolean(uiFlags.starting);
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
      this.ws.send(JSON.stringify(frame));
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
  let meterValuesTimer = null;
  let uiTimer = null;
  let lastZeroPowerSec = 0;
  const setWsStatus = (text) => { const el = $("wsStatus"); if (el) el.textContent = text || ""; };
  let meterIntervalMs = 5000;

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
    try {
      const s = window.getOcppWs && window.getOcppWs();
      if (!s) return;
      if (window._remoteHookEnabled) return;
      window._remoteHookEnabled = true;
      s.addEventListener("message", function(ev){
        let m;
        try { m = JSON.parse(ev.data); } catch(e){ return; }
        if (Array.isArray(m) && m[0] === 2 && m[2] === "RemoteStartTransaction"){
          const uid = m[1];
          const p = m[3] || {};
          const idTag = String(p.idTag || window.DEFAULT_IDTAG || "IGEA-USER-001");
          const connectorId = Number(p.connectorId || window.DEFAULT_CONNECTOR_ID || 1);
          try { s.send(JSON.stringify([3, uid, { status: "Accepted" }])); } catch(e){}
          try { window.startTransactionFlow({ idTag, connectorId }); } catch(e){}
        }
        if (Array.isArray(m) && m[0] === 2 && m[2] === "RemoteStopTransaction"){
          const uid = m[1];
          try { s.send(JSON.stringify([3, uid, { status: "Accepted" }])); } catch(e){}
          try { window.stopTransactionFlow("Remote"); } catch(e){}
        }
      });
    } catch(e){}
  }

  function bootSequence() {
    ocpp
      .sendCall("BootNotification", {
        chargePointVendor: "IGE2A",
        chargePointModel: "Sim1.6J",
        firmwareVersion: "1.0.0",
      })
      .then((res) => {
        if (res && res.status === "Accepted") {
          const interval = Number(res.interval) || 60;
          ocpp.startHeartbeat(interval);
          sendStatus("Available");
        }
      })
      .catch((err) => logLine(`BootNotification falhou: ${err.message}`, "err"));
  }

  function authorizeFlow(idTag) {
    return ocpp
      .sendCall("Authorize", { idTag })
      .then((res) => {
        if (res && res.idTagInfo && res.idTagInfo.status === "Accepted") {
          state.authorizeAccepted();
          sendStatus("Preparing");
          return true;
        }
        return false;
      });
  }

  function startTransactionFlow(opts) {
    const connectorId = Number((opts && opts.connectorId) || $("connectorId").value || 1);
    const idTag = String((opts && opts.idTag) || $("idTag").value.trim() || "DEMO-TAG");
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
      telemetry.applyConfig({ maxPowerKW: 22, rampUpSeconds: 5, taperStartSoc: 90, batteryCapacityKWh: 2 });
      meterIntervalMs = 3000;
    } else {
      telemetry.applyConfig({ maxPowerKW: 7, rampUpSeconds: 20, taperStartSoc: 70, batteryCapacityKWh: 80 });
      meterIntervalMs = 5000;
    }
    if (userIntervalSec && userIntervalSec > 0) {
      meterIntervalMs = userIntervalSec * 1000;
    }
    telemetry.start(Date.now());
    $("startTime").textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    goalModalShown = false;

    uiFlags.starting = true;
    setStartLabel("Iniciando…");
    setStatusBadge(state.state);
    authorizeFlow(idTag)
      .then((ok) => {
        if (!ok) throw new Error("Authorize rejeitado");
        return ocpp.sendCall("StartTransaction", {
          connectorId,
          idTag,
          timestamp: new Date().toISOString(),
          meterStart,
        });
      })
      .then((res) => {
        transactionId = res.transactionId || res.transaction_id || transactionId;
        state.startTransaction();
        sendStatus("Charging");
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

  function resetUiIndicators() {
    $("powerKW").textContent = format2(0);
    $("voltageV").textContent = "0";
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
    const meterStop = Number($("meterStop").value || Math.ceil(telemetry.energyWh));
    const realProfile = !!$("realProfile")?.checked;

    uiFlags.stopping = true;
    setStopLabel("Parando…");
    setStatusBadge(state.state);
    stopMeterValues();

    // MeterValues com contexto de fim da transação
    sendEndMeterValues({
      connectorId,
      transactionId,
      meterStop,
      realProfile,
    });

    sendStatus("Finishing", connectorId);

    ocpp
      .sendCall("StopTransaction", {
        transactionId,
        timestamp: new Date().toISOString(),
        meterStop,
        idTag,
        reason,
      })
      .then(() => {
        state.stopTransaction();
        saveSessionHistory();
        stopUiLoop();
        resetUiIndicators();
        sendStatus("Available", connectorId);
        state.finishToAvailable(2000);
        transactionId = null;
        uiFlags.stopping = false;
        setStopLabel("Parar Carregamento");
        setStartLabel("Iniciar Carregamento");
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
              arr.push({ value: (m.energyWh / 1000).toFixed(3), context: "Sample.Periodic", format: "Raw", measurand: "Energy.Active.Import.Register", unit: "kWh", location: "Outlet" });
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
      ocpp.sendCall("MeterValues", payload).catch(() => {});
    }, meterIntervalMs);
  }

  function stopMeterValues() {
    if (meterValuesTimer) {
      clearInterval(meterValuesTimer);
      meterValuesTimer = null;
    }
  }

  function sendBeginMeterValues({ connectorId, transactionId, meterStart, realProfile }) {
    if (!ocpp || !ocpp.ws || ocpp.ws.readyState !== WebSocket.OPEN) return;
    const m = telemetry.snapshot();
    const sampled = [];
    sampled.push({ value: (meterStart / 1000).toFixed(3), context: "Transaction.Begin", format: "Raw", measurand: "Energy.Active.Import.Register", unit: "kWh", location: "Outlet" });
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
    ocpp.sendCall("MeterValues", payload).catch(() => {});
  }

  function sendEndMeterValues({ connectorId, transactionId, meterStop, realProfile }) {
    if (!ocpp || !ocpp.ws || ocpp.ws.readyState !== WebSocket.OPEN) return;
    const m = telemetry.snapshot();
    const sampled = [];
    sampled.push({ value: (meterStop / 1000).toFixed(3), context: "Transaction.End", format: "Raw", measurand: "Energy.Active.Import.Register", unit: "kWh", location: "Outlet" });
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
    const key = "ocpp.sessions";
    const arr = JSON.parse(localStorage.getItem(key) || "[]");
    arr.push(item);
    localStorage.setItem(key, JSON.stringify(arr));
    renderHistory(arr);
  }

  function renderHistory(arr) {
    const ul = $("historyList");
    ul.innerHTML = "";
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
    const key = "ocpp.sessions";
    const arr = JSON.parse(localStorage.getItem(key) || "[]");
    const blob = new Blob([JSON.stringify(arr, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "sessions.json";
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
        startTransactionFlow({ idTag: String((payload && payload.idTag) || $("idTag").value || "IGEA-USER-001"), connectorId: Number((payload && payload.connectorId) || $("connectorId").value || 1) });
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
      default: {
        ocpp.sendError(id, "NotSupported", `Ação ${action} não suportada`, {});
      }
    }
  }

  // Bind UI
  function init() {
    // Pre-popular campos com valores úteis
    $("endpointUrl").value = "ws://35.231.137.231:3000/ocpp/CentralSystemService/DRBAKANA-TEST-03";
    $("subprotocols").value = "ocpp1.6j,ocpp1.6";
    $("chargePointId").value = "DRBAKANA-TEST-03";
    $("connectorId").value = 1;
    $("idTag").value = "IGEA-USER-001";
    $("meterStart").value = 0;
    $("meterStop").value = 0;
    $("pricePerKWh").value = telemetry.pricePerKWh;
    $("cpName").textContent = $("chargePointId").value || "Charge Point";
    setWsStatus("");

    // Defaults para novos controles
    if ($("meterIntervalSec")) $("meterIntervalSec").value = 10;
    if ($("realProfile")) $("realProfile").checked = true;

    // History inicial
    renderHistory(JSON.parse(localStorage.getItem("ocpp.sessions") || "[]"));

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
          onOpen: () => { opened = true; setWsStatus("Conectado"); bootSequence(); installRemoteHook(); },
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
      startTransactionFlow();
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
    const cpIdInput = $("chargePointId");
    if (cpIdInput && !cpIdInput.value) cpIdInput.value = "DRBAKANA-TEST-03";
    const spInput = $("subprotocols");
    if (spInput && !spInput.value) spInput.value = "ocpp1.6j,ocpp1.6";
    const connInput = $("connectorId");
    if (connInput && !connInput.value) connInput.value = "1";
    const idTagInput = $("idTag");
    if (idTagInput && !idTagInput.value) idTagInput.value = "IGEA-USER-001";
    const urlInput = $("endpointUrl");
    if (urlInput && !urlInput.value) urlInput.value = `ws://35.231.137.231:3000/ocpp/CentralSystemService/${cpIdInput?.value || "DRBAKANA-TEST-03"}`;
    window.DEFAULT_IDTAG = $("idTag").value || "IGEA-USER-001";
    window.DEFAULT_CONNECTOR_ID = Number($("connectorId").value || 1);
    setTimeout(() => { if ($("btnConnect")) $("btnConnect").click(); }, 300);
    setTimeout(() => { if ($("btnStart")) $("btnStart").click(); }, 2000);
  });
  window.startTransactionFlow = startTransactionFlow;
  window.stopTransactionFlow = stopTransactionFlow;
  window.getOcppWs = function () { return ocpp && ocpp.ws ? ocpp.ws : null; };
  (function(){
    try {
      const s = window.getOcppWs && window.getOcppWs();
      if (!s) return;
      window._remoteHookEnabled = true;
      s.addEventListener("message", function(ev){
        let m;
        try { m = JSON.parse(ev.data); } catch(e){ return; }
        if (Array.isArray(m) && m[0] === 2 && m[2] === "RemoteStartTransaction"){
          const uid = m[1];
          const p = m[3] || {};
          const idTag = String(p.idTag || window.DEFAULT_IDTAG || "IGEA-USER-001");
          const connectorId = Number(p.connectorId || window.DEFAULT_CONNECTOR_ID || 1);
          try { s.send(JSON.stringify([3, uid, { status: "Accepted" }])); } catch(e){}
          try { window.startTransactionFlow({ idTag, connectorId }); } catch(e){}
        }
        if (Array.isArray(m) && m[0] === 2 && m[2] === "RemoteStopTransaction"){
          const uid = m[1];
          try { s.send(JSON.stringify([3, uid, { status: "Accepted" }])); } catch(e){}
          try { window.stopTransactionFlow("Remote"); } catch(e){}
        }
      });
    } catch(e){}
  })();
})();
  // Modal de conclusão de meta
  let goalModalShown = false;
  function showGoalModal(percent) {
    if ($("goalModalMessage")) {
      $("goalModalMessage").textContent = `Bateria atingiu ${percent}% da meta definida.`;
    }
    if ($("goalModalBackdrop")) {
      $("goalModalBackdrop").classList.remove("hidden");
    }
  }
  function hideGoalModal() {
    if ($("goalModalBackdrop")) {
      $("goalModalBackdrop").classList.add("hidden");
    }
  }
  const uiFlags = { starting: false, stopping: false };
  function isWsOpen() { return !!(ocpp && ocpp.ws && ocpp.ws.readyState === WebSocket.OPEN); }
  function setStartLabel(text) { const b = $("btnStart"); if (b) b.textContent = text; }
  function setStopLabel(text) { const b = $("btnStop"); if (b) b.textContent = text; }
