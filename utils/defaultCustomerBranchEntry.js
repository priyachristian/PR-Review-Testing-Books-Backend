const mongoose = require('mongoose');
const { getBooksCrmModels } = require('../services/model.service');
const ApiError = require('./ApiError');
const httpStatus = require('http-status');

defaultBranchEntry = async (customerId, branchId, session) => {
  const { Customer, Branch, Division } = getBooksCrmModels();
  const branch = await Branch.findById(branchId);

  await Customer.updateOne(
    { _id: new mongoose.Types.ObjectId(customerId) },
    {
      $push: {
        branch: {
          branchId: new mongoose.Types.ObjectId(branchId),
          branchCode: branch.branchCode,
          openingBalance: 0,
          currentBalance: 0,
          divisionId: branch.divisionId,
        },
      },
    },
    { session },
  );
};

multipleDefaultBranchEntry = async (customerId, branchIds = [], session) => {
  const { Customer, Branch } = getBooksCrmModels();

  const objectBranchIds = branchIds.map(id => new mongoose.Types.ObjectId(id));

  // Fetch existing branchIds already present in customer's branch array
  const customer = await Customer.findOne({ _id: new mongoose.Types.ObjectId(customerId) }, { branch: 1 }).session(session);

  const existingBranchIds = customer?.branch?.map(b => b.branchId.toString()) || [];

  // Filter out already existing branchIds
  const newBranchIds = objectBranchIds.filter(id => !existingBranchIds.includes(id.toString()));

  if (newBranchIds.length === 0) return; // Nothing new to add

  // Fetch corresponding branch data for new branchIds
  const branches = await Branch.find({ _id: { $in: newBranchIds } }).session(session);

  if (branches.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No valid branches found for insertion.');
  }

  // Create array of new branch objects
  const branchesToPush = branches.map(branch => ({
    branchId: branch._id,
    branchCode: branch.branchCode,
    openingBalance: 0,
    currentBalance: 0,
    divisionId: branch.divisionId,
  }));

  // Push new branches in one update
  await Customer.updateOne(
    { _id: new mongoose.Types.ObjectId(customerId) },
    {
      $push: { branch: { $each: branchesToPush } },
    },
    { session },
  );
};

module.exports = {
  defaultBranchEntry,
  multipleDefaultBranchEntry,
};
