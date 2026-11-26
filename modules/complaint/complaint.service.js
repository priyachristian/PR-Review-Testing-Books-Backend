const httpStatus = require('http-status');
const { getBooksModels, getClientConnection } = require('../../services/model.service');
const ApiError = require('../../utils/ApiError');
const { COMPLAINT_MESSAGES } = require('../../utils/messages');
const { MODULE_NAMES } = require('../../utils/enum');
const { generateUniqueId } = require('../../utils/uniqueIdGenerator');
const { deleteFilesFromS3 } = require('../commonModule/fileUpload/fileUploadS3.service');
const {
  COMPLAINT_FORM_TYPES,
  COMPLAINT_STEPS,
  COMPLAINT_SKIPPABLE_STEPS: SKIPPABLE_STEPS,
} = require('@smit9313/abss-models-core/src/utils/enum');
const {
  LIST_SELECT_FIELDS,
  nextStepOf,
  pushHistory,
  pushUpdatedBy,
  getOrCreateStepRecord,
  markStepCompleted,
  advanceToStep,
  saveComplaint,
  mergeStepData,
  getPlainSubdoc,
  findComplaintOrThrow,
  loadComplaintForWork,
  assertActionable,
  assertNotAlreadyNotReal,
  buildProblemPathAndAttachments,
  resolveFormTypeFromPath,
  isProductRelatedPath,
  validateEvidence,
  enrichPhotoEvidence,
  validateCreateParties,
  calcDueDateFromDays,
  endWaitingIfActive,
  appendOptionalMedia,
  uploadCreateMedia,
  syncMediaField,
  buildListBaseQuery,
  buildListStatusQuery,
  mergeListQuery,
  getListStatusCounts,
  getOppositeProblemTypeCounts,
  loadListLookups,
  mapComplaintToListRow,
  populateComplaintRelations,
} = require('./complaint.helper');

const createComplaint = async (body, userId, attachmentFiles = [], photoFiles = []) => {
  const { ProblemList, Complaint } = getBooksModels();
  const { companyId, problemListId, formType } = body;

  validateCreateParties(body);

  const problem = await ProblemList.findOne({ _id: problemListId, companyId, isActive: true }).lean();
  if (!problem) {
    throw new ApiError(httpStatus.NOT_FOUND, COMPLAINT_MESSAGES.PROBLEM_NOT_FOUND);
  }

  const { problemPath, requiredAttachments } = await buildProblemPathAndAttachments(ProblemList, problem, companyId);
  const inferredFormType = resolveFormTypeFromPath(problemPath, problem.problemType);
  if (inferredFormType && inferredFormType !== formType) {
    throw new ApiError(httpStatus.BAD_REQUEST, COMPLAINT_MESSAGES.INVALID_FORM_TYPE);
  }

  validateEvidence(requiredAttachments, body.evidence || []);

  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  let newlyUploadedUrls = [];

  try {
    await session.startTransaction();

    const media = await uploadCreateMedia({
      attachmentFiles,
      photoFiles,
      body,
      userId,
      companyId,
    });
    newlyUploadedUrls = media.newlyUploadedUrls;

    const productRelated = formType === COMPLAINT_FORM_TYPES.CUSTOMER_ISSUE ? isProductRelatedPath(problemPath) : false;
    const evidence = enrichPhotoEvidence(body.evidence || [], media.photos);

    const complaintNo = await generateUniqueId(
      Complaint,
      companyId,
      MODULE_NAMES.COMPLAINTS,
      'complaintNo',
      'CMP',
      session,
      body.complaintNo,
    );

    const [complaint] = await Complaint.create(
      [
        {
          companyId,
          complaintNo,
          formType,
          problemType: problem.problemType,
          problemListId,
          problemPath,
          assignedTo: problem.assignedTo || null,
          department: problem.department || null,
          urgency: body.urgency || problem.urgency || 'MEDIUM',
          replyWithinHours: problem.replyWithinHours,
          sortOutWithinDays: problem.sortOutWithinDays,
          dueDate: calcDueDateFromDays(problem.sortOutWithinDays),
          currentStep: COMPLAINT_STEPS.NEW,
          title: body.title,
          notes: body.notes || '',
          fromDepartment: body.fromDepartment || null,
          againstDepartment: body.againstDepartment || null,
          raisedBy: body.raisedBy || userId,
          againstPersonId: body.againstPersonId || null,
          customerId: body.customerId || null,
          contactChannel: body.contactChannel || null,
          evidence,
          attachments: media.attachments,
          photos: media.photos,
          isProductRelated: productRelated,
          allowSkipSteps: !productRelated,
          steps: [{ step: COMPLAINT_STEPS.NEW, startedAt: new Date() }],
          history: [
            {
              step: COMPLAINT_STEPS.NEW,
              action: 'Raised',
              description: 'Complaint logged',
              addedBy: userId,
              createdAt: new Date(),
            },
          ],
          addedBy: userId,
          updatedBy: userId,
        },
      ],
      { session },
    );

    await session.commitTransaction();
    session.endSession();
    return complaint;
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    if (newlyUploadedUrls.length) {
      await deleteFilesFromS3(newlyUploadedUrls);
    }
    throw error;
  }
};

