const httpStatus = require('http-status');
const mongoose = require('mongoose');
const isEqual = require('lodash/isEqual');
const { getBooksCrmModels, getClientConnection, getCommonModels, getBooksModels } = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');
const { createSearchRegex } = require('../../../utils/regexUtils');

const toObjectId = id => (id ? new mongoose.Types.ObjectId(id) : null);

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

// ─── Earn calculation ────────────────────────────────────────────────────────

const computeEarned = async (docTypeConfig, docAmount, items = []) => {
  const { Item } = getBooksCrmModels();
  const { calcMethod, incentiveType, incentiveValue } = docTypeConfig;

  if (calcMethod === 'PER_DOC_AMOUNT') {
    if (incentiveType === 'PERCENTAGE') return round2((docAmount * incentiveValue) / 100);
    return round2(incentiveValue);
  }

  if (calcMethod === 'PER_ITEM') {
    if (!items.length) return 0;

    const selectedItemIds = new Set((docTypeConfig.items || []).map(id => id.toString()));
    const matchedItems = items.filter(item => selectedItemIds.has(item.itemId?.toString()));
    if (!matchedItems.length) return 0;

    const totalAmount = matchedItems.reduce((acc, item) => acc + parseFloat(item.amount || 0), 0);
    const totalQty = matchedItems.reduce((acc, item) => acc + Number(item.quantity || 0), 0);

    if (incentiveType === 'PERCENTAGE') {
      return round2((totalAmount * incentiveValue) / 100);
    }

    return round2(incentiveValue * totalQty);
  }

  if (calcMethod === 'PER_ITEM_GROUP') {
    if (!items.length) return 0;

    const itemMasters = await Item.find({
      _id: { $in: items.map(item => item.itemId) },
    })
      .select('_id itemGroup')
      .lean();

    const itemGroupMap = new Map(itemMasters.map(item => [item._id.toString(), item.itemGroup?.toString()]));

    const selectedGroupIds = new Set((docTypeConfig.itemGroups || []).map(id => id.toString()));

    let totalAmount = 0;
    let totalQty = 0;

    for (const item of items) {
      const groupId = itemGroupMap.get(item.itemId?.toString());

      if (!groupId || !selectedGroupIds.has(groupId)) continue;

      totalAmount += Number(item.amount || 0);
      totalQty += Number(item.quantity || 0);
    }

    if (incentiveType === 'PERCENTAGE') {
      return round2((totalAmount * incentiveValue) / 100);
    }

    return round2(incentiveValue * totalQty);
  }

  return 0;
};

// ─── Lifecycle hooks (cancel / sync) ────────────────────────────────────────

// Call after a document is cancelled or deleted — voids any PENDING log
const cancelIncentiveLog = async docIds => {
  try {
    const { IncentiveLog } = getBooksCrmModels();
    const ids = (Array.isArray(docIds) ? docIds : [docIds]).map(id => toObjectId(id));
    await IncentiveLog.updateMany({ docId: { $in: ids }, status: 'PENDING' }, { status: 'CANCELLED' });
  } catch (err) {
    console.error('[IncentiveCancel] error:', err.message);
  }
};

// ─── Core earn hook (called from doc services after successful save) ─────────

