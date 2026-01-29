# Guia de Instalação e Execução em VM (Linux/Ubuntu)

Este guia contém todos os passos necessários para configurar uma VM limpa, clonar o repositório e rodar os simuladores `DRBAKANA-TEST-03` e `DRBAKANA-TEST-04` automaticamente.

## 1. Instalação Básica (Node.js e Dependências do Sistema)
Execute estes comandos para preparar o ambiente (Ubuntu/Debian):

```bash
# Atualizar lista de pacotes
sudo apt-get update

# Instalar Node.js (versão 18.x LTS recomendada)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Instalar dependências necessárias para o Puppeteer (Chrome Headless)
# Isso é crucial para rodar o navegador em modo texto (sem interface gráfica)
sudo apt-get install -y ca-certificates fonts-liberation libappindicator3-1 libasound2 \
libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 \
libfontconfig1 libgbm1 libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 \
libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 \
libxrender1 libxss1 libxtst6 lsb-release wget xdg-utils
```

## 2. Clonar e Instalar o Projeto

```bash
# Clonar o repositório
git clone https://github.com/Robetjunior/SIMULATOR_OCPP.git

# Entrar na pasta
cd SIMULATOR_OCPP

# Instalar as dependências do projeto
npm install
```

## 3. Executar a Simulação

Este comando irá iniciar o servidor e conectar automaticamente os carregadores **DRBAKANA-TEST-03** e **DRBAKANA-TEST-04**.

```bash
npm run simulate
```

### O que você verá:
O terminal mostrará logs como:
```text
=== Iniciando Runner de Simulação OCPP ===
IDs a serem simulados: DRBAKANA-TEST-03, DRBAKANA-TEST-04
Iniciando servidor local...
Servidor online em: PREVIEW_URL=http://127.0.0.1:5510/
Iniciando navegador headless...
[DRBAKANA-TEST-03] Conectando em: http://127.0.0.1:5510/?id=DRBAKANA-TEST-03&auto=1
[DRBAKANA-TEST-04] Conectando em: http://127.0.0.1:5510/?id=DRBAKANA-TEST-04&auto=1
...
```

Para encerrar a simulação, pressione `Ctrl + C`.