const queryComplaints = async (filter, options, visibilityQuery = {}) => {
  const { Complaint } = getBooksModels();
  const baseQuery = mergeListQuery(await buildListBaseQuery(filter), visibilityQuery);
  const listQuery = mergeListQuery(baseQuery, buildListStatusQuery(filter.status));

  const [result, statusCounts, oppositeCounts] = await Promise.all([
    Complaint.paginate(listQuery, {
      ...options,
      sortBy: options.sortBy || 'createdAt:desc',
      select: LIST_SELECT_FIELDS,
    }),
    getListStatusCounts(Complaint, baseQuery),
    getOppositeProblemTypeCounts(Complaint, filter, visibilityQuery),
  ]);

  const complaints = result.results || [];
  const lookups = await loadListLookups(complaints);

  return {
    ...result,
    results: complaints.map(complaint => mapComplaintToListRow(complaint, lookups)),
    statusCounts,
    ...oppositeCounts,
  };
};

const getComplaintsDropdown = async (filter, options = {}, visibilityQuery = {}) => {
  const { Complaint } = getBooksModels();

  const query = {
    companyId: filter.companyId,
    isNotRealComplaint: { $ne: true },
  };

  if (filter.customerId) query.customerId = filter.customerId;
  if (filter.problemType) query.problemType = filter.problemType;
  if (filter.excludeComplaintId) query._id = { $ne: filter.excludeComplaintId };

  if (filter.search && String(filter.search).trim()) {
    const regex = new RegExp(
      String(filter.search)
        .trim()
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      'i',
    );
    query.$or = [{ complaintNo: regex }, { title: regex }];
  }

  const result = await Complaint.paginate(mergeListQuery(query, visibilityQuery), {
    ...options,
    sortBy: options.sortBy || 'createdAt:desc',
    select: 'complaintNo title',
  });

  return {
    ...result,
    results: (result.results || []).map(complaint => {
      const doc = complaint.toObject ? complaint.toObject() : complaint;
      return {
        _id: doc._id,
        complaintNo: `${doc.complaintNo || ''}${doc.title ? ` - ${doc.title}` : ''}`.trim(),
        title: doc.title,
      };
    }),
  };
};

const getComplaintById = async (complaintId, companyId) => {
  const complaint = await findComplaintOrThrow(complaintId, companyId);
  return populateComplaintRelations(complaint);
};