const processIncentiveEarn = async (companyId, userId, docType, docId, docAmount, items = []) => {
  try {
    const { IncentiveScheme, IncentiveLog } = getBooksCrmModels();
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const schemes = await IncentiveScheme.find({
      companyId: toObjectId(companyId),
      status: 'ACTIVE',
      startDate: { $lte: now },
      endDate: { $gte: startOfToday },
      assignedUsers: toObjectId(userId),
      'docTypes.docType': docType,
    }).lean();

    if (!schemes.length) return;

    for (const scheme of schemes) {
      const docTypeConfig = scheme.docTypes.find(d => d.docType === docType);
      if (!docTypeConfig) continue;

      const earnedAmount = await computeEarned(docTypeConfig, docAmount, items);
      if (earnedAmount <= 0) continue;

      // Check if a log already exists for this scheme+doc (schemeId+docId is unique, so any
      // status — not just PENDING — must be looked up to avoid a duplicate-key error below).
      const existingLog = await IncentiveLog.findOne({
        schemeId: scheme._id,
        docId: toObjectId(docId),
      }).lean();

      // Already settled/paid out — don't recompute or touch it.
      if (existingLog?.status === 'SETTLED') continue;

      // Always keep the original incentive owner.
      // If another user updates the document, recalculate the incentive
      // but do not change the user who earned it.
      const incentiveUserId = existingLog?.userId || toObjectId(userId);

      // CANCELLED logs are excluded from the consumption aggregates below, so they
      // don't contribute to existingEarned even though a row exists for this doc.
      const existingEarned = existingLog?.status === 'PENDING' ? existingLog.earnedAmount || 0 : 0;

      const totalConsumed = await getConsumedAmount(IncentiveLog, {
        schemeId: scheme._id,
      });

      // Don't exceed total budget
      let finalEarned = earnedAmount;
      if (scheme.totalBudget > 0) {
        const remainingBudget = scheme.totalBudget - (totalConsumed - existingEarned);
        if (remainingBudget <= 0) {
          continue;
        }
        finalEarned = Math.min(finalEarned, remainingBudget);
      }

      // Emit alert when consumption crosses the alert threshold (does not block earning)
      if (scheme.totalBudget > 0 && scheme.alertThreshold > 0) {
        const thresholdAmount = (scheme.totalBudget * scheme.alertThreshold) / 100;
        if (totalConsumed - existingEarned + finalEarned >= thresholdAmount) {
          console.warn(`[IncentiveAlert] Scheme ${scheme._id} has reached ${scheme.alertThreshold}% of its total budget.`);
        }
      }

      // Check per-docType budget remaining
      const consumed = await getConsumedAmount(IncentiveLog, {
        schemeId: scheme._id,
        docType,
      });
      if (docTypeConfig.allocatedBudget > 0) {
        const remainingDocBudget = docTypeConfig.allocatedBudget - (consumed - existingEarned);
        if (remainingDocBudget <= 0) {
          continue;
        }
        finalEarned = Math.min(finalEarned, remainingDocBudget);
      }

      // Check per-user cap
      if (scheme.perUserBudgetCap > 0) {
        const userConsumed = await getConsumedAmount(IncentiveLog, {
          schemeId: scheme._id,
          userId: incentiveUserId,
        });
        const remainingUserBudget = scheme.perUserBudgetCap - (userConsumed - existingEarned);
        if (remainingUserBudget <= 0) {
          continue;
        }
        finalEarned = Math.min(finalEarned, remainingUserBudget);
      }

      if (existingLog) {
        await IncentiveLog.updateOne(
          { _id: existingLog._id },
          {
            $set: {
              docAmount,
              earnedAmount: finalEarned,
              status: 'PENDING',
            },
          },
        );
      } else {
        await IncentiveLog.create({
          companyId: toObjectId(companyId),
          schemeId: scheme._id,
          userId: incentiveUserId,
          docType,
          docId: toObjectId(docId),
          docAmount,
          earnedAmount: finalEarned,
          status: 'PENDING',
        });
      }
    }
  } catch (err) {
    // Never block the main doc save — just log
    console.error('[IncentiveEarn] error:', err.message);
  }
};

// ─── CRUD ────────────────────────────────────────────────────────────────────

const createIncentiveScheme = async body => {
  const { IncentiveScheme } = getBooksCrmModels();
  const connection = await getClientConnection();
  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const scheme = await IncentiveScheme.create([body], { session });
    await session.commitTransaction();
    return scheme[0];
  } catch (err) {
    if (session.inTransaction()) await session.abortTransaction();
    throw err;
  } finally {
    await session.endSession();
  }
};

