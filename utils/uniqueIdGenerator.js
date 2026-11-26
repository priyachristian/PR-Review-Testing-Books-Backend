const httpStatus = require('http-status');
const ApiError = require('../utils/ApiError');
const { getBooksCrmModels } = require('../services/model.service');

const SEQUENCE_ZERO_PAD = '0'.repeat(32);
const DEFAULT_STARTING_SEQUENCE = '1';

function incrementSequenceString(seq) {
  const seqStr = String(seq == null || seq === '' ? '0' : seq);
  const nextNum = parseInt(seqStr, 10) + 1;
  if (Number.isNaN(nextNum)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid sequence value');
  }
  const nextStr = nextNum.toString();
  const padLen = Math.max(seqStr.length, nextStr.length);
  return nextStr.padStart(padLen, '0');
}

function buildAdvanceSequencePipeline(by) {
  const current = {
    $let: {
      vars: { ns: { $toString: { $ifNull: ['$nextSequence', ''] } } },
      in: {
        $cond: [{ $eq: ['$$ns', ''] }, { $toString: { $ifNull: ['$startingSequence', DEFAULT_STARTING_SEQUENCE] } }, '$$ns'],
      },
    },
  };

  const advanced = {
    $let: {
      vars: { cur: current },
      in: {
        $let: {
          vars: { next: { $toString: { $add: [{ $toLong: '$$cur' }, by] } } },
          in: {
            $concat: [
              {
                $substrCP: [
                  SEQUENCE_ZERO_PAD,
                  0,
                  { $max: [0, { $subtract: [{ $strLenCP: '$$cur' }, { $strLenCP: '$$next' }] }] },
                ],
              },
              '$$next',
            ],
          },
        },
      },
    },
  };

  return [{ $set: { nextSequence: advanced } }];
}

async function reserveSequence(ModuleSettings, companyId, moduleName, count, hasProvidedId, session) {
  const filter = { companyId, moduleName, ...(hasProvidedId && { useCustomPrefix: true }) };

  let before = await ModuleSettings.findOneAndUpdate(filter, buildAdvanceSequencePipeline(count), {
    returnDocument: 'before',
    session,
    lean: true,
  });

  if (!before && hasProvidedId) {
    before = await ModuleSettings.findOne({ companyId, moduleName }).session(session).lean();
  }

  if (!before) {
    throw new ApiError(httpStatus.NOT_FOUND, `Module settings not found for ${moduleName}`);
  }

  return {
    settings: before,
    firstSequence: String(before.nextSequence || before.startingSequence || DEFAULT_STARTING_SEQUENCE),
  };
}

function buildCandidateIds(prefix, firstSequence, count) {
  const ids = [];
  let seq = firstSequence;
  for (let i = 0; i < count; i++) {
    ids.push(`${prefix}${seq}`);
    seq = incrementSequenceString(seq);
  }
  return ids;
}

/**
 * Returns the id to use for a document.
 * - Auto numbering (useCustomPrefix = true): the id is always generated from the sequence, providedId is ignored.
 * - Manual numbering (useCustomPrefix = false) with providedId: providedId is validated and returned.
 * - Manual numbering without providedId: generated with defaultPrefix.
 * Callers must use the returned value as the document id.
 */
async function generateUniqueId(model, companyId, moduleName, idField, defaultPrefix, session, providedId, extraFilter = {}) {
  const { ModuleSettings } = getBooksCrmModels();
  const hasProvidedId = Boolean(providedId);

  let { settings, firstSequence } = await reserveSequence(ModuleSettings, companyId, moduleName, 1, hasProvidedId, session);

  if (!settings.useCustomPrefix && hasProvidedId) {
    const existingDocument = await model.exists({ companyId, [idField]: providedId, ...extraFilter }).session(session);

    if (existingDocument) {
      throw new ApiError(httpStatus.CONFLICT, `${idField} with this id already exists for this company`);
    }

    return providedId;
  }

  const prefix = settings.useCustomPrefix ? settings.prefix : defaultPrefix;

  // A collision is only possible when existing ids are ahead of the counter (prefix change, earlier manual ids).
  // Each retry reserves the next number atomically, so concurrent requests never share a number.
  for (;;) {
    const potentialId = `${prefix}${firstSequence}`;
    const existingDocument = await model.exists({ companyId, [idField]: potentialId, ...extraFilter }).session(session);

    if (!existingDocument) {
      return potentialId;
    }

    ({ firstSequence } = await reserveSequence(ModuleSettings, companyId, moduleName, 1, hasProvidedId, session));
  }
}

async function generateMultipleUniqueIdsForModules(
  model,
  companyId,
  moduleConfigs, // Array of { moduleName, idField, defaultPrefix, count, resultKey, providedId }
  session,
) {
  const { ModuleSettings } = getBooksCrmModels();
  const result = {};

  for (const config of moduleConfigs) {
    const { moduleName, idField, defaultPrefix, count = 1, resultKey, providedId } = config;
    const hasProvidedId = Boolean(providedId);

    const { settings, firstSequence } = await reserveSequence(
      ModuleSettings,
      companyId,
      moduleName,
      count,
      hasProvidedId,
      session,
    );

    // Manual numbering with an explicit id: validate it, no generation
    if (!settings.useCustomPrefix && hasProvidedId) {
      const existingDocument = await model.exists({ companyId, [idField]: providedId }).session(session);

      if (existingDocument) {
        throw new ApiError(httpStatus.CONFLICT, `${idField} with this id already exists for this company`);
      }

      result[resultKey] = providedId;
      continue;
    }

    const prefix = settings.useCustomPrefix ? settings.prefix : defaultPrefix;
    const generatedIds = [];
    let startSequence = firstSequence;
    let needed = count;

    // One $in query per round instead of one query per id. Collisions are rare, so this is normally a single round.
    while (needed > 0) {
      const candidates = buildCandidateIds(prefix, startSequence, needed);
      const taken = await model
        .find({ companyId, [idField]: { $in: candidates } }, { [idField]: 1 })
        .session(session)
        .lean();
      const takenIds = new Set(taken.map(doc => doc[idField]));

      for (const candidate of candidates) {
        if (!takenIds.has(candidate)) generatedIds.push(candidate);
      }

      needed = count - generatedIds.length;
      if (needed > 0) {
        ({ firstSequence: startSequence } = await reserveSequence(
          ModuleSettings,
          companyId,
          moduleName,
          needed,
          hasProvidedId,
          session,
        ));
      }
    }

    result[resultKey] = count === 1 ? generatedIds[0] : generatedIds;
  }

  return result;
}

const COMPANY_CODE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function generateRandomCompanyCode() {
  let letters = '';
  for (let i = 0; i < 3; i++) {
    letters += COMPANY_CODE_LETTERS[Math.floor(Math.random() * COMPANY_CODE_LETTERS.length)];
  }
  const digits = Math.floor(1000 + Math.random() * 9000); // always 4 digits
  return `${letters}-${digits}`;
}

module.exports = { generateUniqueId, generateMultipleUniqueIdsForModules, incrementSequenceString, generateRandomCompanyCode };
