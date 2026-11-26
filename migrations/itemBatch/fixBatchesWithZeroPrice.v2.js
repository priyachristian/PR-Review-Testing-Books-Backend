const { getConnection } = require('../../config/db');

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
    const Item = db.booksCrm.collection('items');
    const ItemBatch = db.books.collection('itembatches');

    console.log('Collections initialized successfully');

    return {
      Item,
      ItemBatch,
      client: db.client,
    };
  } catch (error) {
    console.error('Failed to initialize databases:', error);
    throw error;
  }
};

/**
 * Fix ItemBatch documents with purchasePrice = 0
 * This script will:
 * 1. Find all ItemBatch documents
 * 2. Check both availableBatches and completedBatches for purchasePrice = 0
 * 3. Update those batches with the item's defaultPrice
 *
 * @param {boolean} dryRun - If true, only shows what would be changed without making updates
 */
async function fixBatchesWithZeroPrice(dryRun = false) {
  try {
    const { Item, ItemBatch, client } = await initializeDatabases();

    if (dryRun) {
      console.log(`\n🔍 DRY RUN MODE - No changes will be made to the database`);
      console.log(`Starting dry run for batches with purchasePrice = 0`);
    } else {
      console.log(`\nStarting fix for batches with purchasePrice = 0`);
    }

    // Find all ItemBatch documents
    const itemBatches = await ItemBatch.find({}).toArray();

    console.log(`Found ${itemBatches.length} ItemBatch documents to check`);

    if (itemBatches.length === 0) {
      console.log('No ItemBatch documents found. Exiting.');
      await client.close();
      return;
    }

    let totalItemBatchesFixed = 0;
    let totalBatchesFixed = 0;
    let totalBatchesSkipped = 0;
    const results = [];

    for (const itemBatch of itemBatches) {
      try {
        // Get item details to get defaultPrice
        let itemDetails = null;
        if (itemBatch.itemId) {
          itemDetails = await Item.findOne({ _id: itemBatch.itemId });
        }

        if (!itemDetails) {
          console.log(`\n⚠️  Skipping ItemBatch ${itemBatch._id} - Item not found`);
          continue;
        }

        const defaultPrice = itemDetails.defaultPrice || 0;

        if (defaultPrice === 0) {
          console.log(
            `\n⚠️  Skipping ItemBatch ${itemBatch._id} - Item ${itemDetails.itemName || itemDetails.itemCode} has defaultPrice = 0`,
          );
          totalBatchesSkipped++;
          continue;
        }

        let hasUpdates = false;
        let batchesFixed = 0;

        // Check branchDetails and prepare updates
        if (itemBatch.branchDetails && Array.isArray(itemBatch.branchDetails)) {
          const updatedBranchDetails = itemBatch.branchDetails.map(branchDetail => {
            const updatedBranch = { ...branchDetail };

            // Check and fix availableBatches
            if (branchDetail.availableBatches && Array.isArray(branchDetail.availableBatches)) {
              updatedBranch.availableBatches = branchDetail.availableBatches.map(batch => {
                if (batch.purchasePrice === 0 || batch.purchasePrice === null || batch.purchasePrice === undefined) {
                  hasUpdates = true;
                  batchesFixed++;
                  if (dryRun) {
                    console.log(
                      `   [DRY RUN] Would fix availableBatches - Branch: ${branchDetail.branchId}, Batch No: ${batch.batchNo}, Old Price: ${batch.purchasePrice}, New Price: ${defaultPrice}`,
                    );
                  } else {
                    console.log(
                      `   ✓ Fixing availableBatches - Branch: ${branchDetail.branchId}, Batch No: ${batch.batchNo}, Old Price: ${batch.purchasePrice}, New Price: ${defaultPrice}`,
                    );
                  }
                  return { ...batch, purchasePrice: defaultPrice };
                }
                return batch;
              });
            }

            // Check and fix completedBatches
            if (branchDetail.completedBatches && Array.isArray(branchDetail.completedBatches)) {
              updatedBranch.completedBatches = branchDetail.completedBatches.map(batch => {
                if (batch.purchasePrice === 0 || batch.purchasePrice === null || batch.purchasePrice === undefined) {
                  hasUpdates = true;
                  batchesFixed++;
                  if (dryRun) {
                    console.log(
                      `   [DRY RUN] Would fix completedBatches - Branch: ${branchDetail.branchId}, Batch No: ${batch.batchNo}, Old Price: ${batch.purchasePrice}, New Price: ${defaultPrice}`,
                    );
                  } else {
                    console.log(
                      `   ✓ Fixing completedBatches - Branch: ${branchDetail.branchId}, Batch No: ${batch.batchNo}, Old Price: ${batch.purchasePrice}, New Price: ${defaultPrice}`,
                    );
                  }
                  return { ...batch, purchasePrice: defaultPrice };
                }
                return batch;
              });
            }

            return updatedBranch;
          });

          // Update the entire branchDetails array if there were changes
          if (hasUpdates && !dryRun) {
            await ItemBatch.updateOne(
              { _id: itemBatch._id },
              {
                $set: {
                  branchDetails: updatedBranchDetails,
                },
              },
            );
          }
        }

        if (hasUpdates) {
          totalItemBatchesFixed++;
          totalBatchesFixed += batchesFixed;

          results.push({
            itemBatchId: itemBatch._id,
            companyId: itemBatch.companyId,
            itemId: itemBatch.itemId,
            itemName: itemDetails.itemName || itemDetails.itemCode || 'N/A',
            itemCode: itemDetails.itemCode || 'N/A',
            defaultPrice: defaultPrice,
            batchesFixed: batchesFixed,
          });

          if (dryRun) {
            console.log(
              `\n[DRY RUN] Would fix ItemBatch: ${itemBatch._id} - Item: ${itemDetails.itemName || itemDetails.itemCode} - Would fix ${batchesFixed} batch(es) with defaultPrice: ${defaultPrice}`,
            );
          } else {
            console.log(
              `\n✅ Fixed ItemBatch: ${itemBatch._id} - Item: ${itemDetails.itemName || itemDetails.itemCode} - Fixed ${batchesFixed} batch(es) with defaultPrice: ${defaultPrice}`,
            );
          }
        }
      } catch (itemBatchError) {
        console.error(`Error processing ItemBatch ${itemBatch._id}:`, itemBatchError.message);
      }
    }

    if (dryRun) {
      console.log(`\n=== Dry Run Summary ===`);
      console.log(`Total ItemBatch documents checked: ${itemBatches.length}`);
      console.log(`ItemBatch documents that would be fixed: ${totalItemBatchesFixed}`);
      console.log(`Total batches that would be fixed: ${totalBatchesFixed}`);
      console.log(`ItemBatches skipped (no defaultPrice): ${totalBatchesSkipped}`);
      console.log(`\n⚠️  DRY RUN MODE - No changes were made to the database`);
    } else {
      console.log(`\n=== Fix Summary ===`);
      console.log(`Total ItemBatch documents checked: ${itemBatches.length}`);
      console.log(`ItemBatch documents fixed: ${totalItemBatchesFixed}`);
      console.log(`Total batches fixed: ${totalBatchesFixed}`);
      console.log(`ItemBatches skipped (no defaultPrice): ${totalBatchesSkipped}`);
    }

    if (results.length > 0) {
      if (dryRun) {
        console.log(`\n=== Items That Would Be Fixed ===`);
        results.forEach((result, index) => {
          console.log(
            `\n${index + 1}. ${result.itemName} (${result.itemCode}) - Would fix ${result.batchesFixed} batch(es) with defaultPrice: ${result.defaultPrice}`,
          );
          console.log(`   ItemBatch ID: ${result.itemBatchId}`);
          console.log(`   Company ID: ${result.companyId}`);
        });
      } else {
        console.log(`\n=== Fixed Items ===`);
        results.forEach((result, index) => {
          console.log(
            `\n${index + 1}. ${result.itemName} (${result.itemCode}) - Fixed ${result.batchesFixed} batch(es) with defaultPrice: ${result.defaultPrice}`,
          );
          console.log(`   ItemBatch ID: ${result.itemBatchId}`);
          console.log(`   Company ID: ${result.companyId}`);
        });
      }
    } else {
      console.log(`\n✅ No batches with zero purchase price found to fix!`);
    }

    await client.close();
    process.exit(0);
  } catch (error) {
    console.error('Script failed:', error);
    process.exit(1);
  }
}

// Check for dry-run mode from command line arguments
const isDryRun = process.argv.includes('--dry-run') || process.argv.includes('-d') || process.env.DRY_RUN === 'true';

if (isDryRun) {
  console.log('🔍 DRY RUN MODE ENABLED');
  console.log('Starting dry run for ItemBatch documents with purchasePrice = 0');
  console.log('This script will show what would be changed WITHOUT making any updates.');
  console.log('To actually apply changes, run without --dry-run flag.\n');
} else {
  console.log('Starting fix for ItemBatch documents with purchasePrice = 0');
  console.log("This script will update batches with the item's defaultPrice.");
  console.log('⚠️  WARNING: This will modify your database!');
  console.log('Make sure you have backed up your database before proceeding.');
  console.log('💡 Tip: Run with --dry-run flag first to see what would be changed.\n');
}

// Add a small delay to allow user to read the message
setTimeout(() => {
  fixBatchesWithZeroPrice(isDryRun);
}, 2000);
