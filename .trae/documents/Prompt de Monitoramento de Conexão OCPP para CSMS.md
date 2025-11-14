## Objetivo

* Entregar um prompt claro para o CSMS detectar desconexões/conexões do Charge Point e refletir estados corretos no app.

## Pontos-Chave

* Detectar eventos de WebSocket (open/close/error) e batimentos (Heartbeat) perdidos.

* Atualizar estado de conexão (Online/Offline) e estados de conector via `StatusNotification`.

* Tratar reconexão com `BootNotification.Accepted` e reativar `Heartbeat`.

* Manter consistência de sessão quando a desconexão ocorre durante carregamento.

## Base no Simulador

* Boot/Heartbeat após conexão: assets/js/simulator.js:255-270.

* Envio de `StatusNotification Available` após Boot: assets/js/simulator.js:266-267.

* Desconexão WebSocket e parada de Heartbeat: assets/js/simulator.js:64-68.

* Fluxo de sessão e telemetria contínua: assets/js/simulator.js:285-335, 371-399.

## Entregáveis

* Prompt pronto para colar no CSMS (texto normativo com instruções e critérios de atualização de UI).

* Critérios de aceite e troubleshooting.

## Após Aprovação

* Disponibilizo o prompt final e, se desejar, exemplos de estados e transições que seu app pode exibir.