const updateComplaintById = async (complaintId, companyId, body, userId, attachmentFiles = [], photoFiles = []) => {
  const complaint = await loadComplaintForWork(complaintId, companyId, COMPLAINT_STEPS.NEW);

  if (body.title !== undefined) complaint.title = body.title;
  if (body.notes !== undefined) complaint.notes = body.notes;
  if (body.raisedBy !== undefined) complaint.raisedBy = body.raisedBy;
  if (body.urgency !== undefined) complaint.urgency = body.urgency;

  if (body.evidence !== undefined) {
    const { ProblemList } = getBooksModels();
    const problem = await ProblemList.findOne({ _id: complaint.problemListId, companyId }).lean();
    if (!problem) {
      throw new ApiError(httpStatus.NOT_FOUND, COMPLAINT_MESSAGES.PROBLEM_NOT_FOUND);
    }
    const { requiredAttachments } = await buildProblemPathAndAttachments(ProblemList, problem, companyId);
    validateEvidence(requiredAttachments, body.evidence);
    complaint.evidence = body.evidence;
  }

  const previousAttachments = [...(complaint.attachments || [])];
  const previousPhotos = [...(complaint.photos || [])];
  let newlyUploadedUrls = [];

  try {
    // Defer S3 deletes until after save so a failed save does not drop kept objects.
    complaint.attachments = await syncMediaField({
      newFiles: attachmentFiles,
      currentUrls: body.attachments || previousAttachments,
      existingUrls: previousAttachments,
      userId,
      companyId,
      skipS3Deletion: true,
    });
    complaint.photos = await syncMediaField({
      newFiles: photoFiles,
      currentUrls: body.photos || previousPhotos,
      existingUrls: previousPhotos,
      userId,
      companyId,
      skipS3Deletion: true,
    });

    newlyUploadedUrls = [
      ...complaint.attachments.filter(url => url && !previousAttachments.includes(url)),
      ...complaint.photos.filter(url => url && !previousPhotos.includes(url)),
    ];

    if (body.evidence !== undefined) {
      complaint.evidence = enrichPhotoEvidence(complaint.evidence, complaint.photos);
    }

    const saved = await saveComplaint(complaint, userId);

    const urlsToDelete = [
      ...previousAttachments.filter(url => url && !complaint.attachments.includes(url)),
      ...previousPhotos.filter(url => url && !complaint.photos.includes(url)),
    ];
    if (urlsToDelete.length) {
      await deleteFilesFromS3(urlsToDelete);
    }

    return saved;
  } catch (error) {
    if (newlyUploadedUrls.length) {
      await deleteFilesFromS3(newlyUploadedUrls);
    }
    throw error;
  }
};

const deleteComplaintById = async (complaintId, companyId) => {
  const { Complaint } = getBooksModels();
  const complaint = await findComplaintOrThrow(complaintId, companyId);

  if (complaint.currentStep !== COMPLAINT_STEPS.NEW) {
    throw new ApiError(httpStatus.BAD_REQUEST, COMPLAINT_MESSAGES.DELETE_NOT_ALLOWED);
  }

  const s3Urls = [
    ...(complaint.attachments || []),
    ...(complaint.photos || []),
    ...(complaint.evidence || []).map(item => item?.fileUrl),
  ].filter(Boolean);
  const uniqueUrls = [...new Set(s3Urls)];

  await Complaint.deleteOne({ _id: complaintId, companyId });

  if (uniqueUrls.length) {
    await deleteFilesFromS3(uniqueUrls);
  }
};

const assignComplaint = async (complaintId, companyId, body, userId) => {
  const complaint = await loadComplaintForWork(complaintId, companyId, COMPLAINT_STEPS.NEW);

  const record = getOrCreateStepRecord(complaint, COMPLAINT_STEPS.NEW);
  record.assign = {
    department: body.department,
    personId: body.personId,
    reason: body.reason,
  };
  markStepCompleted(record, userId);

  complaint.assignedTo = body.personId;
  complaint.department = body.department;
  complaint.currentStep = COMPLAINT_STEPS.ASSIGNED;
  getOrCreateStepRecord(complaint, COMPLAINT_STEPS.ASSIGNED);

  pushHistory(complaint, {
    step: COMPLAINT_STEPS.NEW,
    action: 'Assigned',
    description: body.reason,
    userId,
  });

  return saveComplaint(complaint, userId);
};

const replyToCustomer = async (complaintId, companyId, body, userId, proofFiles = []) => {
  const complaint = await loadComplaintForWork(complaintId, companyId, COMPLAINT_STEPS.ASSIGNED);

  const proofUrls = await syncMediaField({
    newFiles: proofFiles,
    currentUrls: body.proofAttachments || [],
    existingUrls: [],
    userId,
    companyId,
  });

  const record = getOrCreateStepRecord(complaint, COMPLAINT_STEPS.ASSIGNED);
  mergeStepData(record, 'assigned', {
    channel: body.channel,
    message: body.message,
    proofAttachments: proofUrls,
    repliedAt: new Date(),
    repliedBy: userId,
  });

  pushHistory(complaint, {
    step: COMPLAINT_STEPS.ASSIGNED,
    action: 'Replied to customer',
    description: body.message,
    userId,
    attachments: proofUrls,
  });

  return saveComplaint(complaint, userId);
};

