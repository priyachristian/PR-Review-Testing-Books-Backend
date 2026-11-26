const url = require('url');

const authenticateSocketConnection = async req => {
  const { query } = url.parse(req.url, true);
  const { type, id } = query;

  // Customer portal user connection — authenticated by userId query param
  if (type === 'portal_user' && id) {
    return { user: { _id: id, userType: 'portal_user' } };
  }

  return { user: { _id: id, userType: 'abss_user' } };
};

module.exports = { authenticateSocketConnection };
