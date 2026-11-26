const httpStatus = require('http-status');
const mongoose = require('mongoose');
const ApiError = require('../../../utils/ApiError');
const { getBooksModels } = require('../../../services/model.service');
const { REJECTION_REASON_MESSAGES } = require('../../../utils/messages');
const { createSearchRegex } = require('../../../utils/regexUtils');

const createRejectionReason = async data => {
  const { RejectionReason } = getBooksModels();

  if (data.parentReasonId) {
    const parent = await RejectionReason.findOne({ _id: data.parentReasonId, companyId: data.companyId });
    if (!parent) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Parent rejection reason not found');
    }
  }

  try {
    const rejectionReason = await RejectionReason.create(data);
    return rejectionReason;
  } catch (error) {
    if (error?.code === 11000) {
      throw new ApiError(httpStatus.CONFLICT, 'A rejection reason with this name already exists.');
    }
    throw error;
  }
};

const getRejectionReasons = async (filter, options) => {
  const { RejectionReason } = getBooksModels();
  const { companyId, search, parentReasonId, isActive, ...rest } = filter;

  const query = { companyId, ...rest };

  if (typeof isActive !== 'undefined') {
    query.isActive = isActive;
  }

  if (parentReasonId) {
    query.parentReasonId = parentReasonId === '__ROOT__' ? null : parentReasonId;
  }

  if (search) {
    query.name = createSearchRegex(search.trim());
  }

  const result = await RejectionReason.paginate(query, { ...options, populate: 'parentReasonId' });
  return result;
};

const getRejectionReasonById = async (id, companyId) => {
  const { RejectionReason } = getBooksModels();
  const rejectionReason = await RejectionReason.findOne({ _id: id, companyId }).populate('parentReasonId', 'name');
  if (!rejectionReason) {
    throw new ApiError(httpStatus.NOT_FOUND, REJECTION_REASON_MESSAGES.FETCH_ONE_NOT_FOUND);
  }
  return rejectionReason;
};

const updateRejectionReasonById = async (id, updateBody, companyId) => {
  const { RejectionReason } = getBooksModels();
  const rejectionReason = await RejectionReason.findOne({ _id: id, companyId });
  if (!rejectionReason) {
    throw new ApiError(httpStatus.NOT_FOUND, REJECTION_REASON_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  if (updateBody.parentReasonId) {
    if (updateBody.parentReasonId === id) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'A rejection reason cannot be its own parent');
    }
    const parent = await RejectionReason.findOne({ _id: updateBody.parentReasonId, companyId });
    if (!parent) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Parent rejection reason not found');
    }

    // Walk the proposed parent's ancestor chain to catch multi-hop cycles (e.g. A -> B -> A).
    let ancestor = parent;
    while (ancestor?.parentReasonId) {
      if (ancestor.parentReasonId.toString() === id.toString()) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot set parent: this would create a circular reference');
      }
      ancestor = await RejectionReason.findOne({ _id: ancestor.parentReasonId, companyId });
    }
  }

  Object.assign(rejectionReason, updateBody);
  try {
    await rejectionReason.save();
  } catch (error) {
    if (error?.code === 11000) {
      throw new ApiError(httpStatus.CONFLICT, 'A rejection reason with this name already exists.');
    }
    throw error;
  }
  return rejectionReason;
};

const deleteRejectionReasonById = async (id, companyId) => {
  const { RejectionReason, RejectionOrder } = getBooksModels();
  const rejectionReason = await RejectionReason.findOne({ _id: id, companyId });
  if (!rejectionReason) {
    throw new ApiError(httpStatus.NOT_FOUND, REJECTION_REASON_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const childCount = await RejectionReason.countDocuments({ parentReasonId: id, companyId });
  if (childCount > 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, REJECTION_REASON_MESSAGES.DELETE_HAS_CHILDREN);
  }

  const usageCount = await RejectionOrder.countDocuments({
    companyId,
    'items.reasonAssignments.reason': new mongoose.Types.ObjectId(id),
  });
  if (usageCount > 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, REJECTION_REASON_MESSAGES.DELETE_IN_USE);
  }

  await rejectionReason.deleteOne();
  return rejectionReason;
};

module.exports = {
  createRejectionReason,
  getRejectionReasons,
  getRejectionReasonById,
  updateRejectionReasonById,
  deleteRejectionReasonById,
};
