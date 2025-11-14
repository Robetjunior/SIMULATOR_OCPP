## Passos para Execução Local
- Iniciar um servidor estático na pasta do projeto para servir `index.html`.
- Abrir a UI em `http://localhost:5500/` (ou `http://127.0.0.1:5500/`).
- Confirmar o autoconnect do cliente OCPP e ajustar configurações se necessário.

## Servidor Estático
- Opção Python: `python -m http.server 5500`.
- Opção Node: `npx http-server -p 5500`.
- Acessar via navegador: `http://localhost:5500/`.

## Configuração na UI
- `Endpoint URL (CSMS)`: base do seu CSMS, ex.: `ws://host:porta`.
- `Subprotocol(s)`: `ocpp1.6j,ocpp1.6`.
- `Id CP`: ex.: `DRBAKANA-TEST-03`.
- `Connector Id`: `1`.
- `idTag`: ex.: `IGEA-USER-001`.
- Se a URL já contiver `/ocpp/CentralSystemService/<chargePointId>`, será usada diretamente; caso contrário, o simulador monta automaticamente com base + `Id CP` (assets/js/simulator.js:176-183).

## Fluxo de Conexão e Sessão
- Ao carregar a página, há autoconnect: o botão Conectar é acionado após 300 ms (assets/js/simulator.js:614-616).
- `Conectar`: cria `WebSocket` com subprotocolos (assets/js/simulator.js:57-75, 185-189), envia `BootNotification` e inicia `Heartbeat` (assets/js/simulator.js:255-270).
- `Iniciar`: envia `Authorize`, depois `StartTransaction`, guarda `transactionId` e começa `MeterValues` periódico (assets/js/simulator.js:285-335, 371-399).
- `Parar Carregamento`: envia `StopTransaction`, `StatusNotification Available` e salva histórico (assets/js/simulator.js:337-369, 454-486).

## Telemetria e UI
- Telemetria atualiza a cada 1s (assets/js/simulator.js:204-234) e envia medição a cada 5–10s configurável.
- Métricas: potência, tensão, corrente, energia, temperatura, SoC, preço total (assets/js/telemetry.js:71-147; assets/js/simulator.js:191-202).
- Alvo de SoC encerra automaticamente a sessão ao atingir meta (assets/js/simulator.js:210-216).

## Verificação
- Ver `wsStatus` mostrar "Conectado" (assets/js/simulator.js:568-575).
- Log exibe frames `=> BootNotification`, `<= ... RES` (assets/js/simulator.js:9-14, 89-104, 118-144).
- UI mostra gauge e cartões com valores atualizados.
- Histórico exportável via "Exportar Histórico".

## Troubleshooting
- Preferir `http://localhost:5500/` (IPv6 `http://[::]:5500/` pode falhar em alguns ambientes Windows).
- Se o CSMS exigir TLS, usar `wss://`.
- Desbloquear firewall para Python/Node.
- CORS/ws de alguns CSMS podem exigir hospedagem local.

## Confirmação
- Se concordar, inicio o servidor estático e abro a UI para você usar imediatamente; em seguida valido a conexão ao CSMS e a execução do ciclo completo.