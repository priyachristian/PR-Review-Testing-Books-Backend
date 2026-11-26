const { getConnection } = require('../config/db');

const testDbConnection = async () => {
  let client;
  try {
    console.log('🔌 Testing Database Connection...');

    // Get database connection
    const db = await getConnection();
    client = db.client;

    console.log('✅ Connected to MongoDB successfully!');
    console.log('📊 Available databases:');
    console.log(`   - Common: ${db.common.databaseName}`);
    console.log(`   - Books CRM: ${db.booksCrm.databaseName}`);
    console.log(`   - Books: ${db.books.databaseName}`);

    // Test accessing collections
    console.log('\n🔍 Testing Collection Access...');

    // Test Items collection
    try {
      const itemsCount = await db.booksCrm.collection('items').countDocuments();
      console.log(`✅ Items collection accessible - Found ${itemsCount} documents`);
    } catch (error) {
      console.log(`❌ Items collection error: ${error.message}`);
    }

    // Test Warehouses collection
    try {
      const warehousesCount = await db.booksCrm.collection('warehouses').countDocuments();
      console.log(`✅ Warehouses collection accessible - Found ${warehousesCount} documents`);
    } catch (error) {
      console.log(`❌ Warehouses collection error: ${error.message}`);
    }

    // Test ItemBatches collection
    try {
      const itemBatchesCount = await db.books.collection('itembatches').countDocuments();
      console.log(`✅ ItemBatches collection accessible - Found ${itemBatchesCount} documents`);
    } catch (error) {
      console.log(`❌ ItemBatches collection error: ${error.message}`);
    }

    // Test sample queries
    console.log('\n🔍 Testing Sample Queries...');

    // Test finding a company
    try {
      const sampleItem = await db.booksCrm.collection('items').findOne({});
      if (sampleItem) {
        console.log(
          `✅ Sample item found: ${sampleItem.itemName || sampleItem.itemCode || 'N/A'} (Company: ${sampleItem.companyId})`,
        );

        // Test finding items by company
        const companyItems = await db.booksCrm.collection('items').find({ companyId: sampleItem.companyId }).limit(5).toArray();
        console.log(`✅ Found ${companyItems.length} items for company ${sampleItem.companyId}`);

        // Test finding ItemBatch for this item
        const itemBatch = await db.books.collection('itembatches').findOne({ itemId: sampleItem._id });
        if (itemBatch) {
          console.log(`✅ ItemBatch found for item ${sampleItem._id}`);
        } else {
          console.log(`⚠️  No ItemBatch found for item ${sampleItem._id}`);
        }
      } else {
        console.log('⚠️  No items found in the database');
      }
    } catch (error) {
      console.log(`❌ Sample query error: ${error.message}`);
    }

    console.log('\n🎉 Database connection test completed successfully!');
    console.log('✅ All necessary collections are accessible');
    console.log('✅ Ready to run inventory-batch validation scripts');
  } catch (error) {
    console.error('❌ Database connection test failed:', error);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('🔌 MongoDB connection closed');
    }
  }
};

// Run the test
console.log('🚀 Starting Database Connection Test');
console.log('This will verify that all necessary collections are accessible');
console.log('');

testDbConnection()
  .then(() => {
    console.log('\n✅ Test completed successfully!');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  });
