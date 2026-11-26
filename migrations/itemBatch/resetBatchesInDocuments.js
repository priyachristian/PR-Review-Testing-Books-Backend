const { getConnection } = require('../../config/db');
const { ObjectId } = require('mongodb');

// Static configuration - CHANGE THESE VALUES
const COMPANY_ID = '67c6dec3953e5048200667b6'; // Set to null to process all companies
const DOCUMENT_TYPES = ['deliveryChallan', 'invoice']; // Options: 'deliveryChallan', 'invoice', or both
const DRY_RUN = false; // Set to false to actually perform the updates

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
 * 1. Find documents based on document type and company filter
 * 2. For each document, check items array
 * 3. For each item that has batches, reset batches to empty array []
 * 4. Support dry run mode to preview changes before applying
 */
async function resetBatchesInDocuments() {
  try {
    const { DeliveryChallan, Invoice, client } = await initializeDatabases();

    console.log(`\n🔄 Starting Batch Reset for Documents`);
    console.log(`📋 Document Types: ${DOCUMENT_TYPES.join(', ')}`);
    console.log(`🏢 Company Filter: ${COMPANY_ID ? COMPANY_ID : 'ALL COMPANIES'}`);
    console.log(`🔍 Mode: ${DRY_RUN ? 'DRY RUN (Preview Only)' : 'LIVE UPDATE'}`);

    let totalDocumentsProcessed = 0;
    let totalItemsUpdated = 0;
    let totalDocumentsUpdated = 0;

    // Process each document type
    for (const docType of DOCUMENT_TYPES) {
      console.log(`\n📄 Processing ${docType} documents...`);

      const collection = docType === 'deliveryChallan' ? DeliveryChallan : Invoice;
      const collectionName = docType === 'deliveryChallan' ? 'deliverychallans' : 'invoices';

      // Build query filter
      const query = {};
      if (COMPANY_ID) {
        query.companyId = new ObjectId(COMPANY_ID);
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

              if (!DRY_RUN) {
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
    console.log(`Document Types Processed: ${DOCUMENT_TYPES.join(', ')}`);
    console.log(`Company Filter: ${COMPANY_ID ? COMPANY_ID : 'ALL COMPANIES'}`);
    console.log(`Mode: ${DRY_RUN ? 'DRY RUN (Preview Only)' : 'LIVE UPDATE'}`);
    console.log(`Total Documents Processed: ${totalDocumentsProcessed}`);
    console.log(`Total Documents Updated: ${totalDocumentsUpdated}`);
    console.log(`Total Items Updated: ${totalItemsUpdated}`);

    if (DRY_RUN) {
      console.log(`\n⚠️  This was a DRY RUN - no actual changes were made`);
      console.log(`💡 To perform actual updates, set DRY_RUN = false in the script`);
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

// Validate company ID format if provided
if (COMPANY_ID && !ObjectId.isValid(COMPANY_ID)) {
  console.error('Invalid company ID format. Please provide a valid MongoDB ObjectId or set to null for all companies.');
  process.exit(1);
}

// Validate document types
const validDocTypes = ['deliveryChallan', 'invoice'];
const invalidTypes = DOCUMENT_TYPES.filter(type => !validDocTypes.includes(type));
if (invalidTypes.length > 0) {
  console.error(`Invalid document types: ${invalidTypes.join(', ')}. Valid types are: ${validDocTypes.join(', ')}`);
  process.exit(1);
}

console.log('🔄 Starting Batch Reset for Documents');
console.log('📋 This will reset batches array to empty for items in selected documents');
console.log('⚠️  Make sure you have backed up your database before proceeding');
console.log('');

// Add a small delay to allow user to read the message
setTimeout(() => {
  resetBatchesInDocuments();
}, 2000);
