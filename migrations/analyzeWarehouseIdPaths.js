const fs = require('fs');
const path = require('path');

/**
 * Normalizes a path by replacing array indices with *
 * @param {string} path - The path to normalize
 * @returns {string} Normalized path with array indices replaced by *
 */
function normalizePath(pathStr) {
  // Replace patterns like [0], [1], [123] with [*]
  return pathStr.replace(/\[\d+\]/g, '[*]');
}

/**
 * Recursively searches for warehouseId, inventoryInwarehouseId, and toWarehouseId fields in an object and returns all paths
 * @param {Object} obj - The object to search
 * @param {string} prefix - Current path prefix (for dot notation)
 * @param {Array} paths - Array to collect found paths
 * @returns {Array} Array of objects with path and value
 */
function findWarehouseIdPaths(obj, prefix = '', paths = []) {
  if (!obj || typeof obj !== 'object') {
    return paths;
  }

  // Check if current object has warehouseId
  if (obj.hasOwnProperty('warehouseId') && obj.warehouseId !== null && obj.warehouseId !== undefined) {
    const fullPath = prefix ? `${prefix}.warehouseId` : 'warehouseId';
    paths.push({
      path: fullPath,
      value: obj.warehouseId,
      valueType: typeof obj.warehouseId,
    });
  }

  // Check if current object has inventoryInwarehouseId (for production orders)
  if (
    obj.hasOwnProperty('inventoryInwarehouseId') &&
    obj.inventoryInwarehouseId !== null &&
    obj.inventoryInwarehouseId !== undefined
  ) {
    const fullPath = prefix ? `${prefix}.inventoryInwarehouseId` : 'inventoryInwarehouseId';
    paths.push({
      path: fullPath,
      value: obj.inventoryInwarehouseId,
      valueType: typeof obj.inventoryInwarehouseId,
    });
  }

  // Check if current object has toWarehouseId (for inventory transfer requests)
  if (obj.hasOwnProperty('toWarehouseId') && obj.toWarehouseId !== null && obj.toWarehouseId !== undefined) {
    const fullPath = prefix ? `${prefix}.toWarehouseId` : 'toWarehouseId';
    paths.push({
      path: fullPath,
      value: obj.toWarehouseId,
      valueType: typeof obj.toWarehouseId,
    });
  }

  // Recursively search through all properties
  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      const value = obj[key];
      const currentPath = prefix ? `${prefix}.${key}` : key;

      if (value !== null && typeof value === 'object') {
        if (Array.isArray(value)) {
          // Handle arrays - check each element
          value.forEach((item, index) => {
            if (item !== null && typeof item === 'object') {
              findWarehouseIdPaths(item, `${currentPath}[${index}]`, paths);
            }
          });
        } else {
          // Recursively search nested objects
          findWarehouseIdPaths(value, currentPath, paths);
        }
      }
    }
  }

  return paths;
}

/**
 * Main function to analyze the missing warehouse batches JSON file
 */
