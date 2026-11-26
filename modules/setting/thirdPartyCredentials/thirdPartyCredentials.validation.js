const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');

const companyIdQuery = Joi.object().keys({
  companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
    'any.required': '{{#label}} is required',
    'string.base': '{{#label}} must be a valid ObjectId',
  }),
  platformName: Joi.string().trim().max(50).optional().label('Platform Name'),
});

const encryptedPayload = Joi.object()
  .keys({
    iv: Joi.string().base64().required().label('IV'),
    ct: Joi.string().base64().required().label('Ciphertext'),
  })
  .label('Encrypted payload');

const credentialsBody = ({ passwordRequired }) =>
  Joi.object()
    .keys({
      payload: encryptedPayload.optional(),
      username: Joi.string().trim().max(100).label('Username'),
      password: Joi.string().trim().max(200).label('Password'),
      platformName: Joi.string().trim().max(50).optional().label('Platform Name'),
      isActive: Joi.boolean().optional().label('Is Active'),
    })
    .oxor('payload', 'username')
    .when(Joi.object({ payload: Joi.exist() }).unknown(), {
      then: Joi.object({ username: Joi.forbidden(), password: Joi.forbidden() }),
      otherwise: Joi.object({
        username: Joi.string().trim().max(100).required().label('Username').messages({
          'any.required': '{{#label}} is required',
        }),
        password: passwordRequired
          ? Joi.string().trim().max(200).required().label('Password').messages({
              'any.required': '{{#label}} is required',
            })
          : Joi.string().trim().max(200).allow('').optional().label('Password'),
      }),
    });

const getCredentials = {
  query: companyIdQuery,
};

const getAllCredentials = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
};

const createCredentials = {
  query: companyIdQuery,
  body: credentialsBody({ passwordRequired: true }),
};

const updateCredentials = {
  query: companyIdQuery,

  body: credentialsBody({ passwordRequired: false }),
};

const deleteCredentials = {
  query: companyIdQuery,
};

const revealCredentials = {
  query: companyIdQuery,
};

module.exports = {
  getCredentials,
  getAllCredentials,
  createCredentials,
  updateCredentials,
  deleteCredentials,
  revealCredentials,
};
