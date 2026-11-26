module.exports = {
  apps: [
    {
      name: 'abss-books-api',
      script: 'server.js',

      // Cluster mode — PM2 load-balances incoming HTTP across all instances.
      // pm2 reload performs a rolling restart: new instance up → old one sent SIGTERM.
      exec_mode: 'cluster',

      // 'max' uses all CPU cores. Set a number (e.g. 2) to cap it.
      instances: 'max',

      // Restart the process if it exceeds 500 MB (memory leak guard).
      max_memory_restart: '500M',

      // Wait for the app to call process.send('ready') before marking it up.
      // Without this PM2 routes traffic before DB connections are established.
      wait_ready: true,

      // How long to wait for the ready signal before giving up (ms).
      listen_timeout: 15000,

      // Give the process 8 s to finish in-flight requests before force-killing.
      kill_timeout: 8000,

      // Propagate SIGINT (not just SIGTERM) so our process.on('SIGINT') handler runs.
      shutdown_with_message: false,

      // Auto-restart on crash, but not on memory-limit exits (PM2 handles those).
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,

      // Watch is off — use deploy.sh for controlled reloads.
      watch: false,

      env_development: {
        NODE_ENV: 'development',
        PORT: 8081,
      },

      env_production: {
        NODE_ENV: 'production',
        PORT: 8080,
      },

      // Log rotation handled by pm2-logrotate module.
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
