const puppeteer = require('puppeteer');
const { spawn } = require('child_process');

// Configuração
const PORT = process.env.PORT || 5510;
const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}/`;

// IDs padrão se não forem passados via argumentos
// Exemplo de uso: node runner.js CP001 CP002 CP003
const defaultIds = ['DRBAKANA-TEST-03', 'DRBAKANA-TEST-04'];
const chargePointIds = process.argv.slice(2).length > 0 ? process.argv.slice(2) : defaultIds;

console.log('=== Iniciando Runner de Simulação OCPP ===');
console.log(`IDs a serem simulados: ${chargePointIds.join(', ')}`);

// 1. Iniciar o Servidor Local
console.log('Iniciando servidor local...');
const serverProcess = spawn('node', ['server.js'], { 
    stdio: ['ignore', 'pipe', 'pipe'], // Capturar stdout/stderr
    env: { ...process.env, PORT: PORT.toString() }
});

serverProcess.stdout.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg.includes('PREVIEW_URL')) {
        console.log(`Servidor online em: ${msg}`);
        startBrowser();
    }
});

serverProcess.stderr.on('data', (data) => {
    console.error(`[SERVER ERR] ${data}`);
});

// 2. Iniciar Puppeteer
async function startBrowser() {
    console.log('Iniciando navegador headless...');
    
    try {
        const browser = await puppeteer.launch({
            headless: "new", // Modo headless novo (mais rápido/estável)
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage' // Importante para ambientes com pouca memória (VMs)
            ] 
        });

        console.log('Navegador iniciado. Abrindo sessões...');

        for (const id of chargePointIds) {
            const page = await browser.newPage();
            
            // Repassar logs do console do navegador para o terminal do Node
            page.on('console', msg => {
                const type = msg.type().toUpperCase();
                // Filtrar logs irrelevantes se quiser, ou mostrar tudo
                console.log(`[${id}] [${type}] ${msg.text()}`);
            });

            // URL com auto-connect
            const targetUrl = `${BASE_URL}?id=${id}&auto=1`;
            console.log(`[${id}] Conectando em: ${targetUrl}`);
            
            await page.goto(targetUrl, { waitUntil: 'networkidle0' });
            
            // Injetar um script para verificar status periodicamente (opcional)
            await page.evaluate((cpId) => {
                console.log(`Simulador carregado para ${cpId}`);
            }, id);
        }

        console.log(`\nTodos os ${chargePointIds.length} simuladores foram iniciados.`);
        console.log('Pressione Ctrl+C para encerrar todas as simulações.');

    } catch (error) {
        console.error('Erro ao iniciar navegador:', error);
        serverProcess.kill();
        process.exit(1);
    }
}

// Tratamento de encerramento
process.on('SIGINT', () => {
    console.log('\nEncerrando simulação...');
    serverProcess.kill();
    process.exit();
});
