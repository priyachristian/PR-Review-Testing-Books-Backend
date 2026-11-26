#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

/**
 * Migration Generator Script
 *
 * Usage: node scripts/generate-migration.js <migration-name>
 * Example: node scripts/generate-migration.js addUserTable
 */

function generateMigration() {
  const migrationName = process.argv[2];

  if (!migrationName) {
    console.error('❌ Error: Migration name is required');
    console.log('Usage: node scripts/generate-migration.js <migration-name>');
    console.log('Example: node scripts/generate-migration.js addUserTable');
    process.exit(1);
  }

  // Generate timestamp in YYYY-MM-DD format
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0]; // Gets YYYY-MM-DD format

  // Create filename
  const fileName = `${dateStr}-${migrationName}.js`;
  const filePath = path.join(__dirname, '..', 'migrations', fileName);

  // Check if migrations directory exists
  const migrationsDir = path.join(__dirname, '..', 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    console.error('❌ Error: migrations directory does not exist');
    process.exit(1);
  }

  // Check if file already exists
  if (fs.existsSync(filePath)) {
    console.error(`❌ Error: Migration file ${fileName} already exists`);
    process.exit(1);
  }

  // Create the migration template with actual filename
  const migrationTemplate = `/**
 * Migration: <short description here>
 *
 * Usage:
 *   node migrations/${fileName} up
 *   node migrations/${fileName} down
 */
const mongoose = require('mongoose');
const { getConnection } = require('../config/db');

module.exports = {
  /**
   * Apply the migration
   */
  async up() {
    const { client, booksCrm } = await getConnection();

    try {
      // 👉 Write your forward migration code here
      // Example:
      // await booksCrm.collection('myCollection').updateMany({}, { $set: { myField: true } });

      console.log('✅ Migration up completed');
    } catch (err) {
      console.error('❌ Migration up failed:', err);
      throw err;
    } finally {
      await client.close();
    }
  },

  /**
   * Revert the migration
   */
  async down() {
    const { client, booksCrm } = await getConnection();

    try {
      // 👉 Write your rollback logic here
      // Example:
      // await booksCrm.collection('myCollection').updateMany({}, { $unset: { myField: '' } });

      console.log('✅ Migration down completed');
    } catch (err) {
      console.error('❌ Migration down failed:', err);
      throw err;
    } finally {
      await client.close();
    }
  }
};

// Optional CLI helper
if (require.main === module) {
  const direction = process.argv[2];
  if (!['up', 'down'].includes(direction)) {
    console.error('Usage: node <file> [up|down]');
    process.exit(1);
  }
  module.exports[direction]()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
`;

  try {
    // Write the migration file
    fs.writeFileSync(filePath, migrationTemplate);

    console.log('✅ Migration file created successfully!');
    console.log(`📁 File: ${fileName}`);
    console.log(`📍 Path: ${filePath}`);
    console.log('');
    console.log('🚀 Next steps:');
    console.log(`   1. Edit the migration file: ${fileName}`);
    console.log('   2. Add your migration logic in the up() method');
    console.log('   3. Add your rollback logic in the down() method');
    console.log(`   4. Run the migration: node migrations/${fileName} up`);
    console.log(`   5. Or rollback: node migrations/${fileName} down`);
  } catch (error) {
    console.error('❌ Error creating migration file:', error.message);
    process.exit(1);
  }
}

// Run the generator
generateMigration();
