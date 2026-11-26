const httpStatus = require('http-status');
const mongoose = require('mongoose');
const { getAbssAdminModels, getCommonModels } = require('../../services/model.service');
const ApiError = require('../../utils/ApiError');
const { SUPPORT_MESSAGE } = require('../../utils/messages');
const { APP_NAME, SUPPORT_STATUS, SUPPORT_CATEGORY } = require('@smit9313/abss-models-core/src/utils/enum');
const { handleFileUpdate } = require('../commonModule/fileUpload/fileUploadS3.service');

const createSupport = async (body, userId, companyId, attachments) => {
  const { Support } = getAbssAdminModels();
  const { User } = getCommonModels();
  const user = await User.findById(userId);

  const uploadedUrls = await handleFileUpdate({
    newFiles: attachments,
    currentUrls: [],
    existingUrls: [],
    userId,
    companyId,
  });

  const category = body.category || SUPPORT_CATEGORY.BUG;

  return await Support.create({
    ...body,
    category,
    attachments: uploadedUrls,
    email: user?.email,
    appName: APP_NAME.BOOKS,
    status: SUPPORT_STATUS.RAISED,
    statusHistory: [
      {
        status: SUPPORT_STATUS.RAISED,
        changedBy: userId,
        reason: 'Ticket created',
        changedAt: new Date(),
      },
    ],
    companyId,
    userId,
  });
};

