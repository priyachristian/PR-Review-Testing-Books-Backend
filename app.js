const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const hpp = require('hpp');
const cors = require('cors');
const path = require('path'); // Add this to handle the path
const httpStatus = require('http-status');
const cookieParser = require('cookie-parser');

const config = require('./config/config');
const { errorConverter, errorHandler } = require('./middlewares/error');
const ApiError = require('./utils/ApiError');
const { setupBullBoard } = require('./config/bullboard');
const { createQueue } = require('./config/queueConfig');

// Import route handlers
const v1Routes = require('./routes/v1/index');

const app = express();

// Number of reverse proxies in front of the app, so req.ip is the real client.
if (process.env.TRUST_PROXY_HOPS) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS));
}

// Allow Cross-Origin requests
if (config.env == 'development') {
  app.use(
    cors({
      origin: [/^http:\/\/localhost:\d+$/],
      credentials: true,
    }),
  );
} else {
  app.use(
    cors({
      origin: [new RegExp(config.allowedOrigin)],
      credentials: true,
    }),
  );
}

app.use(cookieParser());

app.use(
  compression({
    filter: (req, res) => {
      if (req.method === 'GET' && /\/document-exports\/[^/]+\/download(?:\?|$)/.test(req.originalUrl || req.url || '')) {
        return false;
      }
      return compression.filter(req, res);
    },
  }),
);

// ── Bull Board dashboard  (mounted before global helmet so its relaxed
//    CSP applies only to /admin/queues and not the rest of the app) ──────────
setupBullBoard(app, [
  createQueue('recurring-bill'),
  createQueue('invoice-and-bill-due'),
  createQueue('recurring-account-expense'),
  createQueue('recurring-expense'),
  createQueue('recurring-invoice'),
  createQueue('quote-expiry'),
  createQueue('wp-daily-summary'),
  createQueue('module-email'),
  createQueue('module-whatsapp'),
  createQueue('document-pdf-export'),
]);

// Set security HTTP headers
app.use(helmet());

// Body parser, reading data from body into req.body
app.use(
  express.json({
    limit: '50mb',
  }),
);

// Data sanitization against Nosql query injection
app.use(mongoSanitize());

// Data sanitization against XSS(clean user input from malicious HTML code)
app.use(xss());

// Prevent parameter pollution
app.use(hpp());

// Serve static files from the 'public' directory
app.use('/public', express.static(path.join(__dirname, 'public'))); // Add this line

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: config.serviceType,
    environment: config.env,
    timestamp: new Date().toISOString(),
  });
});

// Prevent browser from caching API responses (always get fresh 200, no 304)
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

// Routes
app.use('/api/v1', v1Routes);

// send back a 404 error for any unknown api request
app.use((req, res, next) => {
  next(new ApiError(httpStatus.NOT_FOUND, 'API Not found'));
});

// convert error to ApiError, if needed
app.use(errorConverter);

// handle error
app.use(errorHandler);

module.exports = app;
