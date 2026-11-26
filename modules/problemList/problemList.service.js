const httpStatus = require('http-status');
const { getBooksModels, getCommonModels } = require('../../services/model.service');
const ApiError = require('../../utils/ApiError');
const { PROBLEM_LIST_MESSAGES } = require('../../utils/messages');

const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const findDuplicateName = async (ProblemList, { companyId, parentProblemId, name, excludeId }) => {
  const filter = {
    companyId,
    parentProblemId: parentProblemId || null,
    name: { $regex: new RegExp(`^${escapeRegex(name)}$`, 'i') },
  };

  if (excludeId) {
    filter._id = { $ne: excludeId };
  }

  return ProblemList.findOne(filter);
};

const resolveProblemType = async (ProblemList, { parentProblemId, problemType, companyId }) => {
  if (!parentProblemId) {
    if (!problemType) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'problemType is required when creating a root problem');
    }
    return problemType;
  }

  const parent = await ProblemList.findOne({ _id: parentProblemId, companyId });
  if (!parent) {
    throw new ApiError(httpStatus.NOT_FOUND, PROBLEM_LIST_MESSAGES.PARENT_NOT_FOUND);
  }

  return parent.problemType;
};

const buildChildCountMap = docs => {
  const childCountByParentId = {};

  for (const doc of docs) {
    if (!doc.parentProblemId) {
      continue;
    }
    const parentId = String(doc.parentProblemId);
    childCountByParentId[parentId] = (childCountByParentId[parentId] || 0) + 1;
  }

  return childCountByParentId;
};

const toProblemNode = (doc, childCountByParentId = {}) => ({
  id: String(doc._id),
  companyId: doc.companyId,
  problemType: doc.problemType,
  parentProblemId: doc.parentProblemId ? String(doc.parentProblemId) : null,
  name: doc.name,
  sortOrder: doc.sortOrder ?? 0,
  department: doc.department || null,
  assignedTo: doc.assignedTo || null,
  urgency: doc.urgency,
  replyWithinHours: doc.replyWithinHours,
  sortOutWithinDays: doc.sortOutWithinDays,
  requiredAttachments: doc.requiredAttachments || [],
  visibility: doc.visibility,
  canAddChild: doc.canAddChild,
  isActive: doc.isActive,
  isSystemGenerated: Boolean(doc.isSystemGenerated),
  addedBy: doc.addedBy || null,
  childCount: childCountByParentId[String(doc._id)] || 0,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
  children: [],
});

const includeSearchParents = (docs, search) => {
  if (!search?.trim()) {
    return docs;
  }

  const searchText = search.trim().toLowerCase();
  const byId = new Map(docs.map(doc => [String(doc._id), doc]));
  const matchedIds = new Set(docs.filter(doc => (doc.name || '').toLowerCase().includes(searchText)).map(doc => String(doc._id)));

  const requiredIds = new Set(matchedIds);
  for (const id of matchedIds) {
    let current = byId.get(id);
    while (current?.parentProblemId) {
      const parentId = String(current.parentProblemId);
      if (requiredIds.has(parentId)) {
        break;
      }
      requiredIds.add(parentId);
      current = byId.get(parentId);
    }
  }

  return docs.filter(doc => requiredIds.has(String(doc._id)));
};

