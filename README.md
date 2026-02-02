# Simulador OCPP 1.6J

![OCPP 1.6J Simulator](https://img.shields.io/badge/OCPP-1.6J-blue?style=for-the-badge&logo=electric-plug) ![Status](https://img.shields.io/badge/Status-Active-green?style=for-the-badge) ![Node.js](https://img.shields.io/badge/Node.js-18%2B-green?style=for-the-badge&logo=node.js)

Simulador de Charge Point (CP) baseado em web para testes e validação de sistemas de gerenciamento (CSMS) via protocolo OCPP 1.6 JSON. 

Desenvolvido com foco na experiência do desenvolvedor (DX), oferece uma interface intuitiva, telemetria realista e controle total sobre o ciclo de vida do carregamento, ideal para validar fluxos de integração sem a necessidade de hardware físico.

---

## 🚀 Principais Recursos

- **Protocolo OCPP 1.6J**: Conexão via WebSocket com suporte a subprotocolos `ocpp1.6j` e `ocpp1.6`.
- **Ciclo de Vida Completo**:
  - `BootNotification` & `Heartbeat`
  - `StatusNotification` (Available, Preparing, Charging, Finishing, etc.)
  - `Authorize` & `StartTransaction` / `StopTransaction`
  - `MeterValues` (Início, Periódico, Fim)
- **Telemetria Avançada**: Simulação de:
  - Potência Ativa (kW) com ramp-up e curvas de carga
  - Tensão (V), Corrente (A)
  - Energia Consumida (kWh) com acumulador persistente por sessão
  - Temperatura (°C) e Estado de Carga (SoC %)
- **Interatividade**:
  - Simulação de conexão física do cabo ("Cabo Conectado ao EV").
  - Comandos Locais (Botões na UI) e Remotos (`RemoteStartTransaction`, `RemoteStopTransaction`)
  - Configuração dinâmica de endpoint, ID do carregador e IDTag
  - Visualização de logs em tempo real
- **Resiliência**: Watchdog para tentativas de início de transação e reconexão automática.

---

## 🛠️ Pré-requisitos

- **Node.js**: Versão 18 ou superior.
- **Navegador**: Chrome, Edge, Firefox ou qualquer navegador moderno com suporte a ES6+.
- **CSMS (Backend)**: Um servidor WebSocket compatível com OCPP 1.6J acessível.

---

## 📦 Como Executar

### Instalação

Clone o repositório e instale as dependências (se houver, ou apenas execute o servidor estático):

```bash
git clone https://github.com/Robetjunior/SIMULATOR_OCPP.git
cd SIMULATOR_OCPP/simulador_ocpp
npm install # Opcional se usar dependências externas, mas o projeto roda com script nativo
```

### Rodando o Simulador

Execute o comando abaixo para iniciar o servidor local:

```bash
npm run start
```

O simulador estará disponível em: `http://127.0.0.1:5510/`

---

## ⚙️ Configuração e Uso
### Múltiplos Carregadores (Abas do Navegador)
Para simular múltiplos carregadores simultaneamente, você pode abrir o simulador em várias abas usando parâmetros na URL para pré-configurar cada um.

Exemplos de URLs (ajuste a porta 5510 se necessário):
- **Carregador 1**: `http://127.0.0.1:5510/?id=CP-001`
- **Carregador 2**: `http://127.0.0.1:5510/?id=CP-002`
- **Conexão Automática**: Adicione `&auto=1` para conectar assim que a página abrir.
  - Ex: `http://127.0.0.1:5510/?id=CP-003&auto=1`

**Nota**: A URL base padrão do CSMS agora é `ws://34.66.238.95/ocpp/CentralSystemService/`. Você pode sobrescrever isso com o parâmetro `url=...`.

Parâmetros suportados:
- `id` ou `cpId`: Define o ID do Charge Point.
- `auto=1`: Conecta automaticamente ao CSMS ao carregar.
- `url`: Sobrescreve a URL do CSMS.

### Execução em VM (Modo Headless / Automático)
Para rodar múltiplos simuladores em um servidor ou VM sem interface gráfica (ou para automatizar testes), utilize o script de execução incluído.

> **📄 Veja o guia completo de instalação e execução 24h:** [VM_TUTORIAL.md](./VM_TUTORIAL.md)

Resumo rápido:
1. Instale as dependências: `npm install`
2. Instale o PM2 para execução contínua (opcional): `npm install pm2`
3. Execute o simulador:
   ```bash
   # Execução simples
   npm run simulate

   # Execução 24h (Produção)
   npx pm2 start ecosystem.config.js
   ```

O script irá:
- Iniciar o servidor local automaticamente.
- Abrir navegadores "invisíveis" (headless) para cada ID.
- Exibir os logs de conexão no terminal.

### Interatividade
- **Logs**: O painel à direita mostra logs detalhados (envio/recebimento de mensagens OCPP).

### Uso Manual
1. **Acesse a UI**: Abra `http://127.0.0.1:5510/`.
2. **Configure a Conexão**:
   - **Endpoint URL**: `ws://<HOST_CSMS>/ocpp/CentralSystemService/<CHARGE_BOX_ID>`
   - **ChargeBoxId**: Ex: `DRBAKANA-TEST-03`
   - **Subprotocols**: `ocpp1.6j`
3. **Conectar**: Clique em **Conectar**.
   - Verifique o log para `BootNotification.conf: Accepted`.
   - O status deve mudar para `Available`.
4. **Carregamento**:
   - Insira um **IDTag** (ex: `USER_001`) e **ConnectorId** (ex: `1`).
   - Clique em **Iniciar Carregamento**.
   - Acompanhe os gráficos e valores de telemetria.
   - Clique em **Parar Carregamento** para finalizar a sessão.

---

## 🧩 Estrutura do Projeto

- `assets/js/simulator.js`: Lógica principal, cliente OCPP e manipulação do DOM.
- `assets/js/telemetry.js`: Gerador de dados de física simulada (Tensão, Corrente, Potência).
- `assets/js/state.js`: Máquina de estados do carregador.
- `server.js`: Servidor HTTP local simples para servir os arquivos estáticos.

---

## 👤 Autor

**José Roberto**  
Desenvolvedor de Software focado em soluções inovadoras e robustas.

[![LinkedIn](https://img.shields.io/badge/LinkedIn-Connect-blue?style=for-the-badge&logo=linkedin)](https://www.linkedin.com/in/jos%C3%A9-roberto-dev/)

---

## 📄 Licença

Este projeto é de uso livre para fins educacionais e de teste.
