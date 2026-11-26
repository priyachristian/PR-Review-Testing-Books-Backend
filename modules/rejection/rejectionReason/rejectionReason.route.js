const express = require('express');
const rejectionReasonValidation = require('./rejectionReason.validation');
const rejectionReasonController = require('./rejectionReason.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

// Reasons are configuration within the Rejection feature, so they are gated by the
// same module permission (rejectionOrders) the frontend uses for reason management.
router
  .route('/')
  .post(
    checkRoleRight(RIGHT_LIST.BOOK_REJECTION, RIGHTS.CREATE),
    validate(rejectionReasonValidation.createRejectionReason),
    rejectionReasonController.createRejectionReason,
  )
  .get(
    checkRoleRight(RIGHT_LIST.BOOK_REJECTION, RIGHTS.VIEW),
    validate(rejectionReasonValidation.getRejectionReasons),
    rejectionReasonController.getRejectionReasons,
  );

router
  .route('/:id')
  .get(
    checkRoleRight(RIGHT_LIST.BOOK_REJECTION, RIGHTS.VIEW),
    validate(rejectionReasonValidation.getRejectionReasonById),
    rejectionReasonController.getRejectionReasonById,
  )
  .patch(
    checkRoleRight(RIGHT_LIST.BOOK_REJECTION, RIGHTS.EDIT),
    validate(rejectionReasonValidation.updateRejectionReason),
    rejectionReasonController.updateRejectionReason,
  )
  .delete(
    checkRoleRight(RIGHT_LIST.BOOK_REJECTION, RIGHTS.DELETE),
    validate(rejectionReasonValidation.deleteRejectionReason),
    rejectionReasonController.deleteRejectionReason,
  );

module.exports = router;
