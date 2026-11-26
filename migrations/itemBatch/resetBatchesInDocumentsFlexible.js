const { getConnection } = require('../../config/db');
const { ObjectId } = require('mongodb');

// Initialize database connections
const initializeDatabases = async () => {
  try {
    console.log('Connecting to MongoDB...');

    // Get database connection using the simpler approach
    const db = await getConnection();

    console.log('Connected to MongoDB successfully');
    console.log('Using databases:', {
      common: db.common.databaseName,
      booksCrm: db.booksCrm.databaseName,
      books: db.books.databaseName,
    });

    // Get collections directly
    const DeliveryChallan = db.books.collection('deliverychallans');
    const Invoice = db.books.collection('invoices');

    console.log('Collections initialized successfully');

    return {
      DeliveryChallan,
      Invoice,
      client: db.client,
    };
  } catch (error) {
    console.error('Failed to initialize databases:', error);
    throw error;
  }
};

/**
 * Reset batches array to empty for items in delivery challans and invoices
 * This script will:
 * 1. Accept command line arguments for document types and company
 * 2. Find documents based on document type and company filter
 * 3. For each document, check items array
 * 4. For each item that has batches, reset batches to empty array []
 * 5. Support dry run mode to preview changes before applying
 */
async function resetBatchesInDocuments(companyId, documentTypes, dryRun = true) {
  try {
    const { DeliveryChallan, Invoice, client } = await initializeDatabases();

    console.log(`\n🔄 Starting Batch Reset for Documents`);
    console.log(`📋 Document Types: ${documentTypes.join(', ')}`);
    console.log(`🏢 Company Filter: ${companyId ? companyId : 'ALL COMPANIES'}`);
    console.log(`🔍 Mode: ${dryRun ? 'DRY RUN (Preview Only)' : 'LIVE UPDATE'}`);

    let totalDocumentsProcessed = 0;
    let totalItemsUpdated = 0;
    let totalDocumentsUpdated = 0;

    // Process each document type
    for (const docType of documentTypes) {
      console.log(`\n📄 Processing ${docType} documents...`);

      const collection = docType === 'deliveryChallan' ? DeliveryChallan : Invoice;
      const collectionName = docType === 'deliveryChallan' ? 'deliverychallans' : 'invoices';

      // Build query filter
      const query = {};
      if (companyId) {
        query.companyId = new ObjectId(companyId);
      }

      // Find documents that have items with batches
      const documents = await collection
        .find({
          ...query,
          'items.batches': { $exists: true, $ne: [] },
        })
        .toArray();

      console.log(`Found ${documents.length} ${docType} documents with items containing batches`);

      if (documents.length === 0) {
        console.log(`No ${docType} documents found with batches. Skipping...`);
        continue;
      }

      // Process each document
      for (const doc of documents) {
        try {
          console.log(`\n  📋 Processing ${docType}: ${doc.documentNumber || doc._id}`);

          let documentNeedsUpdate = false;
          let itemsInDocUpdated = 0;

          // Check each item in the document
          for (let i = 0; i < doc.items.length; i++) {
            const item = doc.items[i];

            // Check if item has batches array and it's not empty
            if (item.batches && Array.isArray(item.batches) && item.batches.length > 0) {
              console.log(
                `    📦 Item ${i + 1}: ${item.itemName || item.itemCode || 'Unknown'} - Found ${item.batches.length} batches`,
              );

              if (!dryRun) {
                // Reset batches to empty array
                await collection.updateOne({ _id: doc._id }, { $set: { [`items.${i}.batches`]: [] } });
                console.log(`      ✅ Reset batches to empty array`);
              } else {
                console.log(`      🔍 [DRY RUN] Would reset batches to empty array`);
              }

              itemsInDocUpdated++;
              totalItemsUpdated++;
              documentNeedsUpdate = true;
            }
          }

          if (documentNeedsUpdate) {
            totalDocumentsUpdated++;
            console.log(`  📊 Updated ${itemsInDocUpdated} items in this document`);
          } else {
            console.log(`  ℹ️  No items with batches found in this document`);
          }

          totalDocumentsProcessed++;
        } catch (docError) {
          console.error(`  ❌ Error processing ${docType} ${doc._id}:`, docError.message);
        }
      }
    }

    // Summary
    console.log(`\n${'='.repeat(80)}`);
    console.log(`📊 BATCH RESET SUMMARY`);
    console.log(`${'='.repeat(80)}`);
    console.log(`Document Types Processed: ${documentTypes.join(', ')}`);
    console.log(`Company Filter: ${companyId ? companyId : 'ALL COMPANIES'}`);
    console.log(`Mode: ${dryRun ? 'DRY RUN (Preview Only)' : 'LIVE UPDATE'}`);
    console.log(`Total Documents Processed: ${totalDocumentsProcessed}`);
    console.log(`Total Documents Updated: ${totalDocumentsUpdated}`);
    console.log(`Total Items Updated: ${totalItemsUpdated}`);

    if (dryRun) {
      console.log(`\n⚠️  This was a DRY RUN - no actual changes were made`);
      console.log(`💡 To perform actual updates, run with --live flag`);
    } else {
      console.log(`\n✅ Batch reset completed successfully!`);
    }

    await client.close();
    process.exit(0);
  } catch (error) {
    console.error('Batch reset failed:', error);
    process.exit(1);
  }
}