const startProgress = async (complaintId, companyId, body, userId) => {
  const complaint = await loadComplaintForWork(complaintId, companyId, COMPLAINT_STEPS.ASSIGNED);

  const record = getOrCreateStepRecord(complaint, COMPLAINT_STEPS.ASSIGNED);
  const assignedData = getPlainSubdoc(record.assigned);

  if (complaint.formType === COMPLAINT_FORM_TYPES.CUSTOMER_ISSUE && !assignedData.message) {
    throw new ApiError(httpStatus.BAD_REQUEST, COMPLAINT_MESSAGES.STEP_INCOMPLETE);
  }

  mergeStepData(record, 'assigned', { whatHappened: body.whatHappened });
  advanceToStep(complaint, COMPLAINT_STEPS.IN_PROGRESS, userId);

  pushHistory(complaint, {
    step: COMPLAINT_STEPS.ASSIGNED,
    action: 'Moved to In Progress',
    description: body.whatHappened,
    userId,
  });

  return saveComplaint(complaint, userId);
};

const saveWarranty = async (complaintId, companyId, body, userId) => {
  const complaint = await loadComplaintForWork(complaintId, companyId, COMPLAINT_STEPS.IN_PROGRESS);

  const record = getOrCreateStepRecord(complaint, COMPLAINT_STEPS.IN_PROGRESS);
  mergeStepData(record, 'inProgress', {
    warrantyPosition: body.warrantyPosition,
    warrantyWhy: body.why,
  });

  pushHistory(complaint, {
    step: COMPLAINT_STEPS.IN_PROGRESS,
    action: 'Warranty checked',
    description: body.why || body.warrantyPosition,
    userId,
  });

  return saveComplaint(complaint, userId);
};

const saveRootCause = async (complaintId, companyId, body, userId) => {
  const complaint = await loadComplaintForWork(complaintId, companyId, COMPLAINT_STEPS.IN_PROGRESS);

  const filledWhys = (body.whys || []).filter(item => String(item || '').trim());
  if (filledWhys.length < 3) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'At least three why levels are required');
  }

  const record = getOrCreateStepRecord(complaint, COMPLAINT_STEPS.IN_PROGRESS);
  mergeStepData(record, 'inProgress', {
    whys: body.whys,
    realCause: body.realCause,
    immediateFix: body.immediateFix,
    preventiveAction: body.preventiveAction,
    ensureByPersonId: body.ensureByPersonId,
    ensureByDate: body.ensureByDate,
  });

  pushHistory(complaint, {
    step: COMPLAINT_STEPS.IN_PROGRESS,
    action: 'Root cause recorded',
    description: body.realCause,
    userId,
  });

  return saveComplaint(complaint, userId);
};

const saveStopGap = async (complaintId, companyId, body, userId) => {
  const complaint = await loadComplaintForWork(complaintId, companyId, COMPLAINT_STEPS.IN_PROGRESS);

  const record = getOrCreateStepRecord(complaint, COMPLAINT_STEPS.IN_PROGRESS);
  mergeStepData(record, 'inProgress', { stopGapAction: body.stopGapAction });

  return saveComplaint(complaint, userId);
};

const recordProgress = async (complaintId, companyId, body, userId) => {
  const complaint = await loadComplaintForWork(complaintId, companyId, COMPLAINT_STEPS.IN_PROGRESS);

  const record = getOrCreateStepRecord(complaint, COMPLAINT_STEPS.IN_PROGRESS);
  const data = getPlainSubdoc(record.inProgress);

  if (!data.warrantyPosition || !data.warrantyWhy || !data.realCause || !data.immediateFix || !data.preventiveAction) {
    throw new ApiError(httpStatus.BAD_REQUEST, COMPLAINT_MESSAGES.STEP_INCOMPLETE);
  }

  mergeStepData(record, 'inProgress', { whatHappened: body.whatHappened });
  advanceToStep(complaint, COMPLAINT_STEPS.ACTION_TAKEN, userId);

  pushHistory(complaint, {
    step: COMPLAINT_STEPS.IN_PROGRESS,
    action: 'Moved to Action Taken',
    description: body.whatHappened,
    userId,
  });

  return saveComplaint(complaint, userId);
};

