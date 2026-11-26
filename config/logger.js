const fs = require('fs');
const path = require('path');
const winston = require('winston');
require('winston-daily-rotate-file');
const config = require('./config');

const logsRoot = path.join(__dirname, '..', 'logs');
const infoLogsDir = path.join(logsRoot, 'info');
const errorLogsDir = path.join(logsRoot, 'error');

[logsRoot, infoLogsDir, errorLogsDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

const fileFormat = winston.format.combine(
  winston.format.errors({ stack: true }),
  winston.format.timestamp(),
  winston.format.uncolorize(),
  winston.format.splat(),
  winston.format.printf(({ timestamp, level, message, stack }) => {
    return stack ? `${timestamp} ${level}: ${message}\n${stack}` : `${timestamp} ${level}: ${message}`;
  }),
);

const consoleFormat = winston.format.combine(
  winston.format.errors({ stack: true }),
  config.env === 'development' ? winston.format.colorize() : winston.format.uncolorize(),
  winston.format.splat(),
  winston.format.printf(({ level, message, stack }) => {
    return stack ? `${level}: ${message}\n${stack}` : `${level}: ${message}`;
  }),
);

const logger = winston.createLogger({
  level: config.env === 'development' ? 'debug' : 'info',

  transports: [
    new winston.transports.Console({
      stderrLevels: ['error'],
      format: consoleFormat,
    }),

    new winston.transports.DailyRotateFile({
      filename: path.join(infoLogsDir, 'info-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      level: 'info',
      format: fileFormat,
    }),

    new winston.transports.DailyRotateFile({
      filename: path.join(errorLogsDir, 'error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      format: fileFormat,
    }),
  ],

  exceptionHandlers: [
    new winston.transports.DailyRotateFile({
      filename: path.join(errorLogsDir, 'exceptions-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      format: fileFormat,
    }),
  ],

  rejectionHandlers: [
    new winston.transports.DailyRotateFile({
      filename: path.join(errorLogsDir, 'rejections-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      format: fileFormat,
    }),
  ],

  exitOnError: true,
});

process.on('uncaughtException', error => {
  logger.error('UNCAUGHT EXCEPTION', error);
});

process.on('unhandledRejection', reason => {
  logger.error('UNHANDLED REJECTION', reason instanceof Error ? reason : new Error(String(reason)));
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received');
});

process.on('SIGINT', () => {
  logger.info('SIGINT received');
});

process.on('exit', code => {
  logger.info(`Process exited with code ${code}`);
});

module.exports = logger;
