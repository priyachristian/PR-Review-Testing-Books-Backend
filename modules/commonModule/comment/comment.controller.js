const httpStatus = require('http-status');
const { COMMENT_MESSAGE } = require('../../../utils/messages');
const catchAsync = require('../../../utils/catchAsync');
const { successResponse } = require('../../../services/response.service');
const commentService = require('./comment.service');

const addComment = catchAsync(
  async (req, res) => {
    const comment = await commentService.addComment(
      {
        ...req.body,
        companyId: req.query.companyId,
      },
      req.user._id,
    );

    return successResponse(res, { comment }, COMMENT_MESSAGE.ADD_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'addComment',
    controller: 'comment',
    failureMessage: COMMENT_MESSAGE.ADD_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

module.exports = {
  addComment,
};