const saveSettlement = async (complaintId, companyId, body, userId) => {
  const complaint = await loadComplaintForWork(complaintId, companyId, COMPLAINT_STEPS.ACTION_TAKEN);

  const record = getOrCreateStepRecord(complaint, COMPLAINT_STEPS.ACTION_TAKEN);
  mergeStepData(record, 'actionTaken', {
    settlementType: body.settlementType,
    pieces: body.pieces ?? null,
    costInRupees: body.costInRupees,
    summary: body.summary,
  });

  pushHistory(complaint, {
    step: COMPLAINT_STEPS.ACTION_TAKEN,
    action: 'Settlement recorded',
    description: body.summary,
    userId,
  });

  return saveComplaint(complaint, userId);
};

const completeActionTaken = async (complaintId, companyId, body, userId) => {
  const complaint = await loadComplaintForWork(complaintId, companyId, COMPLAINT_STEPS.ACTION_TAKEN);

  const record = getOrCreateStepRecord(complaint, COMPLAINT_STEPS.ACTION_TAKEN);
  const data = getPlainSubdoc(record.actionTaken);
  if (!data.summary || !data.settlementType || data.costInRupees == null) {
    throw new ApiError(httpStatus.BAD_REQUEST, COMPLAINT_MESSAGES.STEP_INCOMPLETE);
  }

  mergeStepData(record, 'actionTaken', { whatHappened: body.whatHappened });
  advanceToStep(complaint, COMPLAINT_STEPS.VERIFIED, userId);

  pushHistory(complaint, {
    step: COMPLAINT_STEPS.ACTION_TAKEN,
    action: 'Moved to Verified',
    description: body.whatHappened,
    userId,
  });

  return saveComplaint(complaint, userId);
};

const verifyFix = async (complaintId, companyId, body, userId) => {
  const complaint = await loadComplaintForWork(complaintId, companyId, COMPLAINT_STEPS.VERIFIED);

  const record = getOrCreateStepRecord(complaint, COMPLAINT_STEPS.VERIFIED);
  record.verified = {
    fixHeldResult: body.fixHeldResult,
    howDoYouKnow: body.howDoYouKnow,
  };

  pushHistory(complaint, {
    step: COMPLAINT_STEPS.VERIFIED,
    action: 'Verified',
    description: body.howDoYouKnow,
    userId,
  });

  return saveComplaint(complaint, userId);
};

const closeComplaint = async (complaintId, companyId, body, userId) => {
  const complaint = await findComplaintOrThrow(complaintId, companyId);
  if (complaint.isNotRealComplaint) {
    throw new ApiError(httpStatus.BAD_REQUEST, COMPLAINT_MESSAGES.ALREADY_NOT_REAL);
  }
  if (complaint.isClosed) {
    throw new ApiError(httpStatus.BAD_REQUEST, COMPLAINT_MESSAGES.ALREADY_CLOSED);
  }
  endWaitingIfActive(complaint);

  if (complaint.currentStep === COMPLAINT_STEPS.VERIFIED) {
    const verifiedRecord = getOrCreateStepRecord(complaint, COMPLAINT_STEPS.VERIFIED);
    const verifiedData = getPlainSubdoc(verifiedRecord.verified);
    if (!verifiedRecord.isSkipped && (!verifiedData.fixHeldResult || !verifiedData.howDoYouKnow)) {
      throw new ApiError(httpStatus.BAD_REQUEST, COMPLAINT_MESSAGES.STEP_INCOMPLETE);
    }
    advanceToStep(complaint, COMPLAINT_STEPS.CLOSED, userId);
  } else if (complaint.currentStep !== COMPLAINT_STEPS.CLOSED) {
    throw new ApiError(httpStatus.BAD_REQUEST, COMPLAINT_MESSAGES.INVALID_STEP);
  }

  const closedRecord = getOrCreateStepRecord(complaint, COMPLAINT_STEPS.CLOSED);
  closedRecord.closed = {
    howItEnded: body.howItEnded,
    customerSatisfaction: body.customerSatisfaction ?? null,
  };
  markStepCompleted(closedRecord, userId);
  complaint.isClosed = true;

  pushHistory(complaint, {
    step: COMPLAINT_STEPS.CLOSED,
    action: 'Closed',
    description: body.howItEnded,
    userId,
  });

  return saveComplaint(complaint, userId);
};