function analyzeWarehouseIdPaths() {
  const migrationsDir = __dirname;

  // Find the most recent missing-warehouse-batches JSON file
  const files = fs
    .readdirSync(migrationsDir)
    .filter(file => file.startsWith('missing-warehouse-batches-') && file.endsWith('.json'))
    .map(file => ({
      name: file,
      path: path.join(migrationsDir, file),
      time: fs.statSync(path.join(migrationsDir, file)).mtime,
    }))
    .sort((a, b) => b.time - a.time);

  if (files.length === 0) {
    console.error('No missing-warehouse-batches JSON file found in migrations directory');
    console.log('Please run the itemBatchMigrations.js script first to generate the JSON file.');
    return;
  }

  const inputFile = files[0].path;
  console.log(`Reading file: ${inputFile}`);

  // Read and parse the JSON file
  const data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  console.log(`Found ${data.length} records to analyze\n`);

  // Map to store unique field paths and their occurrences
  const pathMap = new Map();
  const pathDetails = new Map(); // Store detailed info for each path

  // Array to store records with no warehouseId at any depth
  const recordsWithoutWarehouseId = [];

  let processedCount = 0;
  let foundCount = 0;
  let notFoundCount = 0;

  // Process each record
  for (const record of data) {
    processedCount++;

    if (!record.sourceDocument) {
      notFoundCount++;
      // Include records without sourceDocument in the no-warehouseId list
      recordsWithoutWarehouseId.push({
        sourceId: record.sourceId,
        sourceType: record.sourceType,
        companyId: null,
        itemBatchId: record.itemBatchId,
        itemId: record.itemId,
        branchId: record.branchId,
        batchType: record.batchType,
        batchNo: record.batchNo,
        quantity: record.quantity,
        price: record.price,
        expiryDate: record.expiryDate,
        manufacturingDate: record.manufacturingDate,
        reason: record.reason || 'No sourceDocument found',
        collectionName: record.collectionName,
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
        batchCreatedAt: record.createdAt
          ? record.createdAt instanceof Date
            ? record.createdAt.toISOString()
            : record.createdAt
          : null,
        batchUpdatedAt: record.updatedAt
          ? record.updatedAt instanceof Date
            ? record.updatedAt.toISOString()
            : record.updatedAt
          : null,
      });
      continue;
    }

    // Find all warehouseId paths in the source document
    const paths = findWarehouseIdPaths(record.sourceDocument);

    if (paths.length > 0) {
      foundCount++;

      // Group by normalized path and collect source info
      for (const pathInfo of paths) {
        const actualPath = pathInfo.path;
        const normalizedPath = normalizePath(actualPath);

        if (!pathMap.has(normalizedPath)) {
          pathMap.set(normalizedPath, {
            fieldPath: normalizedPath,
            count: 0,
            sourceTypes: new Set(),
            sourceIds: [],
            valueTypes: new Set(),
            sampleValues: [],
            actualPaths: new Set(), // Store actual paths with indices
          });
        }

        const pathData = pathMap.get(normalizedPath);
        pathData.count++;
        pathData.sourceTypes.add(record.sourceType);
        pathData.actualPaths.add(actualPath); // Store the actual path

        if (record.sourceId) {
          pathData.sourceIds.push({
            sourceId: record.sourceId,
            sourceType: record.sourceType,
            itemId: record.itemId,
            batchNo: record.batchNo,
          });
        }

        pathData.valueTypes.add(pathInfo.valueType);

        // Keep up to 5 sample values
        if (pathData.sampleValues.length < 5) {
          pathData.sampleValues.push(pathInfo.value);
        }
      }
    } else {
      notFoundCount++;

      // Extract additional fields from sourceDocument if available
      let companyId = null;
      let sourceCreatedAt = null;
      let sourceUpdatedAt = null;

      if (record.sourceDocument) {
        // Try to get companyId from sourceDocument (could be at root or nested)
        // Check various possible locations
        companyId =
          record.sourceDocument.companyId ||
          record.sourceDocument.company ||
          record.sourceDocument.companyId?.toString() ||
          record.sourceDocument.company?.toString() ||
          (record.sourceDocument.companyId && String(record.sourceDocument.companyId)) ||
          (record.sourceDocument.company && String(record.sourceDocument.company)) ||
          null;

        // Convert to string if it's an ObjectId-like object
        if (companyId && typeof companyId === 'object' && companyId.toString) {
          companyId = companyId.toString();
        } else if (companyId) {
          companyId = String(companyId);
        }

        // Extract timestamps from source document
        sourceCreatedAt = record.sourceDocument.createdAt || null;
        sourceUpdatedAt = record.sourceDocument.updatedAt || null;

        // Convert dates to ISO strings if they're Date objects
        if (sourceCreatedAt instanceof Date) {
          sourceCreatedAt = sourceCreatedAt.toISOString();
        } else if (sourceCreatedAt && typeof sourceCreatedAt === 'string') {
          // Keep as is if already a string
        }

        if (sourceUpdatedAt instanceof Date) {
          sourceUpdatedAt = sourceUpdatedAt.toISOString();
        } else if (sourceUpdatedAt && typeof sourceUpdatedAt === 'string') {
          // Keep as is if already a string
        }
      }

      // Store records with no warehouseId found at any depth
      recordsWithoutWarehouseId.push({
        sourceId: record.sourceId,
        sourceType: record.sourceType,
        companyId: companyId,
        itemBatchId: record.itemBatchId,
        itemId: record.itemId,
        branchId: record.branchId,
        batchType: record.batchType,
        batchNo: record.batchNo,
        quantity: record.quantity,
        price: record.price,
        expiryDate: record.expiryDate,
        manufacturingDate: record.manufacturingDate,
        reason: record.reason,
        collectionName: record.collectionName,
        // Source timestamps
        sourceCreatedAt: sourceCreatedAt,
        sourceUpdatedAt: sourceUpdatedAt,
        // Batch timestamps (if available in the record)
        batchCreatedAt: record.createdAt
          ? record.createdAt instanceof Date
            ? record.createdAt.toISOString()
            : record.createdAt
          : null,
        batchUpdatedAt: record.updatedAt
          ? record.updatedAt instanceof Date
            ? record.updatedAt.toISOString()
            : record.updatedAt
          : null,
      });
    }

    // Log progress every 1000 records
    if (processedCount % 1000 === 0) {
      console.log(`Processed ${processedCount}/${data.length} records...`);
    }
  }

  console.log(`\nAnalysis complete!`);
  console.log(`Total records: ${processedCount}`);
  console.log(`Records with warehouseId found: ${foundCount}`);
  console.log(`Records without warehouseId: ${notFoundCount}`);
  console.log(`Unique field paths found: ${pathMap.size}\n`);

  // Convert Sets to Arrays for JSON serialization
  const results = Array.from(pathMap.values()).map(pathData => ({
    fieldPath: pathData.fieldPath, // Normalized path with *
    occurrenceCount: pathData.count,
    sourceTypes: Array.from(pathData.sourceTypes).sort(),
    sourceIds: pathData.sourceIds.slice(0, 10), // Limit to first 10 sourceIds per path
    valueTypes: Array.from(pathData.valueTypes),
    sampleValues: pathData.sampleValues,
    actualPaths: Array.from(pathData.actualPaths).sort(), // Actual paths with specific indices
  }));

  // Sort by occurrence count (most common first)
  results.sort((a, b) => b.occurrenceCount - a.occurrenceCount);

  // Generate output filename
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputFile = path.join(migrationsDir, `warehouse-id-paths-analysis-${timestamp}.json`);

  // Write results to JSON file
  const output = {
    summary: {
      totalRecords: processedCount,
      recordsWithWarehouseId: foundCount,
      recordsWithoutWarehouseId: notFoundCount,
      uniqueFieldPaths: pathMap.size,
      analyzedFile: path.basename(inputFile),
    },
    fieldPaths: results,
  };

  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
  console.log(`Results saved to: ${outputFile}`);
  console.log(`\nTop 5 most common field paths:`);
  results.forEach((result, index) => {
    console.log(`  ${index + 1}. ${result.fieldPath} (found ${result.occurrenceCount} times)`);
    console.log(`     Source types: ${result.sourceTypes.join(', ')}`);
  });

  // Write records without warehouseId to a separate file
  if (recordsWithoutWarehouseId.length > 0) {
    const noWarehouseIdFile = path.join(migrationsDir, `records-without-warehouse-id-${timestamp}.json`);

    const noWarehouseIdOutput = {
      summary: {
        totalRecords: recordsWithoutWarehouseId.length,
        description: 'Records that do not have warehouseId field at any depth in sourceDocument',
      },
      records: recordsWithoutWarehouseId,
    };

    fs.writeFileSync(noWarehouseIdFile, JSON.stringify(noWarehouseIdOutput, null, 2));
    console.log(`\nRecords without warehouseId saved to: ${noWarehouseIdFile}`);
    console.log(`Total records without warehouseId: ${recordsWithoutWarehouseId.length}`);
  } else {
    console.log(`\nNo records found without warehouseId.`);
  }
}

// Run the analysis
analyzeWarehouseIdPaths();
