const httpStatus = require('http-status');
const { getCommonModels, getBooksModels, getBooksCrmModels } = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');
const { createSearchRegex } = require('../../../utils/regexUtils');
const { PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES } = require('../../../utils/messages');

const CONFIG_FIELD = 'productionDepartmentWarehouseConfig';

const hasDuplicateDepartmentName = (configs, name, id) =>
  configs.some(
    config => String(config._id) !== String(id || '') && config.departmentName.trim().toLowerCase() === name.trim().toLowerCase(),
  );

const createProductionDepartmentWarehouseConfig = async data => {
  const { CompanySettings } = getCommonModels();
  const { companyId, ...configData } = data;
  const companySettings = await CompanySettings.findOne({ companyId });
  if (!companySettings) {
    throw new ApiError(httpStatus.NOT_FOUND, PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES.SETTINGS_NOT_FOUND);
  }

  if (hasDuplicateDepartmentName(companySettings[CONFIG_FIELD] || [], configData.departmentName)) {
    throw new ApiError(httpStatus.BAD_REQUEST, PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES.DUPLICATE_NAME);
  }
  companySettings[CONFIG_FIELD].push(configData);

  await companySettings.save();
  return companySettings[CONFIG_FIELD][companySettings[CONFIG_FIELD].length - 1];
};

const getProductionDepartmentWarehouseConfigs = async filter => {
  const { CompanySettings } = getCommonModels();
  const { companyId, search } = filter;

  const companySettings = await CompanySettings.findOne({ companyId }).select(CONFIG_FIELD);

  if (!companySettings) {
    throw new ApiError(httpStatus.NOT_FOUND, PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES.SETTINGS_NOT_FOUND);
  }

  let configs = companySettings[CONFIG_FIELD] || [];

  if (search) {
    const searchRegex = createSearchRegex(search.trim());
    configs = configs.filter(config => searchRegex.test(config.departmentName));
  }

  return configs;
};

const getProductionDepartmentWarehouseConfigById = async (id, companyId) => {
  const { CompanySettings } = getCommonModels();

  const companySettings = await CompanySettings.findOne({
    companyId,
    [`${CONFIG_FIELD}._id`]: id,
  }).select(CONFIG_FIELD);

  if (!companySettings) {
    throw new ApiError(httpStatus.NOT_FOUND, PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES.FETCH_NOT_FOUND);
  }

  const config = companySettings[CONFIG_FIELD].id(id);

  if (!config) {
    throw new ApiError(httpStatus.NOT_FOUND, PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES.FETCH_NOT_FOUND);
  }

  return config;
};

const updateProductionDepartmentWarehouseConfigById = async (id, updateBody, companyId) => {
  const { CompanySettings } = getCommonModels();

  const companySettings = await CompanySettings.findOne({
    companyId,
    [`${CONFIG_FIELD}._id`]: id,
  });

  if (!companySettings) {
    throw new ApiError(httpStatus.NOT_FOUND, PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES.FETCH_NOT_FOUND);
  }

  const config = companySettings[CONFIG_FIELD].id(id);

  if (!config) {
    throw new ApiError(httpStatus.NOT_FOUND, PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES.FETCH_NOT_FOUND);
  }

  if (updateBody.departmentName !== undefined) {
    if (hasDuplicateDepartmentName(companySettings[CONFIG_FIELD], updateBody.departmentName, id)) {
      throw new ApiError(httpStatus.BAD_REQUEST, PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES.DUPLICATE_NAME);
    }
  }

  Object.assign(config, updateBody);
  await companySettings.save();
  return config;
};

const updateProductionDepartmentWarehouseConfigStatus = async (id, isActive, companyId) => {
  const { CompanySettings } = getCommonModels();

  const companySettings = await CompanySettings.findOne({
    companyId,
    [`${CONFIG_FIELD}._id`]: id,
  });

  if (!companySettings) {
    throw new ApiError(httpStatus.NOT_FOUND, PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES.FETCH_NOT_FOUND);
  }

  const config = companySettings[CONFIG_FIELD].id(id);

  if (!config) {
    throw new ApiError(httpStatus.NOT_FOUND, PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES.FETCH_NOT_FOUND);
  }

  config.isActive = isActive;
  await companySettings.save();
  return config;
};

const deleteProductionDepartmentWarehouseConfigById = async (id, companyId) => {
  const { CompanySettings } = getCommonModels();
  const { ProductionOrder } = getBooksModels();

  const companySettings = await CompanySettings.findOne({
    companyId,
    [`${CONFIG_FIELD}._id`]: id,
  });

  if (!companySettings) {
    throw new ApiError(httpStatus.NOT_FOUND, PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES.FETCH_NOT_FOUND);
  }

  const config = companySettings[CONFIG_FIELD].id(id);

  if (!config) {
    throw new ApiError(httpStatus.NOT_FOUND, PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES.FETCH_NOT_FOUND);
  }

  const orderUsingConfig = await ProductionOrder.exists({ companyId, productionDepartmentWarehouseConfigId: id });
  if (orderUsingConfig) {
    throw new ApiError(httpStatus.BAD_REQUEST, PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES.IN_USE);
  }

  config.deleteOne();

  await companySettings.save();

  return config;
};

const getProductionDepartmentWarehouseDropdown = async companyId => {
  const { CompanySettings } = getCommonModels();
  const { Warehouse } = getBooksCrmModels();

  const companySettings = await CompanySettings.findOne({ companyId }).select('productionDepartmentWarehouseConfig').lean();

  const configs = companySettings?.productionDepartmentWarehouseConfig || [];
  const activeConfigs = configs.filter(config => config.isActive);
  const warehouseIds = activeConfigs.flatMap(config =>
    [config.rawMaterialWarehouseId, config.productionWarehouseId, config.finishedGoodsWarehouseId].filter(Boolean),
  );
  const warehouses = await Warehouse.find({ _id: { $in: warehouseIds }, companyId })
    .select('name')
    .lean();
  const warehouseById = new Map(warehouses.map(warehouse => [warehouse._id.toString(), warehouse]));

  return activeConfigs.map(config => ({
    _id: config._id,
    departmentName: config.departmentName,
    rawMaterialWarehouse: warehouseById.get(config.rawMaterialWarehouseId?.toString()) || null,
    productionWarehouse: warehouseById.get(config.productionWarehouseId?.toString()) || null,
    finishedGoodsWarehouse: warehouseById.get(config.finishedGoodsWarehouseId?.toString()) || null,
  }));
};

module.exports = {
  createProductionDepartmentWarehouseConfig,
  getProductionDepartmentWarehouseConfigs,
  getProductionDepartmentWarehouseConfigById,
  updateProductionDepartmentWarehouseConfigById,
  updateProductionDepartmentWarehouseConfigStatus,
  deleteProductionDepartmentWarehouseConfigById,
  getProductionDepartmentWarehouseDropdown,
};