const skipCurrentStep = async (complaintId, companyId, body, userId) => {
  const complaint = await loadComplaintForWork(complaintId, companyId);

  if (!complaint.allowSkipSteps) {
    throw new ApiError(httpStatus.BAD_REQUEST, COMPLAINT_MESSAGES.SKIP_NOT_ALLOWED);
  }

  const current = complaint.currentStep;
  if (!SKIPPABLE_STEPS.includes(current)) {
    throw new ApiError(httpStatus.BAD_REQUEST, COMPLAINT_MESSAGES.SKIP_NOT_ALLOWED);
  }

  const next = nextStepOf(current);
  if (!next) {
    throw new ApiError(httpStatus.BAD_REQUEST, COMPLAINT_MESSAGES.INVALID_STEP);
  }

  const record = getOrCreateStepRecord(complaint, current);
  record.isSkipped = true;
  record.skippedAt = new Date();
  record.skippedBy = userId;
  record.skipReason = body?.skipReason || 'Not applicable for this complaint';
  advanceToStep(complaint, next, userId);

  pushHistory(complaint, {
    step: current,
    action: 'Step skipped',
    description: record.skipReason,
    userId,
  });

  return saveComplaint(complaint, userId);
};

const addTeamNote = async (complaintId, companyId, body, userId) => {
  const complaint = await loadComplaintForWork(complaintId, companyId);
  complaint.teamNotes.push({
    text: body.text,
    addedBy: userId,
    createdAt: new Date(),
  });
  return saveComplaint(complaint, userId);
};

const addTeamTask = async (complaintId, companyId, body, userId) => {
  const complaint = await loadComplaintForWork(complaintId, companyId);
  complaint.teamTasks.push({
    title: body.title,
    assignedTo: body.assignedTo || null,
    dueDate: body.dueDate || null,
    isDone: false,
    addedBy: userId,
    createdAt: new Date(),
  });
  return saveComplaint(complaint, userId);
};

const updateTeamTask = async (complaintId, companyId, taskId, body, userId) => {
  const complaint = await loadComplaintForWork(complaintId, companyId);
  const task = complaint.teamTasks.id(taskId);
  if (!task) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Team task not found');
  }

  if (body.title !== undefined) task.title = body.title;
  if (body.assignedTo !== undefined) task.assignedTo = body.assignedTo;
  if (body.dueDate !== undefined) task.dueDate = body.dueDate;
  if (body.isDone !== undefined) {
    task.isDone = body.isDone;
    task.completedAt = body.isDone ? new Date() : null;
  }

  return saveComplaint(complaint, userId);
};

const runOtherAction = async ({
  complaintId,
  companyId,
  body,
  userId,
  attachmentFiles = [],
  photoFiles = [],
  requireActionable = true,
  endWaiting = true,
  apply,
  history,
}) => {
  const complaint = await findComplaintOrThrow(complaintId, companyId);
  if (requireActionable) assertActionable(complaint);
  if (endWaiting) endWaitingIfActive(complaint);

  const { actionAttachments, actionPhotos } = await appendOptionalMedia(complaint, {
    attachmentFiles,
    photoFiles,
    body,
    userId,
    companyId,
  });

  await apply(complaint);

  pushHistory(complaint, {
    step: complaint.currentStep,
    ...history,
    userId,
    attachments: actionAttachments,
    photos: actionPhotos,
  });

  return saveComplaint(complaint, userId);
};

