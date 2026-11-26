const httpStatus = require('http-status');
const ApiError = require('../utils/ApiError');
const { getBooksModels } = require('../services/model.service');
const { RIGHT_LIST } = require('../utils/enum');
const { getCommentModuleConfig } = require('../utils/moduleConfig');

const isAdminRoleName = roleName => /^admin$/i.test(roleName || '');

const checkRoleRight = (moduleName, right) => {
  return async (req, res, next) => {
    try {
      if (!req?.tokenData) {
        return next(new ApiError(httpStatus.UNAUTHORIZED, 'Unauthorized'));
      }

      const { UserRole, Role, Module } = getBooksModels();

      const rights = await UserRole.findOne({ userId: req.user._id, companyId: req.query.companyId });
      const module = await Module.findOne({ key: moduleName, isActive: true });

      const role = await Role.findOne(
        {
          _id: rights?.roleId.toString(),
          'permissions.module': module?._id,
        },
        {
          permissions: { $elemMatch: { module: module?._id } },
        },
      );

      const permission = role?.permissions[0];

      if (!permission || !permission[right]) {
        return next(new ApiError(httpStatus.FORBIDDEN, 'You do not have right to access this feature'));
      }

      return next();
    } catch (err) {
      console.error('Error in checkRoleRight:', err);
      return next(
        new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We couldn't verify your permissions right now. Please try again."),
      );
    }
  };
};

const dynamicRoleCheck = right => {
  return (req, res, next) => {
    let module;

    const { isCustomer, isVendor } = req.query;

    if (isCustomer) {
      module = RIGHT_LIST.CUSTOMER_MASTER;
    } else if (isVendor) {
      module = RIGHT_LIST.VENDORS;
    } else {
      return res.status(400).json({ message: 'Invalid role in payload' });
    }

    // call the original checkRoleRight
    return checkRoleRight(module, right)(req, res, next);
  };
};

const checkReportRight = (reportKeys, action = 'view') => {
  return async (req, res, next) => {
    try {
      if (!req?.tokenData) {
        return next(new ApiError(httpStatus.UNAUTHORIZED, 'Unauthorized'));
      }

      const { UserRole, Role } = getBooksModels();

      const userRole = await UserRole.findOne({ userId: req.user._id, companyId: req.query.companyId });
      if (!userRole) {
        return next(new ApiError(httpStatus.FORBIDDEN, 'You do not have right to access this report'));
      }
      const role = await Role.findById(userRole.roleId).select('reportsPermissions');
      if (!role) {
        return next(new ApiError(httpStatus.FORBIDDEN, 'You do not have right to access this report'));
      }

      const keys = Array.isArray(reportKeys) ? reportKeys : [reportKeys];

      const hasPermission = keys.some(key => {
        const permission = role.reportsPermissions?.[key];
        return permission?.[action] === true;
      });

      if (!hasPermission) {
        return next(new ApiError(httpStatus.FORBIDDEN, 'You do not have right to access this report'));
      }

      return next();
    } catch (err) {
      console.error('Error in checkReportRight:', err);
      return next(
        new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We couldn't verify your permissions right now. Please try again."),
      );
    }
  };
};

const checkAnalyticsRight = (analyticsKey, action = 'view') => {
  return async (req, res, next) => {
    try {
      if (!req?.tokenData) {
        return next(new ApiError(httpStatus.UNAUTHORIZED, 'Unauthorized'));
      }

      const { UserRole, Role } = getBooksModels();

      const userRole = await UserRole.findOne({ userId: req.user._id, companyId: req.query.companyId });
      if (!userRole) {
        return next(new ApiError(httpStatus.FORBIDDEN, 'You do not have right to access this analytics'));
      }
      const role = await Role.findById(userRole.roleId).select('analyticsPermissions');
      if (!role) {
        return next(new ApiError(httpStatus.FORBIDDEN, 'You do not have right to access this analytics'));
      }
      const reportPermission = role.analyticsPermissions?.[analyticsKey];

      if (!reportPermission || reportPermission[action] !== true) {
        return next(new ApiError(httpStatus.FORBIDDEN, 'You do not have right to access this analytics'));
      }

      return next();
    } catch (err) {
      console.error('Error in checkAnalyticsRight:', err);
      return next(
        new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We couldn't verify your permissions right now. Please try again."),
      );
    }
  };
};

