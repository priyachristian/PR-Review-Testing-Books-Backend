const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const { successResponse, errorResponse } = require('../../../services/response.service');
const documentExportService = require('./documentExport.service');

const createDocumentExport = catchAsync(async (req, res) => {
  try {
    const { moduleType, format, fileName } = req.body;
    const result = await documentExportService.createExportJob({
      companyId: req.query.companyId,
      userId: req.user._id,
      moduleType,
      format,
      fileName,
      match: req.documentExportMatch,
    });
    return successResponse(res, result, 'Export job created', httpStatus.ACCEPTED);
  } catch (error) {
    return errorResponse(
      { req, error, service: 'createExportJob', controller: 'documentExport' },
      res,
      error?.message || 'Failed to create export job',
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      error?.code,
      error?.data,
    );
  }
});

const downloadDocumentExport = catchAsync(async (req, res) => {
  try {
    await documentExportService.streamExportDownload({
      jobId: req.params.jobId,
      companyId: req.query.companyId,
      token: req.query.token,
      req,
      res,
    });
  } catch (error) {
    if (res.headersSent) {
      if (!res.writableEnded) {
        res.destroy();
      }
      return;
    }
    return errorResponse(
      { req, error, service: 'streamExportDownload', controller: 'documentExport' },
      res,
      error?.message || 'Failed to download export',
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      error?.code,
      error?.data,
    );
  }
});

module.exports = {
  createDocumentExport,
  downloadDocumentExport,
};
