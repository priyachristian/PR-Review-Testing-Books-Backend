// src/config/db.js
const { MongoClient } = require('mongodb');
const config = require('./config');
const logger = require('./logger');

async function getConnection() {
  const uri = config.mongoose.cluster_url; // Single URI for the MongoDB instance
  const client = new MongoClient(uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    connectTimeoutMS: 30000,
    heartbeatFrequencyMS: 10000,
  });

  try {
    await client.connect();
    logger.info('Connected to MongoDB instance');
    return {
      common: client.db(config.mongoose.db_names.common),
      booksCrm: client.db(config.mongoose.db_names.booksCrm),
      books: client.db(config.mongoose.db_names.books),
      crm: client.db(config.mongoose.db_names.crm),
      admin: client.db(config.mongoose.db_names.admin),
      client, // Return client for closing
    };
  } catch (error) {
    logger.error('Failed to connect to MongoDB:', error);
    throw error;
  }
}

async function closeConnection(client) {
  if (client) {
    await client.close();
    logger.info('MongoDB connection closed');
  }
}

module.exports = { getConnection, closeConnection };