const queryIncentiveSchemes = async (query, filter, options) => {
  const { IncentiveScheme, IncentiveLog } = getBooksCrmModels();

  if (query.search) {
    filter.$or = [{ name: createSearchRegex(query.search.trim()) }];
  }
  if (query.status) filter.status = query.status;
  if (query.userId) filter.assignedUsers = toObjectId(query.userId);

  const result = await IncentiveScheme.paginate(filter, {
    ...options,
    sort: { createdAt: -1 },
  });

  // Attach per-docType and total consumed per scheme
  const schemeIds = result.results.map(s => s._id);
  const consumedAgg = await IncentiveLog.aggregate([
    { $match: { schemeId: { $in: schemeIds }, status: { $ne: 'CANCELLED' } } },
    { $group: { _id: { schemeId: '$schemeId', docType: '$docType' }, consumed: { $sum: '$earnedAmount' } } },
  ]);

  const consumedByDocMap = {};
  consumedAgg.forEach(a => {
    const sid = a._id.schemeId.toString();
    if (!consumedByDocMap[sid]) consumedByDocMap[sid] = {};
    consumedByDocMap[sid][a._id.docType] = a.consumed;
  });

  result.results = result.results.map(s => {
    const byDocType = consumedByDocMap[s._id.toString()] || {};
    const totalConsumed = Object.values(byDocType).reduce((sum, v) => sum + v, 0);
    return {
      ...s.toObject(),
      consumedByDocType: byDocType,
      totalConsumed,
    };
  });

  return result;
};

const getIncentiveSchemeById = async (schemeId, companyId) => {
  const { IncentiveScheme, IncentiveLog } = getBooksCrmModels();
  const { User } = getCommonModels();
  const scheme = await IncentiveScheme.findOne({ _id: toObjectId(schemeId), companyId: toObjectId(companyId) }).lean();
  if (!scheme) throw new ApiError(httpStatus.NOT_FOUND, 'Incentive scheme not found');

  // Per-docType consumed
  const consumedAgg = await IncentiveLog.aggregate([
    { $match: { schemeId: toObjectId(schemeId), status: { $ne: 'CANCELLED' } } },
    { $group: { _id: '$docType', consumed: { $sum: '$earnedAmount' } } },
  ]);
  const consumedByDoc = Object.fromEntries(consumedAgg.map(a => [a._id, a.consumed]));

  scheme.docTypes = scheme.docTypes.map(d => ({ ...d, consumed: consumedByDoc[d.docType] || 0 }));
  scheme.totalConsumed = Object.values(consumedByDoc).reduce((a, b) => a + b, 0);
  scheme.totalRemaining = scheme.totalBudget - scheme.totalConsumed;

  if (scheme.assignedUsers?.length) {
    const users = await User.find({ _id: { $in: scheme.assignedUsers } }, 'firstName lastName email').lean();

    const userMap = Object.fromEntries(
      users.map(user => [
        user._id.toString(),
        {
          _id: user._id,
          name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
          email: user.email,
        },
      ]),
    );

    scheme.assignedUsers = scheme.assignedUsers.map(id => userMap[id.toString()]).filter(Boolean);
  }

  return scheme;
};

