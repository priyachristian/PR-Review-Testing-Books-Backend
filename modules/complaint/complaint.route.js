const express = require('express');
const validate = require('../../middlewares/validate');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const { checkRoleRight } = require('../../middlewares/checkRoleRight');
const { checkComplaintVisibility } = require('../../middlewares/checkComplaintVisibility');
const { checkSubscription } = require('../../middlewares/checkSubscription');
const { multipleAttachmentUploadFields, multerErrorHandler } = require('../../middlewares/uploadMiddleware');
const parseFormData = require('../../middlewares/parseFormData');
const { RIGHT_LIST, RIGHTS, ATTACHMENT_MAX_COUNT } = require('../../utils/enum');
const complaintValidation = require('./complaint.validation');
const complaintController = require('./complaint.controller');

const router = express.Router();
const uploadFields = multipleAttachmentUploadFields([
  { name: 'attachment', maxCount: ATTACHMENT_MAX_COUNT },
  { name: 'photo', maxCount: ATTACHMENT_MAX_COUNT },
]);

const withUpload = [uploadFields, multerErrorHandler, parseFormData];

router
  .route('/')
  .post(
    checkRoleRight(RIGHT_LIST.COMPLAINTS_LIST, RIGHTS.CREATE),
    checkSubscription(PLAN_FEATURES.COMPLAINTS),
    ...withUpload,
    validate(complaintValidation.createComplaint),
    checkComplaintVisibility,
    complaintController.createComplaint,
  )
  .get(
    checkRoleRight(RIGHT_LIST.COMPLAINTS_LIST, RIGHTS.VIEW),
    validate(complaintValidation.getComplaints),
    checkComplaintVisibility,
    complaintController.getComplaints,
  );

router.get(
  '/dropdown',
  checkRoleRight(RIGHT_LIST.COMPLAINTS_LIST, RIGHTS.VIEW),
  validate(complaintValidation.getComplaintsDropdown),
  checkComplaintVisibility,
  complaintController.getComplaintsDropdown,
);

router
  .route('/:complaintId')
  .get(
    checkRoleRight(RIGHT_LIST.COMPLAINTS_LIST, RIGHTS.VIEW),
    validate(complaintValidation.getComplaint),
    checkComplaintVisibility,
    complaintController.getComplaint,
  )
  .put(
    checkRoleRight(RIGHT_LIST.COMPLAINTS_LIST, RIGHTS.EDIT),
    ...withUpload,
    validate(complaintValidation.updateComplaint),
    checkComplaintVisibility,
    complaintController.updateComplaint,
  )
  .delete(
    checkRoleRight(RIGHT_LIST.COMPLAINTS_LIST, RIGHTS.DELETE),
    validate(complaintValidation.deleteComplaint),
    checkComplaintVisibility,
    complaintController.deleteComplaint,
  );

router.post(
  '/:complaintId/steps/assign',
  checkRoleRight(RIGHT_LIST.COMPLAINTS_LIST, RIGHTS.EDIT),
  validate(complaintValidation.assignStep),
  checkComplaintVisibility,
  complaintController.assignStep,
);

router.post(
  '/:complaintId/steps/reply',
  checkRoleRight(RIGHT_LIST.COMPLAINTS_LIST, RIGHTS.EDIT),
  ...withUpload,
  validate(complaintValidation.replyStep),
  checkComplaintVisibility,
  complaintController.replyStep,
);

router.post(
  '/:complaintId/steps/start-progress',
  checkRoleRight(RIGHT_LIST.COMPLAINTS_LIST, RIGHTS.EDIT),
  validate(complaintValidation.startProgressStep),
  checkComplaintVisibility,
  complaintController.startProgressStep,
);

router.post(
  '/:complaintId/steps/warranty',
  checkRoleRight(RIGHT_LIST.COMPLAINTS_LIST, RIGHTS.EDIT),
  validate(complaintValidation.warrantyStep),
  checkComplaintVisibility,
  complaintController.warrantyStep,
);

router.post(
  '/:complaintId/steps/root-cause',
  checkRoleRight(RIGHT_LIST.COMPLAINTS_LIST, RIGHTS.EDIT),
  validate(complaintValidation.rootCauseStep),
  checkComplaintVisibility,
  complaintController.rootCauseStep,
);

router.post(
  '/:complaintId/steps/stop-gap',
  checkRoleRight(RIGHT_LIST.COMPLAINTS_LIST, RIGHTS.EDIT),
  validate(complaintValidation.stopGapStep),
  checkComplaintVisibility,
  complaintController.stopGapStep,
);

