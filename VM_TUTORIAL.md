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

# Instalar bibliotecas gráficas e dependências do sistema
sudo apt-get install -y ca-certificates fonts-liberation libappindicator3-1 libasound2 \
libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 \
libfontconfig1 libgbm1 libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 \
libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 \
libxrender1 libxss1 libxtst6 lsb-release wget xdg-utils
```

> **Erro comum:** Se aparecer erro de `libnspr4.so` ou similar, é porque você pulou esta etapa acima! Execute o comando `sudo apt-get install...` para corrigir.

## 2. Clonar e Instalar o Projeto

```bash
# Clonar o repositório
git clone https://github.com/Robetjunior/SIMULATOR_OCPP.git

# Entrar na pasta
cd SIMULATOR_OCPP

# Instalar as dependências do projeto
npm install

# Garantir que o navegador Chrome seja baixado (caso o npm install não o faça)
npx puppeteer browsers install chrome
```

> **Nota:** Se receber erro de `Permission denied`, execute:
> ```bash
> chmod +x node_modules/.bin/puppeteer
> npx puppeteer browsers install chrome
> ```

## 4. Executar 24h (Produção com PM2)

Para manter o simulador rodando 24h por dia, mesmo que você feche o terminal ou reinicie a VM, utilize o **PM2**.

### 1. Instalar o PM2
```bash
sudo npm install -g pm2
```

### 2. Iniciar o Simulador
```bash
pm2 start ecosystem.config.js
```

### 3. Comandos Úteis do PM2
- **Ver logs:** `pm2 logs`
- **Ver status:** `pm2 status`
- **Reiniciar:** `pm2 restart ocpp-simulator`
- **Parar:** `pm2 stop ocpp-simulator`

### 4. Configurar Inicialização Automática (Boot)
Para que o simulador inicie automaticamente se a VM reiniciar:
```bash
pm2 startup
# Copie e execute o comando que o PM2 exibir na tela
pm2 save
```

