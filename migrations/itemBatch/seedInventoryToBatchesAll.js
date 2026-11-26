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
    const Item = db.booksCrm.collection('items');
    const Warehouse = db.booksCrm.collection('warehouses');
    const ItemBatch = db.books.collection('itembatches');

    console.log('Collections initialized successfully');

    return {
      Item,
      Warehouse,
      ItemBatch,
      client: db.client,
    };
  } catch (error) {
    console.error('Failed to initialize databases:', error);
    throw error;
  }
};

/**
 * Seed existing inventory data into ItemBatch system for ALL companies
 * This script will:
 * 1. Find all items with inventory data across all companies
 * 2. Group inventory by branch (warehouse -> branch mapping)
 * 3. Create ItemBatch entries with single batches containing total available stock
 * 4. Use item's defaultPrice as purchase price
 */
async function seedInventoryToBatchesAll() {
  try {
    const { Item, Warehouse, ItemBatch, client } = await initializeDatabases();

    console.log(`\nStarting inventory to batch migration for ALL companies`);

    // Find all items with inventory data across all companies
    const items = await Item.find({
      'inventoryData.branches': { $exists: true, $ne: [] },
    }).toArray();

    console.log(`Found ${items.length} items with inventory data across all companies`);

    if (items.length === 0) {
      console.log('No items found with inventory data. Migration completed.');
      await client.close();
      return;
    }

    let totalBatchesCreated = 0;
    let totalItemsProcessed = 0;
    let skippedItems = 0;

    // Group items by company for better tracking
    const itemsByCompany = new Map();
    for (const item of items) {
      const companyId = item.companyId.toString();
      if (!itemsByCompany.has(companyId)) {
        itemsByCompany.set(companyId, []);
      }
      itemsByCompany.get(companyId).push(item);
    }

    console.log(`Processing items from ${itemsByCompany.size} companies`);

    for (const [companyId, companyItems] of itemsByCompany) {
      console.log(`\n🏢 Processing Company: ${companyId} (${companyItems.length} items)`);

      for (const item of companyItems) {
        try {
          console.log(`  Processing item: ${item.itemName || item.itemCode} (${item._id})`);

          if (!item.inventoryData || !item.inventoryData.branches || item.inventoryData.branches.length === 0) {
            console.log(`    Skipping - no inventory branches found`);
            skippedItems++;
            continue;
          }

          // Group inventory by branch (warehouse -> branch mapping)
          const branchInventoryMap = new Map();

          for (const branch of item.inventoryData.branches) {
            if (!branch.warehouseId) {
              console.log(`    Skipping branch - no warehouseId`);
              continue;
            }

            // Get warehouse details to find branchId
            const warehouse = await Warehouse.findOne({ _id: branch.warehouseId });
            if (!warehouse) {
              console.log(`    Skipping - warehouse not found: ${branch.warehouseId}`);
              continue;
            }

            const branchId = warehouse.branchId;
            if (!branchId) {
              console.log(`    Skipping - warehouse has no branchId: ${branch.warehouseId}`);
              continue;
            }

            // Get available stock (use availableStock if exists, otherwise use openingStock)
            const availableStock = branch.availableStock !== undefined ? branch.availableStock : branch.openingStock || 0;

            if (availableStock <= 0) {
              console.log(`    Skipping - no available stock for warehouse: ${warehouse.name}`);
              continue;
            }

            console.log(
              `    Warehouse: ${warehouse.name} (${branch.warehouseId}) -> Branch: ${branchId} -> Stock: ${availableStock}`,
            );

            // Group by branch - if multiple warehouses belong to same branch, combine quantities
            if (branchInventoryMap.has(branchId.toString())) {
              const existing = branchInventoryMap.get(branchId.toString());
              const oldTotal = existing.totalQuantity;
              existing.totalQuantity += availableStock;
              existing.warehouses.push({
                warehouseId: branch.warehouseId,
                warehouseName: warehouse.name,
                quantity: availableStock,
              });
              console.log(
                `      Added to existing branch ${branchId}: ${oldTotal} + ${availableStock} = ${existing.totalQuantity}`,
              );
            } else {
              branchInventoryMap.set(branchId.toString(), {
                branchId: branchId,
                totalQuantity: availableStock,
                warehouses: [
                  {
                    warehouseId: branch.warehouseId,
                    warehouseName: warehouse.name,
                    quantity: availableStock,
                  },
                ],
              });
              console.log(`      Created new branch ${branchId} with quantity: ${availableStock}`);
            }
          }

          if (branchInventoryMap.size === 0) {
            console.log(`    Skipping - no valid inventory found`);
            skippedItems++;
            continue;
          }

          // Debug: Show final branch summary
          console.log(`    Final branch summary for item:`);
          for (const [branchIdStr, branchData] of branchInventoryMap) {
            console.log(
              `      Branch ${branchIdStr}: ${branchData.totalQuantity} units from ${branchData.warehouses.length} warehouses`,
            );
            branchData.warehouses.forEach(wh => {
              console.log(`        - ${wh.warehouseName}: ${wh.quantity} units`);
            });
          }

          // Create ItemBatch entries for each branch
          for (const [branchIdStr, branchData] of branchInventoryMap) {
            try {
              console.log(`    Processing branch: ${branchIdStr} with total quantity: ${branchData.totalQuantity}`);

              // Check if ItemBatch already exists for this item and company
              let existingItemBatch = await ItemBatch.findOne({
                itemId: item._id,
                companyId: new ObjectId(companyId),
              });

              const purchasePrice = item.defaultPrice || 0;

              // Create batch entry
              const batchEntry = {
                batchNo: 1, // First batch for existing inventory
                quantity: branchData.totalQuantity,
                remainingQty: branchData.totalQuantity,
                purchasePrice: purchasePrice,
                vendorBatchNo: null,
                vendorBatchExpiry: null,
                sourceType: 'EXISTING_INVENTORY', // Special source type for migrated data
                sourceId: item._id, // Use item ID as source
                deductions: [],
              };

              if (existingItemBatch) {
                // Check if branch details already exist
                const branchDetailIndex = existingItemBatch.branchDetails.findIndex(
                  branch => branch.branchId.toString() === branchIdStr,
                );

                if (branchDetailIndex !== -1) {
                  // Branch exists, add to availableBatches
                  await ItemBatch.updateOne(
                    {
                      _id: existingItemBatch._id,
                      'branchDetails.branchId': branchData.branchId,
                    },
                    {
                      $push: { 'branchDetails.$.availableBatches': batchEntry },
                    },
                  );
                  console.log(`      Added batch to existing branch details`);
                } else {
                  // Branch doesn't exist, add new branch detail
                  await ItemBatch.updateOne(
                    { _id: existingItemBatch._id },
                    {
                      $push: {
                        branchDetails: {
                          branchId: branchData.branchId,
                          availableBatches: [batchEntry],
                          completedBatches: [],
                        },
                      },
                    },
                  );
                  console.log(`      Added new branch details with batch`);
                }
              } else {
                // Create new ItemBatch document
                await ItemBatch.insertOne({
                  companyId: new ObjectId(companyId),
                  itemId: item._id,
                  branchDetails: [
                    {
                      branchId: branchData.branchId,
                      availableBatches: [batchEntry],
                      completedBatches: [],
                    },
                  ],
                });
                console.log(`      Created new ItemBatch document`);
              }

              totalBatchesCreated++;
              console.log(`      Successfully created batch with ${branchData.totalQuantity} quantity at price ${purchasePrice}`);
            } catch (branchError) {
              console.error(`    Error processing branch ${branchIdStr}:`, branchError.message);
            }
          }

          totalItemsProcessed++;
          console.log(`    Completed processing item: ${item.itemName || item.itemCode}`);
        } catch (itemError) {
          console.error(`Error processing item ${item._id}:`, itemError.message);
        }
      }
    }

    console.log(`\n=== Migration Summary for ALL Companies ===`);
    console.log(`Total items processed: ${totalItemsProcessed}`);
    console.log(`Total items skipped: ${skippedItems}`);
    console.log(`Total batches created: ${totalBatchesCreated}`);
    console.log(`Migration completed successfully for all companies!`);

    await client.close();
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

// Start the migration
console.log('🚀 Starting Inventory to Batch Migration for ALL Companies');
console.log('📦 This will create ItemBatch entries for existing inventory data');
console.log('⚠️  Make sure you have backed up your database before proceeding');
console.log('');

// Add a small delay to allow user to read the message
setTimeout(() => {
  seedInventoryToBatchesAll();
}, 2000);
