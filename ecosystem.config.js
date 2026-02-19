module.exports = {
  apps: [{
    name: "ocpp-simulator",
    script: "./runner.js",
    // Você pode passar IDs personalizados aqui se quiser, ex:
    // args: "CP-01 CP-02", 
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: "production",
      PORT: 5510,
      CSMS_URL: "ws://34.60.202.171:80/ocpp/CentralSystemService/"
    }
  }]
};