const handToSomeoneElse = async (complaintId, companyId, body, userId, attachmentFiles = [], photoFiles = []) =>
  runOtherAction({
    complaintId,
    companyId,
    body,
    userId,
    attachmentFiles,
    photoFiles,
    endWaiting: true,
    apply: complaint => {
      complaint.department = body.department;
      complaint.assignedTo = body.personId;
    },
    history: {
      action: 'Handed to someone else',
      description: body.reason,
    },
  });

const markWaiting = async (complaintId, companyId, body, userId, attachmentFiles = [], photoFiles = []) => {
  const complaint = await findComplaintOrThrow(complaintId, companyId);
  assertActionable(complaint);

  let historyAction;
  let historyDescription;

  if (body.isWaiting === false) {
    if (!complaint.isWaiting) {
      throw new ApiError(httpStatus.BAD_REQUEST, COMPLAINT_MESSAGES.NOT_WAITING);
    }
    endWaitingIfActive(complaint);
    historyAction = 'Waiting cleared';
    historyDescription = 'Resumed work';
  } else {
    if (complaint.isWaiting) {
      throw new ApiError(httpStatus.BAD_REQUEST, COMPLAINT_MESSAGES.ALREADY_WAITING);
    }
    complaint.isWaiting = true;
    complaint.waitingReason = body.waitingReason;
    complaint.waitingWhy = body.why;
    complaint.waitingStartedAt = new Date();
    complaint.waitingEndedAt = null;
    historyAction = 'Waiting on someone';
    historyDescription = body.why;
  }

  const { actionAttachments, actionPhotos } = await appendOptionalMedia(complaint, {
    attachmentFiles,
    photoFiles,
    body,
    userId,
    companyId,
  });

  pushHistory(complaint, {
    step: complaint.currentStep,
    action: historyAction,
    description: historyDescription,
    userId,
    attachments: actionAttachments,
    photos: actionPhotos,
  });

  return saveComplaint(complaint, userId);
};

const escalateComplaint = async (complaintId, companyId, body, userId, attachmentFiles = [], photoFiles = []) => {
  const history = {
    action: 'Escalated',
    description: body.reason,
  };

  return runOtherAction({
    complaintId,
    companyId,
    body,
    userId,
    attachmentFiles,
    photoFiles,
    endWaiting: true,
    apply: complaint => {
      const nextLevel = (complaint.escalationLevel || 0) + 1;
      complaint.assignedTo = body.personId;
      complaint.escalationLevel = nextLevel;
      complaint.escalationReason = body.reason;
      complaint.escalatedAt = new Date();
      complaint.escalatedBy = userId;
      history.action = `Escalated to L${nextLevel}`;
    },
    history,
  });
};

const linkComplaint = async (complaintId, companyId, body, userId, attachmentFiles = [], photoFiles = []) => {
  const { Complaint } = getBooksModels();

  if (String(complaintId) === String(body.linkedComplaintId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, COMPLAINT_MESSAGES.LINK_SELF_NOT_ALLOWED);
  }

  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  let newlyUploadedUrls = [];

  try {
    await session.startTransaction();

    const complaint = await Complaint.findOne({ _id: complaintId, companyId }).session(session);
    if (!complaint) {
      throw new ApiError(httpStatus.NOT_FOUND, COMPLAINT_MESSAGES.FETCH_ONE_NOT_FOUND);
    }
    assertNotAlreadyNotReal(complaint);
    endWaitingIfActive(complaint);

    const other = await Complaint.findOne({ _id: body.linkedComplaintId, companyId }).session(session);
    if (!other) {
      throw new ApiError(httpStatus.NOT_FOUND, COMPLAINT_MESSAGES.LINK_TARGET_NOT_FOUND);
    }

    const alreadyLinkedOnSource = (complaint.linkedComplaints || []).some(
      link => String(link.complaintId) === String(body.linkedComplaintId),
    );
    const alreadyLinkedOnTarget = (other.linkedComplaints || []).some(link => String(link.complaintId) === String(complaintId));
    if (alreadyLinkedOnSource || alreadyLinkedOnTarget) {
      throw new ApiError(httpStatus.BAD_REQUEST, COMPLAINT_MESSAGES.LINK_ALREADY_EXISTS);
    }

    const { actionAttachments, actionPhotos } = await appendOptionalMedia(complaint, {
      attachmentFiles,
      photoFiles,
      body,
      userId,
      companyId,
    });
    newlyUploadedUrls = [...actionAttachments, ...actionPhotos];

    const linkedAt = new Date();
    complaint.linkedComplaints.push({
      complaintId: other._id,
      connectionType: body.connectionType,
      linkedBy: userId,
      linkedAt,
    });
    other.linkedComplaints.push({
      complaintId: complaint._id,
      connectionType: body.connectionType,
      linkedBy: userId,
      linkedAt,
    });

    pushHistory(complaint, {
      step: complaint.currentStep,
      action: 'Linked another complaint',
      description: `${body.connectionType} → ${other.complaintNo}`,
      userId,
      attachments: actionAttachments,
      photos: actionPhotos,
    });
    pushHistory(other, {
      step: other.currentStep,
      action: 'Linked from another complaint',
      description: `${body.connectionType} ← ${complaint.complaintNo}`,
      userId,
    });

    pushUpdatedBy(complaint, userId);
    pushUpdatedBy(other, userId);
    await complaint.save({ session });
    await other.save({ session });

    await session.commitTransaction();
    session.endSession();
    return populateComplaintRelations(complaint);
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    if (newlyUploadedUrls.length) {
      await deleteFilesFromS3(newlyUploadedUrls);
    }
    throw error;
  }
};