const checkSplitConfig = (action = 'view') => {
  return async (req, res, next) => {
    try {
      if (!req?.tokenData) {
        return next(new ApiError(httpStatus.UNAUTHORIZED, 'Unauthorized'));
      }

      const { UserRole, Role } = getBooksModels();

      const userRole = await UserRole.findOne({ userId: req.user._id, companyId: req.query.companyId });
      if (!userRole) {
        return next(new ApiError(httpStatus.FORBIDDEN, 'You do not have right to access this split config'));
      }
      const role = await Role.findById(userRole.roleId).select('splitConfig');
      const splitPermission = role?.splitConfig;

      if (!splitPermission || splitPermission[action] !== true) {
        return next(new ApiError(httpStatus.FORBIDDEN, 'You do not have right to access this split config'));
      }

      return next();
    } catch (err) {
      console.error('Error in checkSplitConfig:', err);
      return next(
        new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We couldn't verify your permissions right now. Please try again."),
      );
    }
  };
};

const checkOtherSettingsRight = (settingKey, action = 'view') => {
  return async (req, res, next) => {
    try {
      if (!req?.tokenData) {
        return next(new ApiError(httpStatus.UNAUTHORIZED, 'Unauthorized'));
      }

      const { UserRole, Role } = getBooksModels();

      const userRole = await UserRole.findOne({ userId: req.user._id, companyId: req.query.companyId });
      if (!userRole) {
        return next(new ApiError(httpStatus.FORBIDDEN, 'You do not have right to access this feature'));
      }
      const role = await Role.findById(userRole.roleId).select('otherSettings role');

      if (isAdminRoleName(role?.role)) {
        return next();
      }

      const settingPermission = role?.otherSettings?.[settingKey];

      if (!settingPermission || settingPermission[action] !== true) {
        return next(new ApiError(httpStatus.FORBIDDEN, 'You do not have right to access this feature'));
      }

      return next();
    } catch (err) {
      console.error('Error in checkOtherSettingsRight:', err);
      return next(new ApiError(httpStatus.INTERNAL_SERVER_ERROR, httpStatus[500]));
    }
  };
};

const checkModuleCommentRight = right => {
  return (req, res, next) => {
    const moduleConfig = getCommentModuleConfig(req.body.moduleName);

    if (!moduleConfig?.right) {
      return next(new ApiError(httpStatus.BAD_REQUEST, 'Invalid module'));
    }

    return checkRoleRight(moduleConfig.right, right)(req, res, next);
  };
};

const checkInventoryConfigRight = (action = 'view') => {
  return async (req, res, next) => {
    try {
      if (!req?.tokenData) {
        return next(new ApiError(httpStatus.UNAUTHORIZED, 'Unauthorized'));
      }

      const { UserRole, Role } = getBooksModels();

      const userRole = await UserRole.findOne({
        userId: req.user._id,
        companyId: req.query.companyId,
      });

      if (!userRole) {
        return next(new ApiError(httpStatus.FORBIDDEN, 'You do not have right to access this feature'));
      }

      const role = await Role.findById(userRole.roleId).select('inventoryConfig role');

      if (isAdminRoleName(role?.role)) {
        return next();
      }

      const inventoryPermission = role?.inventoryConfig;

      if (!inventoryPermission || inventoryPermission[action] !== true) {
        return next(new ApiError(httpStatus.FORBIDDEN, 'You do not have right to access this feature'));
      }

      return next();
    } catch (err) {
      console.error('Error in checkInventoryConfigRight:', err);

      return next(new ApiError(httpStatus.INTERNAL_SERVER_ERROR, httpStatus[500]));
    }
  };
};

module.exports = {
  checkRoleRight,
  dynamicRoleCheck,
  checkReportRight,
  checkAnalyticsRight,
  checkSplitConfig,
  checkOtherSettingsRight,
  checkModuleCommentRight,
  checkInventoryConfigRight,
};
