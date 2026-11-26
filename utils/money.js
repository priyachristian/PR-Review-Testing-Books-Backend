const mongoose = require('mongoose');

const toIncrement = amount => mongoose.Types.Decimal128.fromString((Number(amount) || 0).toFixed(2));

module.exports = { toIncrement };
