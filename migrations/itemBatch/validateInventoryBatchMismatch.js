const mongoose = require('mongoose');
const config = require('../../config/config');
const db = require('@smit9313/abss-models-core');
const path = require('path');
const fs = require('fs');

// Load project-specific models
const loadProjectModels = () => {
  const projectModels = { common: {}, booksCrm: {}, books: {} };
  const modelsDir = path.join(__dirname, '..', '..', 'models');

  if (fs.existsSync(modelsDir)) {
    fs.readdirSync(modelsDir).forEach(file => {
      if (file.endsWith('.model.js')) {
        const schema = require(path.join(modelsDir, file));
        const modelName = file.replace('.model.js', '').replace(/^\w/, c => c.toUpperCase());
        projectModels.books[modelName] = schema;
      }
    });
  }

  return projectModels;
};

// Initialize database connections and models
const initializeDatabases = async () => {
  try {
    console.log('Connecting to MongoDB...');
    const connection = await mongoose.createConnection(config.mongoose.cluster_url, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 30000,
      heartbeatFrequencyMS: 10000,
    });

    console.log('Connected to MongoDB successfully');

    // Use useDb for each database
    const commonConn = connection.useDb(config.mongoose.db_names.common);
    const booksCrmConn = connection.useDb(config.mongoose.db_names.booksCrm);
    const booksConn = connection.useDb(config.mongoose.db_names.books);

    console.log('Using databases:', {
      common: config.mongoose.db_names.common,
      booksCrm: config.mongoose.db_names.booksCrm,
      books: config.mongoose.db_names.books,
    });

    try {
      // Try to load project-specific models first
      const projectModels = loadProjectModels();

      // Initialize models for each database
      const commonModels = await db.models.getModels('common', commonConn, projectModels);
      const booksCrmModels = await db.models.getModels('books-crm', booksCrmConn, projectModels);
      const booksModels = await db.models.getModels('books', booksConn, projectModels);

      console.log('Models initialized successfully using @smit9313/abss-models-core');

      return {
        commonConn,
        booksCrmConn,
        booksConn,
        commonModels,
        booksCrmModels,
        booksModels,
        connection,
      };
    } catch (modelError) {
      console.log('Model loading failed, falling back to collection approach:', modelError.message);

      // Fallback to direct collections
      const Item = booksCrmConn.collection('items');
      const Warehouse = booksCrmConn.collection('warehouses');
      const ItemBatch = booksConn.collection('itembatches');

      console.log('Collections initialized successfully (fallback mode)');

      return {
        commonConn,
        booksCrmConn,
        booksConn,
        Item,
        Warehouse,
        ItemBatch,
        connection,
        useCollections: true, // Flag to indicate we're using collections
      };
    }
  } catch (error) {
    console.error('Failed to initialize databases:', error);
    throw error;
  }
};

/**
 * Validate and find mismatches between Item inventory data and ItemBatch data
 * This script will:
 * 1. Accept a specific companyId as command line argument
 * 2. Compare Item.inventoryData.branches with ItemBatch.branchDetails for that company
 * 3. Identify mismatches in quantities, missing batches, extra batches, etc.
 * 4. Generate a detailed report
 */
