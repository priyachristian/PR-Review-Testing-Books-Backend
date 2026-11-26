const httpStatus = require('http-status');
const ApiError = require('../../../utils/ApiError');
const { getCommentModuleConfig } = require('../../../utils/moduleConfig');

const addComment = async (commentBody, userId) => {
  const { companyId, moduleName, referenceId, message } = commentBody;

  const { model } = getCommentModuleConfig(moduleName);

  const comment = {
    message: message.trim(),
    addedBy: userId,
    createdAt: new Date(),
  };

  const updatedRecord = await model.findOneAndUpdate(
    {
      _id: referenceId,
      companyId,
    },
    {
      $push: {
        commentHistory: comment,
      },
    },
    {
      new: true,
    },
  );

  if (!updatedRecord) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Record not found');
  }

  return updatedRecord.commentHistory[updatedRecord.commentHistory.length - 1];
};

module.exports = {
  addComment,
};