// Parse command line arguments
function parseArguments() {
  const args = process.argv.slice(2);
  let companyId = null;
  let documentTypes = ['deliveryChallan', 'invoice']; // Default to both
  let dryRun = true; // Default to dry run for safety

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--company':
      case '-c':
        companyId = args[++i];
        if (!ObjectId.isValid(companyId)) {
          console.error('Invalid company ID format. Please provide a valid MongoDB ObjectId.');
          process.exit(1);
        }
        break;

      case '--documents':
      case '-d':
        const docTypes = args[++i].split(',');
        const validDocTypes = ['deliveryChallan', 'invoice'];
        const invalidTypes = docTypes.filter(type => !validDocTypes.includes(type));

        if (invalidTypes.length > 0) {
          console.error(`Invalid document types: ${invalidTypes.join(', ')}. Valid types are: ${validDocTypes.join(', ')}`);
          process.exit(1);
        }

        documentTypes = docTypes;
        break;

      case '--live':
      case '-l':
        dryRun = false;
        break;

      case '--help':
      case '-h':
        console.log(`
Usage: node resetBatchesInDocumentsFlexible.js [options]

Options:
  -c, --company <id>     Company ID to filter documents (optional, processes all companies if not specified)
  -d, --documents <types> Comma-separated document types: deliveryChallan,invoice (default: both)
  -l, --live            Perform actual updates (default: dry run mode)
  -h, --help            Show this help message

Examples:
  # Dry run for all companies and document types
  node resetBatchesInDocumentsFlexible.js

  # Dry run for specific company
  node resetBatchesInDocumentsFlexible.js --company 67c6dec3953e5048200667b6

  # Live update for delivery challans only
  node resetBatchesInDocumentsFlexible.js --documents deliveryChallan --live

  # Live update for specific company and invoice documents only
  node resetBatchesInDocumentsFlexible.js --company 67c6dec3953e5048200667b6 --documents invoice --live
        `);
        process.exit(0);
        break;

      default:
        console.error(`Unknown argument: ${arg}`);
        console.error('Use --help for usage information');
        process.exit(1);
    }
  }

  return { companyId, documentTypes, dryRun };
}

// Main execution
const { companyId, documentTypes, dryRun } = parseArguments();

console.log('🔄 Starting Batch Reset for Documents');
console.log('📋 This will reset batches array to empty for items in selected documents');
console.log('⚠️  Make sure you have backed up your database before proceeding');
console.log('');

// Add a small delay to allow user to read the message
setTimeout(() => {
  resetBatchesInDocuments(companyId, documentTypes, dryRun);
}, 2000);