const updateIncentiveSchemeById = async (schemeId, companyId, updateBody) => {
  const { IncentiveScheme, IncentiveLog } = getBooksCrmModels();

  const schemeIdObj = toObjectId(schemeId);
  const companyIdObj = toObjectId(companyId);

  // Scope by companyId so a caller cannot read/update another company's scheme by id
  // (consistent with getIncentiveSchemeById / updateSchemeStatus / deleteIncentiveSchemeById).
  const scheme = await IncentiveScheme.findOne({ _id: schemeIdObj, companyId: companyIdObj });

  if (!scheme) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Incentive scheme not found');
  }

  const hasAnyLogs = await IncentiveLog.exists({
    schemeId: schemeIdObj,
    companyId: companyIdObj,
  });

  if (updateBody.docTypes?.length) {
    for (const updatedDoc of updateBody.docTypes) {
      const existingDoc = scheme.docTypes.find(d => d.docType === updatedDoc.docType);

      if (!existingDoc) continue;

      const hasDocLogs = await IncentiveLog.exists({
        schemeId: schemeIdObj,
        companyId: companyIdObj,
        docType: updatedDoc.docType,
      });

      if (!hasDocLogs) continue;

      // Validate allocated budget only if changed
      const consumedBudget = await getConsumedAmount(IncentiveLog, {
        schemeId: schemeIdObj,
        companyId: companyIdObj,
        docType: updatedDoc.docType,
      });

      validateBudgetUpdate({
        currentBudget: existingDoc.allocatedBudget,
        newBudget: updatedDoc.allocatedBudget,
        consumedBudget,
        budgetName: `${updatedDoc.docType} allocated budget`,
      });

      const existing = {
        calcMethod: existingDoc.calcMethod,
        incentiveType: existingDoc.incentiveType,
        incentiveValue: existingDoc.incentiveValue,
        itemGroups: [...(existingDoc.itemGroups || [])].map(String).sort(),
        items: [...(existingDoc.items || [])].map(String).sort(),
      };

      const incoming = {
        calcMethod: updatedDoc.calcMethod,
        incentiveType: updatedDoc.incentiveType,
        incentiveValue: updatedDoc.incentiveValue,
        itemGroups: [...(updatedDoc.itemGroups || [])].map(String).sort(),
        items: [...(updatedDoc.items || [])].map(String).sort(),
      };

      if (!isEqual(existing, incoming)) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `${updatedDoc.docType} cannot be updated because incentive logs already exist.`,
        );
      }
    }
  }

  if (updateBody.assignedUsers) {
    const existingUsers = (scheme.assignedUsers || []).map(String);
    const updatedUsers = updateBody.assignedUsers.map(String);

    // Users removed from the scheme
    const removedUsers = existingUsers.filter(userId => !updatedUsers.includes(userId));

    for (const userId of removedUsers) {
      const hasLogs = await IncentiveLog.exists({
        schemeId: scheme._id,
        companyId: toObjectId(companyId),
        userId: toObjectId(userId),
      });

      if (hasLogs) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          'Cannot remove assigned user because incentive logs already exist for this user.',
        );
      }
    }
  }

  if (hasAnyLogs) {
    const consumed = await getConsumedAmount(IncentiveLog, {
      schemeId: schemeIdObj,
      companyId: companyIdObj,
    });

    validateBudgetUpdate({
      currentBudget: scheme.totalBudget,
      newBudget: updateBody.totalBudget,
      consumedBudget: consumed,
      budgetName: 'Total budget',
    });
  }

  if (hasAnyLogs) {
    const maxConsumed = await getMaxUserConsumed(IncentiveLog, schemeIdObj, companyIdObj);

    // Don't allow removing the cap once it has been utilized
    if (scheme.perUserBudgetCap !== null && updateBody.perUserBudgetCap === null && maxConsumed > 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Per user budget cap cannot be removed because it has already been utilized.');
    }

    validateBudgetUpdate({
      currentBudget: scheme.perUserBudgetCap,
      newBudget: updateBody.perUserBudgetCap,
      consumedBudget: maxConsumed,
      budgetName: 'Per user budget cap',
    });
  }

  const updatedScheme = await IncentiveScheme.findByIdAndUpdate(schemeIdObj, updateBody, {
    new: true,
    runValidators: true,
  });

  return updatedScheme;
};

const updateSchemeStatus = async (schemeId, companyId, status) => {
  const { IncentiveScheme } = getBooksCrmModels();
  const scheme = await IncentiveScheme.findOneAndUpdate(
    { _id: toObjectId(schemeId), companyId: toObjectId(companyId) },
    { status },
    { new: true },
  );
  if (!scheme) throw new ApiError(httpStatus.NOT_FOUND, 'Incentive scheme not found');
  return scheme;
};