const markNotReal = async (complaintId, companyId, body, userId, attachmentFiles = [], photoFiles = []) =>
  runOtherAction({
    complaintId,
    companyId,
    body,
    userId,
    attachmentFiles,
    photoFiles,
    requireActionable: false,
    endWaiting: true,
    apply: complaint => {
      assertNotAlreadyNotReal(complaint);
      complaint.isNotRealComplaint = true;
      complaint.isClosed = true;
      complaint.countsInReports = false;
      complaint.notRealReason = body.reason;
      complaint.notRealNote = body.note || null;
      complaint.notRealMarkedAt = new Date();
      complaint.notRealMarkedBy = userId;
    },
    history: {
      action: 'Marked not a real complaint',
      description: body.note || body.reason,
    },
  });

const reopenComplaint = async (complaintId, companyId, body, userId) => {
  const complaint = await findComplaintOrThrow(complaintId, companyId);

  if (complaint.isNotRealComplaint) {
    throw new ApiError(httpStatus.BAD_REQUEST, COMPLAINT_MESSAGES.ALREADY_NOT_REAL);
  }
  if (!complaint.isClosed) {
    throw new ApiError(httpStatus.BAD_REQUEST, COMPLAINT_MESSAGES.NOT_CLOSED);
  }

  endWaitingIfActive(complaint);

  complaint.isClosed = false;
  complaint.currentStep = COMPLAINT_STEPS.IN_PROGRESS;
  complaint.reopenCount = (complaint.reopenCount || 0) + 1;
  complaint.lastReopenReason = body.reason;
  complaint.lastReopenNote = body.note || null;
  complaint.lastReopenedAt = new Date();
  complaint.lastReopenedBy = userId;

  const inProgressRecord = getOrCreateStepRecord(complaint, COMPLAINT_STEPS.IN_PROGRESS);
  inProgressRecord.completedAt = null;
  inProgressRecord.completedBy = null;

  pushHistory(complaint, {
    step: COMPLAINT_STEPS.IN_PROGRESS,
    action: 'Opened again',
    description: body.note || body.reason,
    userId,
  });

  return saveComplaint(complaint, userId);
};

module.exports = {
  createComplaint,
  queryComplaints,
  getComplaintsDropdown,
  getComplaintById,
  updateComplaintById,
  deleteComplaintById,
  assignComplaint,
  replyToCustomer,
  startProgress,
  saveWarranty,
  saveRootCause,
  saveStopGap,
  recordProgress,
  saveSettlement,
  completeActionTaken,
  verifyFix,
  closeComplaint,
  skipCurrentStep,
  addTeamNote,
  addTeamTask,
  updateTeamTask,
  handToSomeoneElse,
  markWaiting,
  escalateComplaint,
  linkComplaint,
  markNotReal,
  reopenComplaint,
};