const nestProblems = (docs, childCountByParentId = {}) => {
  const nodes = docs.map(doc => toProblemNode(doc, childCountByParentId));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const roots = [];

  for (const node of nodes) {
    if (node.parentProblemId && byId.has(node.parentProblemId)) {
      byId.get(node.parentProblemId).children.push(node);
    } else if (!node.parentProblemId) {
      roots.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortNodes = list => {
    list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
    list.forEach(node => sortNodes(node.children));
  };

  sortNodes(roots);
  return roots;
};

const assertValidParentChange = async (ProblemList, { companyId, problemListId, nextParentProblemId }) => {
  if (!nextParentProblemId) {
    return null;
  }

  if (String(nextParentProblemId) === String(problemListId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, PROBLEM_LIST_MESSAGES.INVALID_PARENT);
  }

  const parent = await ProblemList.findOne({ _id: nextParentProblemId, companyId })
    .select('_id parentProblemId problemType')
    .lean();
  if (!parent) {
    throw new ApiError(httpStatus.NOT_FOUND, PROBLEM_LIST_MESSAGES.PARENT_NOT_FOUND);
  }

  // Walk up from the proposed parent. If we hit the node being moved, this would create a cycle.
  let current = parent;
  const visited = new Set([String(parent._id)]);
  while (current.parentProblemId) {
    const ancestorId = String(current.parentProblemId);
    if (ancestorId === String(problemListId)) {
      throw new ApiError(httpStatus.BAD_REQUEST, PROBLEM_LIST_MESSAGES.INVALID_PARENT_CYCLE);
    }
    if (visited.has(ancestorId)) {
      break;
    }
    visited.add(ancestorId);
    // eslint-disable-next-line no-await-in-loop
    current = await ProblemList.findOne({ _id: current.parentProblemId, companyId }).select('_id parentProblemId').lean();
    if (!current) {
      break;
    }
  }

  return parent;
};

const createProblemList = async (body, userId) => {
  const { ProblemList } = getBooksModels();
  const { companyId, parentProblemId = null, name } = body;

  const problemType = await resolveProblemType(ProblemList, {
    parentProblemId,
    problemType: body.problemType,
    companyId,
  });

  const duplicate = await findDuplicateName(ProblemList, {
    companyId,
    parentProblemId,
    name,
  });

  if (duplicate) {
    throw new ApiError(httpStatus.CONFLICT, PROBLEM_LIST_MESSAGES.DUPLICATE_NAME);
  }

  let sortOrder = body.sortOrder;
  if (sortOrder === undefined || sortOrder === null) {
    const lastSibling = await ProblemList.findOne({ companyId, parentProblemId: parentProblemId || null })
      .sort({ sortOrder: -1 })
      .select('sortOrder')
      .lean();
    sortOrder = (lastSibling?.sortOrder ?? -1) + 1;
  }

  const problem = await ProblemList.create({
    ...body,
    companyId,
    parentProblemId: parentProblemId || null,
    problemType,
    sortOrder,
    visibility: 'EVERYONE',
    isSystemGenerated: false,
    addedBy: userId,
    updatedBy: userId,
  });

  return problem;
};

const getProblemListTree = async filter => {
  const { ProblemList } = getBooksModels();
  const { companyId, isActive, search } = filter;

  const allDocs = await ProblemList.find({ companyId }).lean();
  const childCountByParentId = buildChildCountMap(allDocs);

  let docs = allDocs;
  if (typeof isActive === 'boolean') {
    docs = allDocs.filter(doc => doc.isActive === isActive);
  }

  const filteredDocs = includeSearchParents(docs, search);
  return nestProblems(filteredDocs, childCountByParentId);
};

const getProblemListById = async (problemListId, companyId) => {
  const { ProblemList } = getBooksModels();
  const { User } = getCommonModels();

  const problem = await ProblemList.findOne({ _id: problemListId, companyId }).lean();
  if (!problem) {
    throw new ApiError(httpStatus.NOT_FOUND, PROBLEM_LIST_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const addedByUser = problem.addedBy ? await User.findById(problem.addedBy).select('firstName lastName') : null;

  return {
    ...problem,
    addedByName: addedByUser ? `${addedByUser.firstName} ${addedByUser.lastName}` : null,
  };
};

const updateProblemListById = async (problemListId, updateBody, userId) => {
  const { ProblemList } = getBooksModels();
  const { companyId } = updateBody;

  const problem = await ProblemList.findOne({ _id: problemListId, companyId });
  if (!problem) {
    throw new ApiError(httpStatus.NOT_FOUND, PROBLEM_LIST_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const nextParentProblemId =
    updateBody.parentProblemId !== undefined ? updateBody.parentProblemId || null : problem.parentProblemId;

  if (updateBody.parentProblemId !== undefined) {
    const parent = await assertValidParentChange(ProblemList, {
      companyId,
      problemListId,
      nextParentProblemId,
    });
    if (parent) {
      updateBody.problemType = parent.problemType;
    }
  }

  const nextName = updateBody.name !== undefined ? updateBody.name : problem.name;
  const duplicate = await findDuplicateName(ProblemList, {
    companyId,
    parentProblemId: nextParentProblemId,
    name: nextName,
    excludeId: problemListId,
  });

  if (duplicate) {
    throw new ApiError(httpStatus.CONFLICT, PROBLEM_LIST_MESSAGES.DUPLICATE_NAME);
  }

  // Never allow clients to flip system flag;
  delete updateBody.isSystemGenerated;

  Object.assign(problem, {
    ...updateBody,
    parentProblemId: nextParentProblemId,
  });

  problem.updatedBy = userId;

  await problem.save();
  return problem;
};

const deleteProblemListById = async (problemListId, companyId) => {
  const { ProblemList, Complaint } = getBooksModels();

  const problem = await ProblemList.findOne({ _id: problemListId, companyId });
  if (!problem) {
    throw new ApiError(httpStatus.NOT_FOUND, PROBLEM_LIST_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  if (problem.isSystemGenerated) {
    throw new ApiError(httpStatus.BAD_REQUEST, PROBLEM_LIST_MESSAGES.DELETE_SYSTEM_GENERATED);
  }

  const childCount = await ProblemList.countDocuments({
    companyId,
    parentProblemId: problemListId,
  });

  if (childCount > 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, PROBLEM_LIST_MESSAGES.DELETE_HAS_CHILDREN);
  }

  const usageCount = await Complaint.countDocuments({ companyId, problemListId });
  if (usageCount > 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, PROBLEM_LIST_MESSAGES.DELETE_IN_USE);
  }

  await ProblemList.deleteOne({ _id: problemListId, companyId });
};

module.exports = {
  createProblemList,
  getProblemListTree,
  getProblemListById,
  updateProblemListById,
  deleteProblemListById,
};
