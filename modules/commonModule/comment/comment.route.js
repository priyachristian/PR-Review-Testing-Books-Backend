const express = require('express');
const commentValidation = require('./comment.validation');
const commentController = require('./comment.controller');
const validate = require('../../../middlewares/validate');
const { checkModuleCommentRight } = require('../../../middlewares/checkRoleRight');
const { RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router
  .route('/')
  .post(validate(commentValidation.addComment), checkModuleCommentRight(RIGHTS.EDIT), commentController.addComment);

module.exports = router;
