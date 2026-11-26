const httpStatus = require('http-status');
const ApiError = require('../../../utils/ApiError');
const { MODULE_MESSAGES } = require('../../../utils/messages');
const { getClientConnection, getBooksModels, getCommonModels, getAbssAdminModels } = require('../../../services/model.service');
const { APP_NAME } = require('@smit9313/abss-models-core/src/utils/enum');
const { HARD_HIDDEN_PLAN_FEATURES, SETTINGS_PLAN_FEATURES } = require('../../../utils/enum');
/**
 * Create a module
 * @param {Object} moduleBody
 * @returns {Promise<Module>}
 */
const createModule = async moduleBody => {
  const { Module } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const module = await Module.create([moduleBody], { session });
    await session.commitTransaction();
    return module[0];
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

/**
 * Query for modules
 * @param {Object} filter - Mongo filter
 * @param {Object} options - Query options
 * @param {string} [options.sortBy] - Sort option in the format: sortField:(desc|asc)
 * @param {number} [options.limit] - Maximum number of results per page (default = 10)
 * @param {number} [options.page] - Current page (default = 1)
 * @returns {Promise<QueryResult>}
 */
const queryModules = async (filter, options) => {
  const { Module } = getBooksModels();
  const modules = await Module.paginate(filter, options);
  return modules;
};

/**
 * Get module by id
 * @param {ObjectId} id
 * @returns {Promise<Module>}
 */
const getModuleById = async id => {
  const { Module } = getBooksModels();
  const module = await Module.findById(id);
  if (!module) {
    throw new ApiError(httpStatus.NOT_FOUND, MODULE_MESSAGES.FETCH_ONE_NOT_FOUND);
  }
  return module;
};

/**
 * Update module by id
 * @param {ObjectId} moduleId
 * @param {Object} updateBody
 * @returns {Promise<Module>}
 */
const updateModuleById = async (moduleId, updateBody) => {
  const { Module } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const module = await Module.findById(moduleId).session(session);
    if (!module) {
      throw new ApiError(httpStatus.NOT_FOUND, MODULE_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    Object.assign(module, updateBody);
    await module.save({ session });
    await session.commitTransaction();
    return module;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

/**
 * Delete module by id
 * @param {ObjectId} moduleId
 * @returns {Promise<Module>}
 */
const deleteModuleById = async moduleId => {
  const { Module } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const module = await Module.findById(moduleId).session(session);
    if (!module) {
      throw new ApiError(httpStatus.NOT_FOUND, MODULE_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    await module.remove({ session });
    await session.commitTransaction();
    return module;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const moduleIsInPlan = (module, planFeatureMap) => {
  if (!module.featureName) return true;
  const feature = planFeatureMap.get(module.featureName);
  return Boolean(feature && (feature.isUnlimited || feature.limit > 0));
};

/**
 * Keeps modules covered by the plan plus ancestors present in `modules` (for tree shape).
 * @param {Array} modules
 * @param {Map<string, object>} planFeatureMap
 * @param {Set<string>} [onlyFeatures] - When set, only modules whose featureName is in this
 *   set are checked against the plan; every other module is kept regardless of plan.
 *   Used to hard-hide a specific allowlist of modules for admins (see HARD_HIDDEN_PLAN_FEATURES),
 *   while leaving the default "admin sees everything" behavior intact for all other modules.
 */
const applyPlanLimitToModuleList = (modules, planFeatureMap, onlyFeatures = null) => {
  const byId = new Map(modules.map(m => [m._id.toString(), m]));
  const keep = new Set();
  for (const m of modules) {
    const isRestricted = onlyFeatures ? onlyFeatures.has(m.featureName) : true;
    if (isRestricted && !moduleIsInPlan(m, planFeatureMap)) continue;
    keep.add(m._id.toString());
    let parentId = m.parentModule;
    while (parentId) {
      const pid = String(parentId);
      const parent = byId.get(pid);
      if (!parent) break;
      keep.add(pid);
      parentId = parent.parentModule;
    }
  }
  return modules.filter(m => keep.has(m._id.toString()));
};

/**
 * Get the module tree for a user. Admins: all active modules + isInPlan per node, except modules in
 * HARD_HIDDEN_PLAN_FEATURES which are dropped entirely when not in plan. Non-admins: RBAC + plan + isInPlan.
 * @param {Object} user
 * @param {string} companyId
 * @returns {Promise<Object>}
 */
const getModuleTree = async (user, companyId) => {
  const { UserRole, Module } = getBooksModels();
  const { CompanySubscription } = getCommonModels();
  const { Plan } = getAbssAdminModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const isAdmin = Boolean(user?.isAdmin);

    const companySubscriptions = await CompanySubscription.find({ companyId, isActive: true }).session(session).lean();
    const planIds = companySubscriptions?.map(sub => sub.planId) || [];
    const plan = await Plan.findOne({ _id: { $in: planIds }, appName: APP_NAME.BOOKS }).session(session);
    const planFeatureMap = new Map((plan?.limits || []).map(feature => [feature.featureName, feature]));
    const isCustomPlan = plan?.isCustomPlan;
    const query = {
      isActive: true,
    };

    if (!isCustomPlan) {
      query.isCustomPlanModule = false;
    }
    const allModules = await Module.find(query).sort({ sequence: 1 }).lean().session(session);

    let userRole = null;
    if (!isAdmin) {
      userRole = await UserRole.findOne({ userId: user._id, companyId }).populate('roleId').session(session);
      if (!userRole) {
        throw new ApiError(httpStatus.FORBIDDEN, 'User role not found');
      }
    }

    let allowedModules = [];
    if (!isAdmin) {
      allowedModules = userRole.roleId.permissions
        .filter(permission => permission.view)
        .map(permission => permission.module._id.toString());
    }

    const requiredModules = new Set(isAdmin ? allModules.map(m => m._id.toString()) : allowedModules);

    if (!isAdmin) {
      allModules.forEach(module => {
        if (allowedModules.includes(module._id.toString()) && module.parentModule) {
          let parent = allModules.find(m => String(m._id) === String(module.parentModule));
          while (parent) {
            requiredModules.add(parent._id.toString());
            parent = parent.parentModule ? allModules.find(m => String(m._id) === String(parent.parentModule)) : null;
          }
        }
      });
    }

    let filteredModules = allModules.filter(module => requiredModules.has(module._id.toString()));

    if (!isAdmin) {
      filteredModules = applyPlanLimitToModuleList(filteredModules, planFeatureMap);
    } else {
      // Admins otherwise see every module regardless of plan; hard-hide the explicit allowlist.
      filteredModules = applyPlanLimitToModuleList(filteredModules, planFeatureMap, new Set(HARD_HIDDEN_PLAN_FEATURES));
    }

    await session.commitTransaction();

    let moduleTree = buildModuleTreeForPermissionTree(filteredModules, planFeatureMap);
    moduleTree = pruneEmptyParentContainers(moduleTree, allModules);

    return { moduleTree };
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const getPermissionModules = async (user, companyId) => {
  const { UserRole, Module } = getBooksModels();
  const { CompanySubscription } = getCommonModels();
  const { Plan } = getAbssAdminModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    // Fetch the user's role
    const isAdmin = Boolean(user?.isAdmin);
    const userRole = await UserRole.findOne({ userId: user._id, companyId }).populate('roleId').session(session);
    if (!userRole) {
      throw new ApiError(httpStatus.FORBIDDEN, 'User role not found');
    }

    const companySubscriptions = await CompanySubscription.find({
      companyId,
      isActive: true,
    })
      .session(session)
      .lean();
    const planIds = companySubscriptions?.map(sub => sub.planId) || [];
    const plan = await Plan.findOne({ _id: { $in: planIds }, appName: APP_NAME.BOOKS }).session(session);
    const planFeatureMap = new Map((plan?.limits || []).map(feature => [feature.featureName, feature]));
    const isCustomPlan = plan?.isCustomPlan;
    const query = {
      isActive: true,
    };

    if (!isCustomPlan) {
      query.isCustomPlanModule = false;
    }
    const allModules = await Module.find(query).sort({ sequence: 1 }).lean().session(session);

    let filteredModules = null;

    if (!isAdmin) {
      filteredModules = applyPlanLimitToModuleList(allModules, planFeatureMap);
    } else {
      filteredModules = applyPlanLimitToModuleList(allModules, planFeatureMap, new Set(HARD_HIDDEN_PLAN_FEATURES));
    }

    await session.commitTransaction();

    // Build the module tree
    let moduleTree = buildModuleTreeForPermissionTree(filteredModules, planFeatureMap);
    moduleTree = pruneEmptyParentContainers(moduleTree, allModules);
    return { moduleTree };
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const getSettingsFeaturePlanStatus = async companyId => {
  const { CompanySubscription } = getCommonModels();
  const { Plan } = getAbssAdminModels();

  const companySubscriptions = await CompanySubscription.find({ companyId, isActive: true }).lean();
  const planIds = companySubscriptions?.map(sub => sub.planId) || [];
  const plan = await Plan.findOne({ _id: { $in: planIds }, appName: APP_NAME.BOOKS }).lean();
  const planFeatureMap = new Map((plan?.limits || []).map(feature => [feature.featureName, feature]));

  const featurePlanStatus = {};
  SETTINGS_PLAN_FEATURES.forEach(featureName => {
    const feature = planFeatureMap.get(featureName);
    const isEnabled = Boolean(feature && (feature.isUnlimited || feature.limit > 0));
    featurePlanStatus[featureName] = {
      isEnabled,
      limit: feature?.limit ?? 0,
      isUnlimited: Boolean(feature?.isUnlimited),
    };
  });

  const hardHiddenFeatures = SETTINGS_PLAN_FEATURES.filter(featureName => HARD_HIDDEN_PLAN_FEATURES.includes(featureName));

  return { featurePlanStatus, hardHiddenFeatures };
};

const buildModuleTree = modules => {
  const tree = [];

  const addToTree = (module, parentModule = null) => {
    const moduleNode = {
      ...module,
      subItems: [],
    };

    if (parentModule) {
      parentModule.subItems.push(moduleNode);
    } else {
      tree.push(moduleNode);
    }

    const children = modules.filter(m => String(m.parentModule || '') === String(module._id));
    children.forEach(child => addToTree(child, moduleNode));

    return moduleNode;
  };

  modules.forEach(module => {
    const isRootModule = !module.parentModule || !modules.some(m => String(m._id) === String(module.parentModule));

    if (isRootModule) {
      addToTree(module);
    }
  });

  return tree;
};

const buildModuleTreeForPermissionTree = (modules, planFeatureMap = new Map()) => {
  const tree = [];

  const addToTree = (module, parentModule = null) => {
    const feature = module.featureName ? planFeatureMap.get(module.featureName) : null;
    const moduleNode = {
      ...module,
      subItems: [],
      isInPlan: module.featureName ? Boolean(feature && (feature.isUnlimited || feature.limit > 0)) : true,
    };

    if (parentModule) {
      parentModule.subItems.push(moduleNode);
    } else {
      tree.push(moduleNode);
    }

    const children = modules.filter(m => String(m.parentModule || '') === String(module._id));
    children.forEach(child => addToTree(child, moduleNode));

    return moduleNode;
  };

  modules.forEach(module => {
    const isRootModule = !module.parentModule || !modules.some(m => String(m._id) === String(module.parentModule));

    if (isRootModule) {
      addToTree(module);
    }
  });

  return tree;
};

const pruneEmptyParentContainers = (treeNodes, allModules) => {
  const isSystemParent = moduleId => allModules.some(m => String(m.parentModule || '') === String(moduleId));

  const prune = nodes => {
    return nodes
      .map(node => ({ ...node, subItems: prune(node.subItems || []) }))
      .filter(node => {
        const hasChildren = (node.subItems || []).length > 0;
        if (hasChildren) return true;
        if (isSystemParent(node._id)) return false;
        return true;
      });
  };

  return prune(treeNodes);
};

const collectEmptyModules = modules => {
  let emptyModules = [];
  modules.forEach(module => {
    if (module.subItems.length === 0) {
      emptyModules.push(module);
    } else {
      const nestedEmptyModules = collectEmptyModules(module.subItems);
      emptyModules = emptyModules.concat(nestedEmptyModules);
    }
  });

  return emptyModules;
};

module.exports = {
  createModule,
  queryModules,
  getModuleById,
  updateModuleById,
  deleteModuleById,
  getModuleTree,
  getPermissionModules,
  getSettingsFeaturePlanStatus,
};
