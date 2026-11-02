// pm2 进程配置：pm2 start ecosystem.config.cjs
// .env 由应用自己加载（src/env.ts），这里只放进程级参数
module.exports = {
    apps: [
        {
            name: "llm-gateway",
            script: "src/index.ts",
            interpreter: "node",
            cwd: __dirname,
            exec_mode: "fork",
            instances: 1,
            autorestart: true,
            max_restarts: 10,
            max_memory_restart: "512M",
            time: true,
            env: {
                NODE_ENV: "production",
            },
        },
    ],
};
