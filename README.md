# Simulador OCPP 1.6J com Telemetria Realística

Simulador de Charge Point (CP) que se conecta via WebSocket ao CSMS (protocolo OCPP 1.6J), executa ciclo de carregamento completo com telemetria contínua, e apresenta UI com indicadores.

## Estrutura
- `index.html` — UI com configuração, painel de sessão, log e histórico
- `assets/css/main.css` — estilos básicos para layout, cards e gauge
- `assets/js/state.js` — máquina de estados de carregamento
- `assets/js/telemetry.js` — gerador de telemetria (potência, tensão, corrente, energia, temperatura, SoC)
- `assets/js/simulator.js` — cliente OCPP 1.6J, integração de UI e fluxo da sessão

## Executando Localmente

Qualquer servidor estático funciona. Exemplos:

- Python:
  - `python -m http.server 5500`
  - Abra `http://localhost:5500/`

- Node (http-server):
  - `npx http-server -p 5500`
  - Abra `http://localhost:5500/`

## Configuração

Na UI:
- `Endpoint URL (CSMS)`: base, ex.: `ws://35.231.137.231:3000`
- `Subprotocol(s)`: `ocpp1.6j,ocpp1.6`
- `Id CP`: ex.: `DRBAKANA-TEST-01`
- `Connector Id`: padrão `1`
- `idTag`: ex.: `IGEA-USER-001`
- `Meter Start/Stop` (Wh)
- `Preço Unit.` (R$/kWh)

Se a URL completa já incluir `/ocpp/CentralSystemService/<chargePointId>`, ela será usada diretamente. Caso contrário, o simulador monta automaticamente o endpoint usando a base e o `Id CP`.

## Fluxo OCPP 1.6J

1. Conexão:
   - Ao abrir WebSocket, envia `BootNotification` e inicia `Heartbeat` com o `interval` fornecido pelo CSMS.
   - Em seguida, envia `StatusNotification` com `Available`.

2. Início de sessão:
   - Envia `Authorize (idTag)`.
   - Em caso de `Accepted`, envia `StartTransaction` e salva `transactionId`.

3. Telemetria contínua:
   - Envia `MeterValues` a cada 5s com `Energy.Active.Import.Register (Wh)`, `Power.Active.Import (W)`, `Voltage (V)`, `Current.Import (A)`, `Temperature (Celsius)`, `SoC (Percent)`.

4. Encerramento:
   - Envia `StopTransaction` e então `StatusNotification` com `Available`.

5. Comandos CSMS -> CP:
   - `RemoteStartTransaction`, `RemoteStopTransaction`, `Reset`, `UnlockConnector`, `ChangeAvailability`, `ChangeConfiguration` (responde `Accepted` e executa ação local quando aplicável).

## Telemetria

- Potência: ramp-up em ~20s, platô e taper nos últimos ~30% (configurável).
- Tensão: nominal com variação leve.
- Corrente: derivada de `P = V * I` e limitada ao conector.
- Energia: integral de potência.
- Temperatura: crescimento lento com ruído.
- SoC: incremento em função da energia entregue.
- Preço Unitário: definido na UI; `Valor Total = Energia(kWh) * PreçoUnit`.

## Histórico e Exportação

- As sessões finalizadas ficam salvas em `localStorage`.
- Botão de exportação gera `sessions.json` com resumo de cada sessão.

## Observações

- Se o CSMS usar TLS, utilize `wss://` no endpoint.
- Em alguns ambientes, políticas CORS/ws podem impactar conexões; rodar localmente via servidor estático costuma funcionar.
- Este simulador foca no fluxo principal (Boot/Heartbeat/Authorize/Start/MeterValues/Stop) e respostas básicas de comandos remotos.

## Critérios de Aceite

- Conecta, negocia subprotocolos e envia `BootNotification`/`Heartbeat` corretamente.
- Simula sessão com `StartTransaction`, `MeterValues` periódico e `StopTransaction`.
- UI exibe os nove indicadores e o gauge de `%` (SoC).