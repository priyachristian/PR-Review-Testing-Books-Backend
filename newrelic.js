'use strict';
const config = require('./config/config');

exports.config = {
  app_name: [config.newRelic.appName],
  license_key: config.newRelic.licenseKey,

  // Only activate the agent when a license key is present (i.e. production)
  agent_enabled: !!config.newRelic.licenseKey,

  logging: {
    level: 'info',
  },

  // Distributed tracing — traces requests across Books, CRM, Account services
  distributed_tracing: {
    enabled: true,
  },

  // Forward Winston logs to New Relic Logs UI
  application_logging: {
    enabled: true,
    forwarding: {
      enabled: true,
      max_samples_stored: 10000,
    },
    local_decorating: {
      enabled: false, // avoid double-logging with forwarding enabled
    },
  },

  // Transaction tracer — shows exactly where time is spent per request
  transaction_tracer: {
    enabled: true,
    transaction_threshold: 500, // trace any request slower than 500ms (default is 2000ms — too high)
    record_sql: 'obfuscated', // record MongoDB queries in traces (values hidden for security)
    explain_threshold: 500, // explain plan for queries slower than 500ms
  },

  // Slow query tracking — shows individual MongoDB operations that are slow
  slow_sql: {
    enabled: true,
    max_samples: 20,
  },

  // Error tracking — capture and group errors automatically
  error_collector: {
    enabled: true,
    ignore_status_codes: [400, 401, 403, 404], // don't alert on expected client errors
  },

  // Suppress noisy cloud metadata lookup errors (not on GCP/AWS/Azure)
  utilization: {
    detect_aws: false,
    detect_azure: false,
    detect_gcp: false,
    detect_pcf: false,
    detect_docker: true,
  },

  // Browser agent not needed for API backend
  browser_monitoring: {
    enable: false,
  },
};