async function validateInventoryBatchMismatch(companyId) {
  try {
    const dbConnection = await initializeDatabases();
    const { connection, useCollections } = dbConnection;

    let Item, Warehouse, ItemBatch;

    if (useCollections) {
      // Using collections (fallback mode)
      ({ Item, Warehouse, ItemBatch } = dbConnection);
    } else {
      // Using models
      const { booksCrmModels, booksModels } = dbConnection;
      ({ Item, Warehouse } = booksCrmModels);
      ({ ItemBatch } = booksModels);
    }

    console.log(`\n🔍 Starting Inventory-Batch Mismatch Validation for Company: ${companyId}`);

    // Validate the company exists
    const companyExists = useCollections
      ? await Item.findOne({ companyId: companyId })
      : await Item.findOne({ companyId: companyId }).lean();

    if (!companyExists) {
      console.log(`❌ Company ${companyId} not found in the system.`);
      await connection.close();
      return;
    }

    // Get all items for this specific company
    const companyItems = useCollections
      ? await Item.find({
          companyId: companyId,
          'inventoryData.branches': { $exists: true, $ne: [] },
        }).toArray()
      : await Item.find({
          companyId: companyId,
          'inventoryData.branches': { $exists: true, $ne: [] },
        }).lean();

    console.log(`Found ${companyItems.length} items with inventory data for company ${companyId}`);

    if (companyItems.length === 0) {
      console.log(`No items found for company ${companyId}. Validation completed.`);
      await connection.close();
      return;
    }

    let totalMismatches = 0;
    let totalItemsValidated = 0;
    let totalItemsWithIssues = 0;

    for (const item of companyItems) {
      try {
        const itemIssues = [];

        // Get ItemBatch for this item
        const itemBatch = useCollections
          ? await ItemBatch.findOne({
              itemId: item._id,
              companyId: companyId,
            })
          : await ItemBatch.findOne({
              itemId: item._id,
              companyId: companyId,
            }).lean();

        if (!itemBatch) {
          itemIssues.push('❌ No ItemBatch found for this item');
          totalMismatches++;
          totalItemsWithIssues++;
          continue;
        }

        // Validate each branch
        for (const branch of item.inventoryData.branches) {
          if (!branch.warehouseId) {
            continue;
          }

          // Get warehouse details to find branchId
          const warehouse = useCollections
            ? await Warehouse.findOne({ _id: new mongoose.Types.ObjectId(branch.warehouseId) })
            : await Warehouse.findById(branch.warehouseId).lean();
          if (!warehouse || !warehouse.branchId) {
            continue;
          }

          const branchId = warehouse.branchId;
          const availableStock = branch.availableStock !== undefined ? branch.availableStock : branch.openingStock || 0;

          if (availableStock <= 0) {
            continue;
          }

          // Find corresponding branch detail in ItemBatch
          const batchBranchDetail = itemBatch.branchDetails.find(bd => bd.branchId.toString() === branchId.toString());

          if (!batchBranchDetail) {
            itemIssues.push(`❌ Branch ${branchId} not found in ItemBatch`);
            totalMismatches++;
            continue;
          }

          // Calculate total batch quantity for this branch
          const totalBatchQuantity = batchBranchDetail.availableBatches.reduce((sum, batch) => sum + batch.remainingQty, 0);

          // Check quantity mismatch
          if (Math.abs(totalBatchQuantity - availableStock) > 0.01) {
            // Allow small floating point differences
            itemIssues.push(
              `⚠️  Branch ${branchId}: Item stock ${availableStock} vs Batch total ${totalBatchQuantity} (diff: ${availableStock - totalBatchQuantity})`,
            );
            totalMismatches++;
          }

          // Check for empty batches
          const emptyBatches = batchBranchDetail.availableBatches.filter(batch => batch.remainingQty <= 0);
          if (emptyBatches.length > 0) {
            itemIssues.push(`⚠️  Branch ${branchId}: ${emptyBatches.length} empty batches found`);
            totalMismatches++;
          }

          // Check for negative remaining quantities
          const negativeBatches = batchBranchDetail.availableBatches.filter(batch => batch.remainingQty < 0);
          if (negativeBatches.length > 0) {
            itemIssues.push(`❌ Branch ${branchId}: ${negativeBatches.length} batches with negative remaining quantity`);
            totalMismatches++;
          }
        }

        // Check for extra branches in ItemBatch that don't exist in Item
        const itemBranchIds = new Set();
        for (const branch of item.inventoryData.branches) {
          if (branch.warehouseId) {
            const warehouse = useCollections
              ? await Warehouse.findOne({ _id: new mongoose.Types.ObjectId(branch.warehouseId) })
              : await Warehouse.findById(branch.warehouseId).lean();
            if (warehouse && warehouse.branchId) {
              itemBranchIds.add(warehouse.branchId.toString());
            }
          }
        }

        for (const batchBranch of itemBatch.branchDetails) {
          if (!itemBranchIds.has(batchBranch.branchId.toString())) {
            itemIssues.push(`⚠️  Extra branch ${batchBranch.branchId} found in ItemBatch but not in Item inventory`);
            totalMismatches++;
          }
        }

        if (itemIssues.length > 0) {
          console.log(`  Item: ${item.itemName || item.itemCode} (${item._id})`);
          itemIssues.forEach(issue => console.log(`    ${issue}`));
          totalItemsWithIssues++;
        }

        totalItemsValidated++;
      } catch (itemError) {
        console.error(`  Error validating item ${item._id}:`, itemError.message);
        totalMismatches++;
      }
    }

    console.log(`\n=== Validation Summary for Company ${companyId} ===`);
    console.log(`Total items validated: ${totalItemsValidated}`);
    console.log(`Total items with issues: ${totalItemsWithIssues}`);
    console.log(`Total mismatches found: ${totalMismatches}`);

    if (totalMismatches === 0) {
      console.log(`✅ All items validated successfully! No mismatches found.`);
    } else {
      console.log(`⚠️  Found ${totalMismatches} mismatches that need attention.`);
    }

    console.log(`Validation completed!`);

    await connection.close();
    process.exit(0);
  } catch (error) {
    console.error('Validation failed:', error);
    process.exit(1);
  }
}

// Start the validation
const companyId = process.argv[2];

if (!companyId) {
  console.log('❌ Error: Company ID is required!');
  console.log('Usage: node validateInventoryBatchMismatch.js <companyId>');
  console.log('Example: node validateInventoryBatchMismatch.js 507f1f77bcf86cd799439011');
  process.exit(1);
}

console.log('🔍 Starting Inventory-Batch Mismatch Validation');
console.log('📊 This will compare Item inventory data with ItemBatch data');
console.log(`🏢 Company ID: ${companyId}`);
console.log('⚠️  This is a read-only operation - no data will be modified');
console.log('');

// Add a small delay to allow user to read the message
setTimeout(() => {
  validateInventoryBatchMismatch(companyId);
}, 2000);
