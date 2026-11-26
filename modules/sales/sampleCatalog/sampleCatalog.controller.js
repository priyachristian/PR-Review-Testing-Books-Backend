const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const pick = require('../../../utils/pick');
const { successResponse } = require('../../../services/response.service');
const { SAMPLE_CATALOG_MESSAGES } = require('../../../utils/messages');
const sampleCatalogService = require('./sampleCatalog.service');
const sampleCatalogTransformers = require('./sampleCatalog.transformer');

const errorMeta = (service, failureMessage) => ({
  service,
  controller: 'sampleCatalog',
  failureMessage,
  failureStatus: httpStatus.BAD_REQUEST,
});

const createSampleCatalog = catchAsync(
  async (req, res) => {
    const catalog = await sampleCatalogService.createSampleCatalog(req.body, req.query.companyId, req.user._id);
    const detail = await sampleCatalogService.getSampleCatalogById(catalog._id, req.query.companyId);
    return successResponse(
      res,
      sampleCatalogTransformers.getSampleCatalog(detail),
      SAMPLE_CATALOG_MESSAGES.CREATE_SUCCESS,
      httpStatus.CREATED,
    );
  },
  errorMeta('createSampleCatalog', SAMPLE_CATALOG_MESSAGES.CREATE_FAILURE),
);

const updateSampleCatalog = catchAsync(
  async (req, res) => {
    const { sampleCatalogId } = req.params;
    await sampleCatalogService.updateSampleCatalog(sampleCatalogId, req.query.companyId, req.body, req.user._id);
    const detail = await sampleCatalogService.getSampleCatalogById(sampleCatalogId, req.query.companyId);
    return successResponse(
      res,
      sampleCatalogTransformers.getSampleCatalog(detail),
      SAMPLE_CATALOG_MESSAGES.UPDATE_SUCCESS,
      httpStatus.OK,
    );
  },
  errorMeta('updateSampleCatalog', SAMPLE_CATALOG_MESSAGES.UPDATE_FAILURE),
);

const updateSampleCatalogStatus = catchAsync(
  async (req, res) => {
    const catalog = await sampleCatalogService.updateSampleCatalogStatus(
      req.params.sampleCatalogId,
      req.query.companyId,
      req.body.status,
      req.user._id,
      req.body.activateItemPortal,
    );
    return successResponse(
      res,
      { id: String(catalog._id), status: catalog.status },
      SAMPLE_CATALOG_MESSAGES.UPDATE_STATUS_SUCCESS,
      httpStatus.OK,
    );
  },
  errorMeta('updateSampleCatalogStatus', SAMPLE_CATALOG_MESSAGES.UPDATE_STATUS_FAILURE),
);

const getSampleCatalogs = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'search', 'status', 'visibility']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const { results, ...pagination } = await sampleCatalogService.querySampleCatalogs(filter, options);
    return successResponse(
      res,
      sampleCatalogTransformers.querySampleCatalogs(results),
      SAMPLE_CATALOG_MESSAGES.FETCH_ALL_SUCCESS,
      httpStatus.OK,
      pagination,
    );
  },
  errorMeta('querySampleCatalogs', SAMPLE_CATALOG_MESSAGES.FETCH_ALL_FAILURE),
);

const getSampleCatalog = catchAsync(
  async (req, res) => {
    const catalog = await sampleCatalogService.getSampleCatalogById(req.params.sampleCatalogId, req.query.companyId);
    return successResponse(
      res,
      sampleCatalogTransformers.getSampleCatalog(catalog),
      SAMPLE_CATALOG_MESSAGES.FETCH_ONE_SUCCESS,
      httpStatus.OK,
    );
  },
  errorMeta('getSampleCatalogById', SAMPLE_CATALOG_MESSAGES.FETCH_ONE_FAILURE),
);

module.exports = {
  createSampleCatalog,
  updateSampleCatalog,
  updateSampleCatalogStatus,
  getSampleCatalogs,
  getSampleCatalog,
};
