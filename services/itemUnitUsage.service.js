const { getBooksModels, getBooksCrmModels } = require('./model.service');

const ITEM_UNIT_MODEL_NAME = 'ItemUnit';

// Every schema path that references an ItemUnit, including nested sub-documents and arrays, e.g.
// 'items.itemUnitId', 'unitConversions.itemUnitId', 'deductions.sellingUnitId'. Read from the schemas themselves so a
// new unit field is covered without touching this list.
const collectItemUnitPaths = (schema, prefix = '') => {
  const paths = [];
  schema.eachPath((path, schemaType) => {
    const fullPath = `${prefix}${path}`;
    if (schemaType.schema) {
      paths.push(...collectItemUnitPaths(schemaType.schema, `${fullPath}.`));
      return;
    }
    const refs = [schemaType.options?.ref, schemaType.caster?.options?.ref, schemaType.$embeddedSchemaType?.options?.ref];
    if (refs.includes(ITEM_UNIT_MODEL_NAME)) paths.push(fullPath);
  });
  return paths;
};

const unitPathsByModel = new WeakMap();
const getItemUnitPaths = Model => {
  if (!unitPathsByModel.has(Model)) unitPathsByModel.set(Model, collectItemUnitPaths(Model.schema));
  return unitPathsByModel.get(Model);
};

const toLabel = modelName => modelName.replace(/([a-z])([A-Z])/g, '$1 $2');

const findItemUnitUsage = async (itemUnit, companyId) => {
  const models = [...new Set([...Object.values(getBooksCrmModels()), ...Object.values(getBooksModels())])];

  const results = await Promise.all(
    models.map(async Model => {
      if (!Model?.schema || Model.modelName === ITEM_UNIT_MODEL_NAME) return null;

      const unitConditions = getItemUnitPaths(Model).map(path => ({ [path]: itemUnit._id }));
      // Items created before itemUnitId existed carry the unit's name in the legacy `itemUnit` string.
      if (Model.modelName === 'Item') unitConditions.push({ itemUnit: itemUnit.name });
      if (!unitConditions.length) return null;

      const filter = { $or: unitConditions };
      if (Model.schema.path('companyId')) filter.companyId = companyId;

      return (await Model.exists(filter)) ? toLabel(Model.modelName) : null;
    }),
  );

  return [...new Set(results.filter(Boolean))];
};

module.exports = { findItemUnitUsage };