const querySupports = async (filter, options) => {
  const { Support } = getAbssAdminModels();
  const { User, Company } = getCommonModels();

  const query = { appName: APP_NAME.BOOKS };

  if (filter?.companyId) {
    const companyId = new mongoose.Types.ObjectId(filter.companyId);
    query.companyId = companyId;
  }
  if (filter.category) {
    const categoryArray = filter.category.split(',').filter(Boolean);
    if (categoryArray.length > 0) {
      query.category = { $in: categoryArray };
    }
  }
  if (filter.status) {
    const statusArray = filter.status.split(',').filter(Boolean);
    if (statusArray.length > 0) {
      query.status = { $in: statusArray };
    }
  }

  if (filter.priority) {
    const priorityArray = filter.priority.split(',').filter(Boolean);
    if (priorityArray.length > 0) {
      query.priority = { $in: priorityArray };
    }
  }

  if (filter.moduleName) {
    const moduleNameArray = filter.moduleName.split(',').filter(Boolean);
    if (moduleNameArray.length > 0) {
      query.moduleName = { $in: moduleNameArray };
    }
  }

  if (filter.raisedBy) {
    const userIdArray = filter.raisedBy.split(',').filter(Boolean);
    if (userIdArray.length > 0) {
      query.userId = { $in: userIdArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }

  if (filter.search && filter.search.trim()) {
    const searchTerm = filter.search.trim();
    const searchRegex = new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$and = query.$and || [];
    query.$and.push({
      $or: [{ supportId: searchRegex }, { bugTitle: searchRegex }],
    });
  }

  const baseCountQuery = { appName: APP_NAME.BOOKS };
  if (query.companyId) baseCountQuery.companyId = query.companyId;

  const [result, statusAgg] = await Promise.all([
    Support.paginate(query, options),
    Support.aggregate([{ $match: baseCountQuery }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);

  const statusMap = statusAgg.reduce((acc, { _id, count }) => {
    if (_id) acc[_id] = count;
    return acc;
  }, {});

  const users = await User.find({ _id: { $in: result.results.map(r => r.userId) } }, { firstName: 1, lastName: 1 });

  const companies = await Company.find({ _id: { $in: result.results.map(r => r.companyId) } }, { name: 1 });

  const userMap = Object.fromEntries(users.map(u => [u._id.toString(), u]));
  const companyMap = Object.fromEntries(companies.map(c => [c._id.toString(), c]));

  const response = result.results.map(support => ({
    ...support.toObject(),
    userName: `${userMap[support.userId?.toString()]?.firstName} ${userMap[support.userId?.toString()]?.lastName} ` || null,
    companyName: companyMap[support.companyId?.toString()]?.name || null,
  }));

  const statusCounts = {
    raised: statusMap[SUPPORT_STATUS.RAISED] || 0,
    requirementGathering: statusMap[SUPPORT_STATUS.REQUIREMENT_GATHERING] || 0,
    designing: statusMap[SUPPORT_STATUS.DESIGNING] || 0,
    productOwnerReview: statusMap[SUPPORT_STATUS.PRODUCT_OWNER_REVIEW] || 0,
    developmentHandover: statusMap[SUPPORT_STATUS.DEVELOPMENT_HANDOVER] || 0,
    developmentReview: statusMap[SUPPORT_STATUS.DEVELOPMENT_REVIEW] || 0,
    developmentWorkOngoing: statusMap[SUPPORT_STATUS.DEVELOPMENT_WORK_ONGOING] || 0,
    pmReview: statusMap[SUPPORT_STATUS.PM_REVIEW] || 0,
    clientTraining: statusMap[SUPPORT_STATUS.CLIENT_TRAINING] || 0,
    closed: statusMap[SUPPORT_STATUS.CLOSED] || 0,
  };

  return {
    ...result,
    results: response,
    statusCounts,
  };
};

const getSupportById = async (supportId, companyId) => {
  const { Support, User: AdminUser } = getAbssAdminModels();
  const { User, Company } = getCommonModels();

  const support = await Support.findOne({ _id: supportId, companyId: new mongoose.Types.ObjectId(companyId) });

  if (!support) {
    throw new ApiError(httpStatus.NOT_FOUND, SUPPORT_MESSAGE.FETCH_ONE_NOT_FOUND);
  }

  const [user, company] = await Promise.all([
    support.userId ? User.findById(support.userId, { firstName: 1, lastName: 1 }).lean() : null,
    Company.findById(support.companyId, { name: 1 }).lean(),
  ]);

  const portalUserIds = new Set();
  const userIds = new Set();

  for (const c of support.commentHistory) {
    if (c.userType === 'PORTAL_USER' && c.userId) {
      portalUserIds.add(c.userId.toString());
    }

    if (c.userType === 'USER' && c.userId) {
      userIds.add(c.userId.toString());
    }
  }

  const [adminUsers, users] = await Promise.all([
    AdminUser.find({ _id: { $in: [...portalUserIds] } }, { firstName: 1, lastName: 1 }),
    User.find({ _id: { $in: [...userIds] } }, { firstName: 1, lastName: 1 }),
  ]);

  const adminUserMap = new Map(adminUsers.map(u => [u._id.toString(), `${u.firstName} ${u.lastName}`]));

  const userMap = new Map(users.map(u => [u._id.toString(), `${u.firstName} ${u.lastName}`]));

  let lastPortalUserName = null;

  const formattedComments = support.commentHistory.map(comment => {
    let name = 'System';

    if (comment.userType === 'PORTAL_USER') {
      name = adminUserMap.get(comment.userId?.toString()) || 'Admin';
      lastPortalUserName = name;
    }

    if (comment.userType === 'USER') {
      name = userMap.get(comment.userId?.toString()) || 'User';
    }

    if (comment.userType === 'SYSTEM') {
      name = lastPortalUserName || 'System';
    }

    return {
      ...comment.toObject(),
      name,
    };
  });

  return {
    ...support.toObject(),
    userName: `${user?.firstName} ${user.lastName}` || null,
    companyName: company?.name || null,
    commentHistory: formattedComments,
  };
};

const updateSupportById = async (supportId, companyId, updateBody, userId) => {
  const { Support } = getAbssAdminModels();

  const support = await Support.findOne({
    _id: supportId,
    companyId: new mongoose.Types.ObjectId(companyId),
  });

  if (!support) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Support not found');
  }

  const updateData = { ...updateBody };
  const updateQuery = { $set: {} };

  delete updateData.reason;

  if (updateBody.status && updateBody.status !== support.status) {
    updateQuery.$set.status = updateBody.status;

    updateQuery.$push = {
      statusHistory: {
        status: updateBody.status,
        changedBy: userId,
        reason: updateBody.reason || 'Status updated',
      },
    };
  }

  Object.assign(updateQuery.$set, updateData);

  return await Support.findByIdAndUpdate(supportId, updateQuery, {
    new: true,
  });
};

const addCommentToSupport = async (supportId, companyId, commentData, userId) => {
  const { Support } = getAbssAdminModels();

  const support = await Support.findOne({
    _id: supportId,
    companyId: new mongoose.Types.ObjectId(companyId),
  });

  if (!support) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Support not found');
  }

  const comment = {
    userType: commentData.userType || 'USER',
    userId: commentData.userType === 'SYSTEM' ? undefined : userId,
    description: commentData.description,
    commentTime: new Date(),
    attachments: commentData.attachments || [],
  };

  const updatedSupport = await Support.findByIdAndUpdate(
    supportId,
    {
      $push: {
        commentHistory: comment,
      },
    },
    {
      new: true,
    },
  );

  return updatedSupport;
};

const updateSupportStatus = async (supportId, companyId, statusData) => {
  const { Support } = getAbssAdminModels();

  const support = await Support.findOne({
    _id: supportId,
    companyId: new mongoose.Types.ObjectId(companyId),
  });

  if (!support) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Support not found');
  }

  return await Support.findByIdAndUpdate(supportId, {
    $set: {
      isUserTested: statusData.isUserTested,
    },
  });
};
module.exports = {
  createSupport,
  querySupports,
  getSupportById,
  updateSupportById,
  addCommentToSupport,
  updateSupportStatus,
};
