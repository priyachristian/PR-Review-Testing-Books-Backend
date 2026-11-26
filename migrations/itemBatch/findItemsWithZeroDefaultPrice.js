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

    console.log('Collections initialized successfully');

    return {
      Item,
      client: db.client,
    };
  } catch (error) {
    console.error('Failed to initialize databases:', error);
    throw error;
  }
};

/**
 * Find items with defaultPrice = 0
 * This script will:
 * 1. Find all items with defaultPrice = 0 (or null/undefined)
 * 2. Return companyId, itemId, itemName, and itemCode
 * 3. Save detailed results to files
 */
async function findItemsWithZeroDefaultPrice() {
  try {
    const { Item, client } = await initializeDatabases();

    // Create output directory if it doesn't exist
    const outputDir = path.join(__dirname, 'outputs');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Generate output filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const outputFile = path.join(outputDir, `items-with-zero-default-price-${timestamp}.txt`);
    const jsonOutputFile = path.join(outputDir, `items-with-zero-default-price-${timestamp}.json`);

    // Create write stream for text output
    const outputStream = fs.createWriteStream(outputFile);
    const writeToFile = text => {
      outputStream.write(text + '\n');
    };

    console.log(`\nStarting search for items with defaultPrice = 0`);
    console.log(`Output will be saved to: ${outputFile}`);
    writeToFile(`=== Items with Zero Default Price Report ===`);
    writeToFile(`Generated at: ${new Date().toISOString()}\n`);

    // Find all items with defaultPrice = 0, null, or undefined
    const items = await Item.find({
      $or: [{ defaultPrice: 0 }, { defaultPrice: null }, { defaultPrice: { $exists: false } }],
    }).toArray();

    console.log(`Found ${items.length} items with defaultPrice = 0 (or null/undefined)`);

    if (items.length === 0) {
      console.log('No items found with defaultPrice = 0. Exiting.');
      await client.close();
      return;
    }

    const results = items
      .map(item => ({
        companyId: item.companyId,
        itemId: item._id,
        itemName: item.itemName || 'N/A',
        itemCode: item.itemCode || 'N/A',
        defaultPrice: item.defaultPrice,
      }))
      .sort((a, b) => {
        // Sort by companyId (handle null/undefined)
        const aId = a.companyId ? a.companyId.toString() : 'zzz-unknown';
        const bId = b.companyId ? b.companyId.toString() : 'zzz-unknown';
        return aId.localeCompare(bId);
      });

    // Group by company for better organization
    const itemsByCompany = new Map();
    results.forEach(item => {
      const companyIdStr = item.companyId ? item.companyId.toString() : 'Unknown';
      if (!itemsByCompany.has(companyIdStr)) {
        itemsByCompany.set(companyIdStr, []);
      }
      itemsByCompany.get(companyIdStr).push(item);
    });

    // Sort company entries by companyId
    const sortedCompanies = Array.from(itemsByCompany.entries()).sort(([aId], [bId]) => {
      const a = aId === 'Unknown' ? 'zzz-unknown' : aId;
      const b = bId === 'Unknown' ? 'zzz-unknown' : bId;
      return a.localeCompare(b);
    });

    // Write summary to file
    writeToFile(`\n=== Summary ===`);
    writeToFile(`Total items with defaultPrice = 0: ${items.length}`);
    writeToFile(`Total companies affected: ${itemsByCompany.size}\n`);

    // Write sorted data grouped by company
    sortedCompanies.forEach(([companyId, companyItems]) => {
      writeToFile(`\nCompany ID: ${companyId}`);
      writeToFile(`  Total items: ${companyItems.length}`);
      companyItems.forEach((item, index) => {
        writeToFile(`  ${index + 1}. ${item.itemName} (${item.itemCode})`);
        writeToFile(`     Item ID: ${item.itemId}`);
        writeToFile(`     Default Price: ${item.defaultPrice}`);
      });
    });

    // Save JSON output (sorted by companyId)
    const sortedCompanyEntries = sortedCompanies.map(([companyId, items]) => [companyId, items]);

    fs.writeFileSync(
      jsonOutputFile,
      JSON.stringify(
        {
          summary: {
            totalItems: items.length,
            totalCompaniesAffected: itemsByCompany.size,
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
    console.log(`Total items with defaultPrice = 0: ${items.length}`);
    console.log(`Total companies affected: ${itemsByCompany.size}`);
    console.log(`\n✅ Detailed results saved to:`);
    console.log(`   Text file: ${outputFile}`);
    console.log(`   JSON file: ${jsonOutputFile}`);

    await client.close();
    process.exit(0);
  } catch (error) {
    console.error('Script failed:', error);
    process.exit(1);
  }
}

console.log('Starting search for items with defaultPrice = 0');
console.log('This script will find all items where defaultPrice is 0, null, or undefined.\n');

// Add a small delay to allow user to read the message
setTimeout(() => {
  findItemsWithZeroDefaultPrice();
}, 2000);
