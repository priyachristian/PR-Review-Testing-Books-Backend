# Inventory to Batch Migration

This migration script seeds existing inventory data from the Item model's `inventoryData.branches` into the new ItemBatch system.

## Overview

The script performs the following operations:

1. **Finds all items** with inventory data for the specified company
2. **Groups inventory by branch** - if multiple warehouses belong to the same branch, their quantities are combined
3. **Creates ItemBatch entries** with single batches containing total available stock
4. **Uses item's defaultPrice** as the purchase price for the batch

## Key Features

- **Branch-level grouping**: Inventory from multiple warehouses in the same branch is combined into a single batch
- **Default price usage**: Uses `item.defaultPrice` as the purchase price for the batch
- **Available stock priority**: Uses `availableStock` if available, otherwise falls back to `openingStock`
- **Safe execution**: Validates data and skips invalid entries
- **Detailed logging**: Provides comprehensive progress and error reporting

## Usage

### For Single Company

```bash
node seedInventoryToBatches.js <companyId>
```

### For All Companies

```bash
node seedInventoryToBatchesAll.js
```

### Examples:

```bash
# Run for specific company
node seedInventoryToBatches.js 507f1f77bcf86cd799439011

# Run for all companies
node seedInventoryToBatchesAll.js
```

## Prerequisites

1. **Database backup**: Always backup your database before running migrations
2. **Valid company ID** (for single company script): Must be a valid MongoDB ObjectId
3. **Existing inventory data**: Items must have `inventoryData.branches` with valid warehouse references

## Data Flow

### Input Data Structure (Item Model)

```javascript
{
  _id: ObjectId,
  companyId: ObjectId,
  itemName: String,
  defaultPrice: Number,
  inventoryData: {
    branches: [
      {
        warehouseId: ObjectId,  // References Warehouse
        availableStock: Number, // or openingStock
        // ... other fields
      }
    ]
  }
}
```

### Output Data Structure (ItemBatch Model)

```javascript
{
  _id: ObjectId,
  itemId: ObjectId,
  companyId: ObjectId,
  branchDetails: [
    {
      branchId: ObjectId,  // From Warehouse.branchId
      availableBatches: [
        {
          batchNo: 1,
          quantity: Number,      // Total combined quantity for branch
          remainingQty: Number,  // Same as quantity initially
          purchasePrice: Number, // From item.defaultPrice
          sourceType: 'EXISTING_INVENTORY',
          sourceId: ObjectId,    // Item ID
          deductions: []
        }
      ],
      completedBatches: []
    }
  ]
}
```

## Branch Grouping Logic

If multiple warehouses belong to the same branch:

- **Warehouse 1**: 10 units
- **Warehouse 2**: 20 units
- **Same branch**: Creates single batch with 30 units

## Safety Features

- **Validation**: Checks for valid warehouse and branch references
- **Skip invalid data**: Continues processing even if some items fail
- **Zero quantity check**: Skips items with no available stock
- **Error handling**: Catches and logs errors without stopping the migration

## Migration Summary

Both scripts provide detailed summaries including:

### Single Company Script:

- Total items processed
- Total items skipped
- Total batches created
- Any errors encountered

### All Companies Script:

- Processing progress by company
- Total items processed across all companies
- Total items skipped across all companies
- Total batches created across all companies
- Any errors encountered

## Post-Migration

After running this migration:

1. **Verify data**: Check that ItemBatch documents were created correctly
2. **Test functionality**: Ensure the new batch system works with existing inventory
3. **Monitor**: Watch for any issues in the new batch-based inventory system

## Rollback

If you need to rollback:

1. **Delete ItemBatch documents** for the company
2. **Restore from backup** if needed
3. **Re-run migration** with corrected data

## Notes

- **Single Company Script**: Designed to be run for one company at a time
- **All Companies Script**: Designed to process all companies in one run
- Both scripts use `sourceType: 'EXISTING_INVENTORY'` to identify migrated data
- Batch numbers start from 1 for existing inventory
- All batches are created as "available" (not completed)
- The all-companies script groups items by company for better progress tracking