router.post(
  '/:complaintId/steps/record-progress',
  checkRoleRight(RIGHT_LIST.COMPLAINTS_LIST, RIGHTS.EDIT),
  validate(complaintValidation.recordProgressStep),
  checkComplaintVisibility,
  complaintController.recordProgressStep,
);

router.post(
  '/:complaintId/steps/settlement',
  checkRoleRight(RIGHT_LIST.COMPLAINTS_LIST, RIGHTS.EDIT),
  validate(complaintValidation.settlementStep),
  checkComplaintVisibility,
  complaintController.settlementStep,
);

router.post(
  '/:complaintId/steps/complete-action',
  checkRoleRight(RIGHT_LIST.COMPLAINTS_LIST, RIGHTS.EDIT),
  validate(complaintValidation.completeActionStep),
  checkComplaintVisibility,
  complaintController.completeActionStep,
);

router.post(
  '/:complaintId/steps/verify',
  checkRoleRight(RIGHT_LIST.COMPLAINTS_LIST, RIGHTS.EDIT),
  validate(complaintValidation.verifyStep),
  checkComplaintVisibility,
  complaintController.verifyStep,
);

router.post(
  '/:complaintId/steps/close',
  checkRoleRight(RIGHT_LIST.COMPLAINTS_LIST, RIGHTS.EDIT),
  validate(complaintValidation.closeStep),
  checkComplaintVisibility,
  complaintController.closeStep,
);

router.post(
  '/:complaintId/steps/skip',
  checkRoleRight(RIGHT_LIST.COMPLAINTS_LIST, RIGHTS.EDIT),
  validate(complaintValidation.skipStep),
  checkComplaintVisibility,
  complaintController.skipStep,
);

router.post(
  '/:complaintId/team-notes',
  checkRoleRight(RIGHT_LIST.COMPLAINTS_LIST, RIGHTS.EDIT),
  validate(complaintValidation.addTeamNote),
  checkComplaintVisibility,
  complaintController.addTeamNote,
);

router.post(
  '/:complaintId/team-tasks',
  checkRoleRight(RIGHT_LIST.COMPLAINTS_LIST, RIGHTS.EDIT),
  validate(complaintValidation.addTeamTask),
  checkComplaintVisibility,
  complaintController.addTeamTask,
);

router.patch(
  '/:complaintId/team-tasks/:taskId',
  checkRoleRight(RIGHT_LIST.COMPLAINTS_LIST, RIGHTS.EDIT),
  validate(complaintValidation.updateTeamTask),
  checkComplaintVisibility,
  complaintController.updateTeamTask,
);

router.post(
  '/:complaintId/actions/hand-to-someone',
  checkRoleRight(RIGHT_LIST.COMPLAINTS_LIST, RIGHTS.EDIT),
  ...withUpload,
  validate(complaintValidation.handToSomeoneElse),
  checkComplaintVisibility,
  complaintController.handToSomeoneElse,
);

router.post(
  '/:complaintId/actions/waiting',
  checkRoleRight(RIGHT_LIST.COMPLAINTS_LIST, RIGHTS.EDIT),
  ...withUpload,
  validate(complaintValidation.markWaiting),
  checkComplaintVisibility,
  complaintController.markWaiting,
);

router.post(
  '/:complaintId/actions/escalate',
  checkRoleRight(RIGHT_LIST.COMPLAINTS_LIST, RIGHTS.EDIT),
  ...withUpload,
  validate(complaintValidation.escalateComplaint),
  checkComplaintVisibility,
  complaintController.escalateComplaint,
);

router.post(
  '/:complaintId/actions/link',
  checkRoleRight(RIGHT_LIST.COMPLAINTS_LIST, RIGHTS.EDIT),
  ...withUpload,
  validate(complaintValidation.linkComplaint),
  checkComplaintVisibility,
  complaintController.linkComplaint,
);

router.post(
  '/:complaintId/actions/not-real',
  checkRoleRight(RIGHT_LIST.COMPLAINTS_LIST, RIGHTS.EDIT),
  ...withUpload,
  validate(complaintValidation.markNotReal),
  checkComplaintVisibility,
  complaintController.markNotReal,
);

router.post(
  '/:complaintId/actions/reopen',
  checkRoleRight(RIGHT_LIST.COMPLAINTS_LIST, RIGHTS.EDIT),
  validate(complaintValidation.reopenComplaint),
  checkComplaintVisibility,
  complaintController.reopenComplaint,
);

module.exports = router;