const deleteIncentiveSchemeById = async (schemeId, companyId) => {
  const { IncentiveScheme, IncentiveLog } = getBooksCrmModels();
  const scheme = await IncentiveScheme.findOne({ _id: toObjectId(schemeId), companyId: toObjectId(companyId) });
  if (!scheme) throw new ApiError(httpStatus.NOT_FOUND, 'Incentive scheme not found');

  const activeLogCount = await IncentiveLog.countDocuments({
    schemeId: toObjectId(schemeId),
    companyId: toObjectId(companyId),
    status: { $ne: 'CANCELLED' },
  });

  if (activeLogCount > 0) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Cannot delete: ${activeLogCount} activity log(s) exist for this scheme. Cancel or remove all logs first.`,
    );
  }

  await scheme.deleteOne();
};

// ─── Consumption & summary ───────────────────────────────────────────────────

const getSchemeConsumption = async (schemeId, companyId) => {
  const { IncentiveLog, IncentiveScheme } = getBooksCrmModels();
  const { User } = getCommonModels();

  const scheme = await IncentiveScheme.findOne({
    _id: toObjectId(schemeId),
    companyId: toObjectId(companyId),
  }).lean();

  if (!scheme) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Incentive scheme not found');
  }

  const [byDocType, byUser] = await Promise.all([
    IncentiveLog.aggregate([
      { $match: { schemeId: toObjectId(schemeId), status: { $ne: 'CANCELLED' } } },
      { $group: { _id: '$docType', consumed: { $sum: '$earnedAmount' }, count: { $sum: 1 } } },
    ]),
    IncentiveLog.aggregate([
      { $match: { schemeId: toObjectId(schemeId), status: { $ne: 'CANCELLED' } } },
      {
        $group: {
          _id: '$userId',
          earned: { $sum: '$earnedAmount' },
          settled: { $sum: { $cond: [{ $eq: ['$status', 'SETTLED'] }, '$earnedAmount', 0] } },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const allocationMap = Object.fromEntries(scheme.docTypes.map(doc => [doc.docType, doc.allocatedBudget || 0]));

  const byDocTypeWithBudget = byDocType.map(doc => ({
    ...doc,
    allocatedBudget: allocationMap[doc._id] || 0,
  }));

  // Populate user names from common connection
  const userIds = byUser.map(u => u._id).filter(Boolean);
  const users = await User.find({ _id: { $in: userIds } }, 'firstName lastName email').lean();
  const userMap = Object.fromEntries(users.map(u => [u._id.toString(), u]));

  const byUserWithNames = byUser.map(u => {
    const info = userMap[u._id?.toString()];
    const name = info ? [info.firstName, info.lastName].filter(Boolean).join(' ') || info.email : u._id?.toString();
    return {
      ...u,
      name,
      pending: u.earned - u.settled,
    };
  });

  return { byDocType: byDocTypeWithBudget, byUser: byUserWithNames };
};

const getSchemeSummary = async companyId => {
  const { IncentiveScheme, IncentiveLog } = getBooksCrmModels();

  const [schemes, consumedAgg] = await Promise.all([
    IncentiveScheme.find({ companyId: toObjectId(companyId) })
      .select('totalBudget status')
      .lean(),
    IncentiveLog.aggregate([
      { $match: { companyId: toObjectId(companyId), status: { $ne: 'CANCELLED' } } },
      {
        $group: {
          _id: null,
          totalConsumed: { $sum: '$earnedAmount' },
          totalSettled: { $sum: { $cond: [{ $eq: ['$status', 'SETTLED'] }, '$earnedAmount', 0] } },
        },
      },
    ]),
  ]);

  const totalBudget = schemes.reduce((a, s) => a + (s.totalBudget || 0), 0);
  const activeSchemes = schemes.filter(s => s.status === 'ACTIVE').length;
  const totalConsumed = consumedAgg[0]?.totalConsumed || 0;
  const totalSettled = consumedAgg[0]?.totalSettled || 0;

  return { totalBudget, totalConsumed, totalSettled, totalPending: totalConsumed - totalSettled, activeSchemes };
};

// ─── Incentive Log ───────────────────────────────────────────────────────────

const queryIncentiveLogs = async (query, filter, options) => {
  const { IncentiveLog, Quote, SalesOrder, PaymentReceived } = getBooksCrmModels();
  const { Invoice, DeliveryChallan } = getBooksModels();
  const { User } = getCommonModels();

  if (query.schemeId) filter.schemeId = toObjectId(query.schemeId);
  if (query.userId) filter.userId = toObjectId(query.userId);
  if (query.docType) filter.docType = query.docType;
  if (query.status) filter.status = query.status;

  // schemeId is in the same booksCrm connection — use plugin populate
  // userId is in the common connection — must be populated manually
  const result = await IncentiveLog.paginate(filter, {
    ...options,
    sort: { createdAt: -1 },
    populate: 'schemeId:name',
  });

  const userIds = [...new Set(result.results.map(l => l.userId?.toString()).filter(Boolean))];
  const users = await User.find({ _id: { $in: userIds } }, 'firstName lastName email').lean();
  const userMap = Object.fromEntries(users.map(u => [u._id.toString(), u]));

  const modelMap = {
    INVOICE: {
      model: Invoice,
      numberField: 'invoiceId',
    },
    SALES_ORDER: {
      model: SalesOrder,
      numberField: 'orderId',
    },
    QUOTATION: {
      model: Quote,
      numberField: 'quoteId',
    },
    DELIVERY_CHALLAN: {
      model: DeliveryChallan,
      numberField: 'challanId',
    },
    PAYMENT_RECEIVED: {
      model: PaymentReceived,
      numberField: 'paymentReceivedId',
    },
  };

  const docMap = {};

  for (const [docType, Model] of Object.entries(modelMap)) {
    const ids = [...new Set(result.results.filter(l => l.docType === docType && l.docId).map(l => l.docId.toString()))];

    if (!ids.length) continue;

    const docs = await Model.model.find({ _id: { $in: ids } }, `_id ${Model.numberField}`).lean();

    docs.forEach(doc => {
      docMap[doc._id.toString()] = {
        _id: doc._id,
        number: doc[Model.numberField],
      };
    });
  }

  result.results = result.results.map(l => ({
    ...l.toObject(),
    userId: userMap[l.userId?.toString()] || null,
    docId: docMap[l.docId?.toString()] || null,
  }));

  return result;
};

const updateLogStatus = async (logId, companyId, status, settledBy) => {
  const { IncentiveLog } = getBooksCrmModels();
  const update = { status };
  if (status === 'SETTLED') {
    update.settledAt = new Date();
    update.settledBy = toObjectId(settledBy);
  }
  const log = await IncentiveLog.findOneAndUpdate({ _id: toObjectId(logId), companyId: toObjectId(companyId) }, update, {
    new: true,
  });
  if (!log) throw new ApiError(httpStatus.NOT_FOUND, 'Incentive log not found');
  return log;
};

const deleteIncentiveLog = async (logId, companyId) => {
  const { IncentiveLog } = getBooksCrmModels();
  const log = await IncentiveLog.findOne({ _id: toObjectId(logId), companyId: toObjectId(companyId) });
  if (!log) throw new ApiError(httpStatus.NOT_FOUND, 'Incentive log not found');
  if (log.status === 'SETTLED') throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot delete a settled incentive log');
  await IncentiveLog.deleteOne({ _id: toObjectId(logId) });
};

const bulkSettleLogs = async (schemeId, userId, companyId, settledBy) => {
  const { IncentiveLog } = getBooksCrmModels();
  const filter = {
    companyId: toObjectId(companyId),
    schemeId: toObjectId(schemeId),
    status: 'PENDING',
  };
  if (userId) filter.userId = toObjectId(userId);

  await IncentiveLog.updateMany(filter, {
    status: 'SETTLED',
    settledAt: new Date(),
    settledBy: toObjectId(settledBy),
  });
};

const getUserIncentiveSchemes = async (userId, companyId) => {
  const { IncentiveLog, IncentiveScheme } = getBooksCrmModels();
  const { User } = getCommonModels();

  const user = await User.findById(userId, 'firstName lastName email').lean();

  const schemes = await IncentiveLog.aggregate([
    {
      $match: {
        companyId: toObjectId(companyId),
        userId: toObjectId(userId),
        status: { $ne: 'CANCELLED' },
      },
    },
    {
      $lookup: {
        from: 'incentiveschemes',
        localField: 'schemeId',
        foreignField: '_id',
        as: 'scheme',
      },
    },
    { $unwind: '$scheme' },
    {
      $group: {
        _id: '$schemeId',
        schemeName: { $first: '$scheme.name' },
        totalEarned: { $sum: '$earnedAmount' },
        totalSettled: {
          $sum: {
            $cond: [{ $eq: ['$status', 'SETTLED'] }, '$earnedAmount', 0],
          },
        },
        totalPending: {
          $sum: {
            $cond: [{ $eq: ['$status', 'PENDING'] }, '$earnedAmount', 0],
          },
        },
        totalDocuments: { $sum: 1 },
        docSummary: {
          $push: {
            docType: '$docType',
            earnedAmount: '$earnedAmount',
          },
        },
      },
    },
    {
      $project: {
        schemeName: 1,
        totalEarned: 1,
        totalSettled: 1,
        totalPending: 1,
        totalDocuments: 1,
        documentTypeSummary: {
          $map: {
            input: ['INVOICE', 'SALES_ORDER', 'QUOTATION', 'DELIVERY_CHALLAN', 'PAYMENT_RECEIVED'],
            as: 'type',
            in: {
              docType: '$$type',
              count: {
                $size: {
                  $filter: {
                    input: '$docSummary',
                    as: 'd',
                    cond: { $eq: ['$$d.docType', '$$type'] },
                  },
                },
              },
              earnedAmount: {
                $sum: {
                  $map: {
                    input: {
                      $filter: {
                        input: '$docSummary',
                        as: 'd',
                        cond: { $eq: ['$$d.docType', '$$type'] },
                      },
                    },
                    as: 'd',
                    in: '$$d.earnedAmount',
                  },
                },
              },
            },
          },
        },
      },
    },
  ]);

  return {
    user: user
      ? {
          _id: user._id,
          name: `${user.firstName} ${user.lastName}`.trim(),
          email: user.email,
        }
      : null,
    totalSchemes: schemes.length,
    totalEarned: schemes.reduce((t, s) => t + s.totalEarned, 0),
    totalSettled: schemes.reduce((t, s) => t + s.totalSettled, 0),
    totalPending: schemes.reduce((t, s) => t + s.totalPending, 0),
    schemes,
  };
};

const getTeamStats = async companyId => {
  const { IncentiveLog, IncentiveScheme } = getBooksCrmModels();
  const { User } = getCommonModels();

  const userAgg = await IncentiveLog.aggregate([
    { $match: { companyId: toObjectId(companyId), status: { $ne: 'CANCELLED' } } },
    {
      $group: {
        _id: '$userId',
        totalEarned: { $sum: '$earnedAmount' },
        totalSettled: { $sum: { $cond: [{ $eq: ['$status', 'SETTLED'] }, '$earnedAmount', 0] } },
        totalPending: { $sum: { $cond: [{ $eq: ['$status', 'PENDING'] }, '$earnedAmount', 0] } },
        schemeIds: { $addToSet: '$schemeId' },
      },
    },
  ]);

  if (!userAgg.length) return { members: [], totalMembers: 0, totalEarned: 0, totalSettled: 0, totalPending: 0 };

  const allSchemeIds = [...new Set(userAgg.flatMap(u => u.schemeIds.map(s => s.toString())))];
  const activeSchemes = await IncentiveScheme.find(
    { _id: { $in: allSchemeIds }, status: 'ACTIVE', companyId: toObjectId(companyId) },
    '_id',
  ).lean();
  const activeSchemeSet = new Set(activeSchemes.map(s => s._id.toString()));

  const userIds = userAgg.map(u => u._id).filter(Boolean);
  const users = await User.find({ _id: { $in: userIds } }, 'firstName lastName email').lean();
  const userMap = Object.fromEntries(users.map(u => [u._id.toString(), u]));

  const members = userAgg
    .map(u => {
      const info = userMap[u._id?.toString()];
      const name = info ? [info.firstName, info.lastName].filter(Boolean).join(' ') || info.email : u._id?.toString();
      const activeCount = u.schemeIds.filter(s => activeSchemeSet.has(s.toString())).length;
      return {
        _id: u._id,
        name,
        email: info?.email || '',
        totalEarned: u.totalEarned,
        totalSettled: u.totalSettled,
        totalPending: u.totalPending,
        activeSchemes: activeCount,
      };
    })
    .sort((a, b) => b.totalEarned - a.totalEarned);

  return {
    members,
    totalMembers: members.length,
    totalEarned: members.reduce((s, m) => s + m.totalEarned, 0),
    totalSettled: members.reduce((s, m) => s + m.totalSettled, 0),
    totalPending: members.reduce((s, m) => s + m.totalPending, 0),
  };
};

const getUserStatsDetail = async (companyId, userId) => {
  const { IncentiveLog, IncentiveScheme } = getBooksCrmModels();
  const { User } = getCommonModels();

  const emptyResponse = {
    _id: userId,
    name: '',
    email: '',
    totalEarned: 0,
    totalSettled: 0,
    totalPending: 0,
    activeSchemes: 0,
    schemes: [],
  };

  // Group logs by scheme to get per-scheme earned/settled/pending
  const schemeAgg = await IncentiveLog.aggregate([
    { $match: { companyId: toObjectId(companyId), userId: toObjectId(userId), status: { $ne: 'CANCELLED' } } },
    {
      $group: {
        _id: '$schemeId',
        totalEarned: { $sum: '$earnedAmount' },
        totalSettled: { $sum: { $cond: [{ $eq: ['$status', 'SETTLED'] }, '$earnedAmount', 0] } },
        totalPending: { $sum: { $cond: [{ $eq: ['$status', 'PENDING'] }, '$earnedAmount', 0] } },
      },
    },
  ]);

  if (!schemeAgg.length) return emptyResponse;

  const schemeIds = schemeAgg.map(s => s._id);

  const [schemeDetails, info] = await Promise.all([
    IncentiveScheme.find(
      { _id: { $in: schemeIds }, companyId: toObjectId(companyId) },
      'name status startDate endDate totalBudget perUserBudgetCap',
    ).lean(),
    User.findById(userId, 'firstName lastName email').lean(),
  ]);

  const schemeMap = Object.fromEntries(schemeDetails.map(s => [s._id.toString(), s]));
  const name = info ? [info.firstName, info.lastName].filter(Boolean).join(' ') || info.email : userId;

  const schemes = schemeAgg.map(s => {
    const detail = schemeMap[s._id?.toString()] || {};
    return {
      _id: s._id,
      name: detail.name || '',
      status: detail.status || '',
      startDate: detail.startDate || null,
      endDate: detail.endDate || null,
      totalBudget: detail.totalBudget ?? 0,
      perUserBudgetCap: detail.perUserBudgetCap ?? null,
      totalEarned: s.totalEarned,
      totalSettled: s.totalSettled,
      totalPending: s.totalPending,
    };
  });

  return {
    _id: toObjectId(userId),
    name,
    email: info?.email || '',
    totalEarned: schemes.reduce((sum, s) => sum + s.totalEarned, 0),
    totalSettled: schemes.reduce((sum, s) => sum + s.totalSettled, 0),
    totalPending: schemes.reduce((sum, s) => sum + s.totalPending, 0),
    activeSchemes: schemes.filter(s => s.status === 'ACTIVE').length,
    schemes,
  };
};

const getConsumedAmount = async (IncentiveLog, match) => {
  const result = await IncentiveLog.aggregate([
    {
      $match: {
        ...match,
        status: { $ne: 'CANCELLED' },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$earnedAmount' },
      },
    },
  ]);

  return result[0]?.total || 0;
};

const getMaxUserConsumed = async (IncentiveLog, schemeId, companyId) => {
  const result = await IncentiveLog.aggregate([
    {
      $match: {
        schemeId,
        companyId,
        status: { $ne: 'CANCELLED' },
      },
    },
    {
      $group: {
        _id: '$userId',
        total: { $sum: '$earnedAmount' },
      },
    },
    {
      $group: {
        _id: null,
        maxConsumed: { $max: '$total' },
      },
    },
  ]);

  return result[0]?.maxConsumed || 0;
};

const validateBudgetUpdate = ({ currentBudget, newBudget, consumedBudget, budgetName }) => {
  if (newBudget === undefined || newBudget === null || newBudget === currentBudget) {
    return;
  }

  // Only block reducing a budget/cap below what's already been consumed. Increasing an exhausted
  // budget, or adding a budget/cap to a previously-uncapped (0/null) scheme, is allowed.
  if (newBudget < consumedBudget) {
    throw new ApiError(httpStatus.BAD_REQUEST, `${budgetName} cannot be less than consumed budget (${consumedBudget}).`);
  }
};

module.exports = {
  processIncentiveEarn,
  cancelIncentiveLog,
  createIncentiveScheme,
  queryIncentiveSchemes,
  getIncentiveSchemeById,
  updateIncentiveSchemeById,
  updateSchemeStatus,
  deleteIncentiveSchemeById,
  getSchemeConsumption,
  getSchemeSummary,
  queryIncentiveLogs,
  updateLogStatus,
  deleteIncentiveLog,
  bulkSettleLogs,
  getUserIncentiveSchemes,
  getTeamStats,
  getUserStatsDetail,
};
