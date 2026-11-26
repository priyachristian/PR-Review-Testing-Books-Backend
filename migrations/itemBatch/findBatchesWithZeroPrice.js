const { getConnection } = require('../../config/db');
const fs = require('fs');
const path = require('path');

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
 * Find ItemBatch documents with purchasePrice = 0
 * This script will:
 * 1. Find all ItemBatch documents
 * 2. Check both availableBatches and completedBatches for purchasePrice = 0
 * 3. Report findings with item details
 * 4. Save detailed results to a file
 */
async function findBatchesWithZeroPrice() {
  try {
    const { Item, ItemBatch, client } = await initializeDatabases();

    // Create output directory if it doesn't exist
    const outputDir = path.join(__dirname, 'outputs');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Generate output filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const outputFile = path.join(outputDir, `batches-with-zero-price-${timestamp}.txt`);
    const jsonOutputFile = path.join(outputDir, `batches-with-zero-price-${timestamp}.json`);

    // Create write stream for text output
    const outputStream = fs.createWriteStream(outputFile);
    const writeToFile = text => {
      outputStream.write(text + '\n');
    };

    console.log(`\nStarting search for batches with purchasePrice = 0`);
    console.log(`Output will be saved to: ${outputFile}`);
    writeToFile(`=== Batches with Zero Purchase Price Report ===`);
    writeToFile(`Generated at: ${new Date().toISOString()}\n`);

    // Find all ItemBatch documents
    const itemBatches = await ItemBatch.find({}).toArray();

    console.log(`Found ${itemBatches.length} ItemBatch documents to check`);

    if (itemBatches.length === 0) {
      console.log('No ItemBatch documents found. Exiting.');
      await client.close();
      return;
    }

    let totalItemBatchesWithZeroPrice = 0;
    let totalBatchesWithZeroPrice = 0;
    const results = [];

    for (const itemBatch of itemBatches) {
      try {
        const batchesWithZeroPrice = [];
        let hasZeroPriceBatch = false;

        // Check branchDetails
        if (itemBatch.branchDetails && Array.isArray(itemBatch.branchDetails)) {
          for (const branchDetail of itemBatch.branchDetails) {
            // Check availableBatches
            if (branchDetail.availableBatches && Array.isArray(branchDetail.availableBatches)) {
              for (const batch of branchDetail.availableBatches) {
                if (batch.purchasePrice === 0 || batch.purchasePrice === null || batch.purchasePrice === undefined) {
                  hasZeroPriceBatch = true;
                  batchesWithZeroPrice.push({
                    type: 'availableBatches',
                    branchId: branchDetail.branchId,
                    batchNo: batch.batchNo,
                    quantity: batch.quantity,
                    remainingQty: batch.remainingQty,
                    purchasePrice: batch.purchasePrice,
                    sourceType: batch.sourceType,
                    sourceId: batch.sourceId,
                  });
                }
              }
            }

            // Check completedBatches
            if (branchDetail.completedBatches && Array.isArray(branchDetail.completedBatches)) {
              for (const batch of branchDetail.completedBatches) {
                if (batch.purchasePrice === 0 || batch.purchasePrice === null || batch.purchasePrice === undefined) {
                  hasZeroPriceBatch = true;
                  batchesWithZeroPrice.push({
                    type: 'completedBatches',
                    branchId: branchDetail.branchId,
                    batchNo: batch.batchNo,
                    quantity: batch.quantity,
                    remainingQty: batch.remainingQty,
                    purchasePrice: batch.purchasePrice,
                    sourceType: batch.sourceType,
                    sourceId: batch.sourceId,
                  });
                }
              }
            }
          }
        }

        if (hasZeroPriceBatch) {
          totalItemBatchesWithZeroPrice++;
          totalBatchesWithZeroPrice += batchesWithZeroPrice.length;

          // Get item details for better reporting
          let itemDetails = null;
          if (itemBatch.itemId) {
            itemDetails = await Item.findOne({ _id: itemBatch.itemId });
          }

          const defaultPrice = itemDetails ? itemDetails.defaultPrice || 0 : 0;

          results.push({
            itemBatchId: itemBatch._id,
            companyId: itemBatch.companyId,
            itemId: itemBatch.itemId,
            itemName: itemDetails ? itemDetails.itemName || itemDetails.itemCode || 'N/A' : 'N/A',
            itemCode: itemDetails ? itemDetails.itemCode : 'N/A',
            defaultPrice: defaultPrice,
            batchesWithZeroPrice: batchesWithZeroPrice,
            totalBatches: batchesWithZeroPrice.length,
          });

          // Show minimal console output for progress
          console.log(
            `⚠️  Found: ${itemDetails ? itemDetails.itemName || itemDetails.itemCode || 'N/A' : 'N/A'} - ${batchesWithZeroPrice.length} batch(es) with zero price`,
          );
        }
      } catch (itemBatchError) {
        console.error(`Error processing ItemBatch ${itemBatch._id}:`, itemBatchError.message);
      }
    }

    // Sort results by companyId
    results.sort((a, b) => {
      const aId = a.companyId ? a.companyId.toString() : 'zzz-unknown';
      const bId = b.companyId ? b.companyId.toString() : 'zzz-unknown';
      return aId.localeCompare(bId);
    });

    // Group by company
    const itemsByCompany = new Map();
    results.forEach(result => {
      const companyIdStr = result.companyId ? result.companyId.toString() : 'Unknown';
      if (!itemsByCompany.has(companyIdStr)) {
        itemsByCompany.set(companyIdStr, []);
      }
      itemsByCompany.get(companyIdStr).push(result);
    });

    // Sort company entries by companyId
    const sortedCompanies = Array.from(itemsByCompany.entries()).sort(([aId], [bId]) => {
      const a = aId === 'Unknown' ? 'zzz-unknown' : aId;
      const b = bId === 'Unknown' ? 'zzz-unknown' : bId;
      return a.localeCompare(b);
    });

    // Write summary to file
    writeToFile(`\n=== Summary ===`);
    writeToFile(`Total ItemBatch documents checked: ${itemBatches.length}`);
    writeToFile(`ItemBatch documents with zero price batches: ${totalItemBatchesWithZeroPrice}`);
    writeToFile(`Total batches with zero price: ${totalBatchesWithZeroPrice}\n`);

    // Write sorted data grouped by company
    if (sortedCompanies.length > 0) {
      sortedCompanies.forEach(([companyId, companyItems]) => {
        writeToFile(`\nCompany ID: ${companyId}`);
        writeToFile(`  Total items: ${companyItems.length}`);
        companyItems.forEach((result, index) => {
          writeToFile(`\n  ${index + 1}. ${result.itemName} (${result.itemCode})`);
          writeToFile(`     ItemBatch ID: ${result.itemBatchId}`);
          writeToFile(`     Item ID: ${result.itemId}`);
          writeToFile(`     Item Default Price: ${result.defaultPrice}`);
          writeToFile(`     Batches with zero price: ${result.totalBatches}`);
          result.batchesWithZeroPrice.forEach((batch, batchIndex) => {
            writeToFile(
              `       Batch ${batchIndex + 1}: ${batch.type} - Branch: ${batch.branchId}, Batch No: ${batch.batchNo}, Qty: ${batch.quantity}, Remaining: ${batch.remainingQty}, Price: ${batch.purchasePrice}, Source: ${batch.sourceType}`,
            );
          });
        });
      });
    } else {
      writeToFile(`\n✅ No batches with zero purchase price found!`);
    }

    // Save JSON output (sorted by companyId)
    const sortedCompanyEntries = sortedCompanies.map(([companyId, items]) => [companyId, items]);

    fs.writeFileSync(
      jsonOutputFile,
      JSON.stringify(
        {
          summary: {
            totalItemBatchesChecked: itemBatches.length,
            totalItemBatchesWithZeroPrice,
            totalBatchesWithZeroPrice,
            generatedAt: new Date().toISOString(),
          },
          itemsByCompany: Object.fromEntries(sortedCompanyEntries),
        },
        null,
        2,
      ),
    );

    // Close output stream
    outputStream.end();

    // Console summary
    console.log(`\n=== Summary ===`);
    console.log(`Total ItemBatch documents checked: ${itemBatches.length}`);
    console.log(`ItemBatch documents with zero price batches: ${totalItemBatchesWithZeroPrice}`);
    console.log(`Total batches with zero price: ${totalBatchesWithZeroPrice}`);
    console.log(`\n✅ Detailed results saved to:`);
    console.log(`   Text file: ${outputFile}`);
    console.log(`   JSON file: ${jsonOutputFile}`);

    if (results.length === 0) {
      console.log(`\n✅ No batches with zero purchase price found!`);
    }

    await client.close();
    process.exit(0);
  } catch (error) {
    console.error('Script failed:', error);
    process.exit(1);
  }
}

console.log('Starting search for ItemBatch documents with purchasePrice = 0');
console.log('This script will check both availableBatches and completedBatches.\n');

// Add a small delay to allow user to read the message
setTimeout(() => {
  findBatchesWithZeroPrice();
}, 2000);
