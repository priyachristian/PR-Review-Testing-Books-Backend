/**
 * Seeds the default Problem List tree for Books companies that already have users.
 *
 * - With <companyId>: runs for that one company only (no userRole check)
 * - Without <companyId>: all companies that have a books.userroles record
 * - Idempotent: inserts missing nodes by (companyId + parentProblemId + name)
 * - Marks matched nodes as isSystemGenerated: true
 *
 * Run: node migrations/seedDefaultProblemList-remove.js                      (report, all eligible)
 *      node migrations/seedDefaultProblemList-remove.js <companyId>           (report, one company)
 *      node migrations/seedDefaultProblemList-remove.js --apply               (write, all eligible)
 *      node migrations/seedDefaultProblemList-remove.js <companyId> --apply   (write, one company)
 */
const { ObjectId } = require('mongodb');
const { getConnection, closeConnection } = require('../config/db');
const {
  DEFAULT_PROBLEM_LIST_TREE,
  buildDefaultProblemListDocs,
  sameAttachments,
} = require('@smit9313/abss-models-core/src/utils/defaultProblemList');

const parentKey = parentProblemId => (parentProblemId ? parentProblemId.toString() : 'null');

const ensureTree = async (collection, companyId, addedBy, apply) => {
  const existing = await collection
    .find({ companyId })
    .project({ _id: 1, parentProblemId: 1, name: 1, isSystemGenerated: 1, requiredAttachments: 1 })
    .toArray();

  if (!existing.length) {
    const docs = buildDefaultProblemListDocs(companyId, addedBy, ObjectId);
    if (apply) {
      await collection.insertMany(docs, { ordered: true });
    }
    return { inserted: docs.length, updated: 0 };
  }

  const byParentName = new Map();
  for (const doc of existing) {
    byParentName.set(`${parentKey(doc.parentProblemId)}::${doc.name}`, doc);
  }

  let inserted = 0;
  let updated = 0;

  const walk = async (nodes, parentProblemId, problemType) => {
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      const resolvedType = problemType || node.problemType;
      const requiredAttachments = node.requiredAttachments || [];
      const key = `${parentKey(parentProblemId)}::${node.name}`;
      let doc = byParentName.get(key);

      if (!doc) {
        const now = new Date();
        const _id = new ObjectId();
        const newDoc = {
          _id,
          companyId,
          parentProblemId: parentProblemId || null,
          problemType: resolvedType,
          name: node.name,
          sortOrder: i,
          department: null,
          assignedTo: null,
          urgency: 'MEDIUM',
          replyWithinHours: null,
          sortOutWithinDays: null,
          requiredAttachments,
          visibility: 'EVERYONE',
          canAddChild: true,
          isActive: true,
          isSystemGenerated: true,
          addedBy: addedBy || null,
          updatedBy: addedBy ? [{ userId: addedBy, updatedAt: now }] : [],
          createdAt: now,
          updatedAt: now,
        };

        inserted += 1;
        if (apply) {
          // eslint-disable-next-line no-await-in-loop
          await collection.insertOne(newDoc);
        }
        doc = newDoc;
        byParentName.set(key, doc);
      } else {
        const patch = {};
        if (!doc.isSystemGenerated) {
          patch.isSystemGenerated = true;
        }
        if (!sameAttachments(doc.requiredAttachments, requiredAttachments)) {
          patch.requiredAttachments = requiredAttachments;
        }

        if (Object.keys(patch).length) {
          updated += 1;
          if (apply) {
            // eslint-disable-next-line no-await-in-loop
            await collection.updateOne({ _id: doc._id }, { $set: patch });
          }
        }
      }

      if (node.children?.length) {
        // eslint-disable-next-line no-await-in-loop
        await walk(node.children, doc._id, resolvedType);
      }
    }
  };

  await walk(DEFAULT_PROBLEM_LIST_TREE, null, null);
  return { inserted, updated };
};

const migrate = async () => {
  let client;
  try {
    const db = await getConnection();
    client = db.client;

    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const companyArg = args.find(arg => !arg.startsWith('--'));
    const targetCompanyId = companyArg ? new ObjectId(companyArg) : null;

    console.log(`\nScope  : ${targetCompanyId ? targetCompanyId.toString() : 'ALL ELIGIBLE BOOKS COMPANIES'}`);
    console.log(apply ? 'Mode   : APPLYING CHANGES\n' : 'Mode   : report only — pass --apply to write\n');

    const booksUserRoles = db.books.collection('userroles');
    const problemLists = db.books.collection('problemlists');

    // One company: use the given id directly
    // All companies: only those with a books userRole
    let eligibleCompanyIds;
    if (targetCompanyId) {
      eligibleCompanyIds = [targetCompanyId];
    } else {
      eligibleCompanyIds = await booksUserRoles.distinct('companyId', { companyId: { $ne: null } });
    }

    console.log(
      targetCompanyId
        ? `Target company: ${targetCompanyId.toString()}\n`
        : `Eligible companies (books userRole): ${eligibleCompanyIds.length}\n`,
    );

    let companiesTouched = 0;
    let totalInserted = 0;
    let totalUpdated = 0;

    for (const companyId of eligibleCompanyIds) {
      // eslint-disable-next-line no-await-in-loop
      const creator = await booksUserRoles.findOne({ companyId }, { projection: { userId: 1 } });
      const addedBy = creator?.userId || null;

      // eslint-disable-next-line no-await-in-loop
      const result = await ensureTree(problemLists, companyId, addedBy, apply);
      if (result.inserted || result.updated) {
        companiesTouched += 1;
        totalInserted += result.inserted;
        totalUpdated += result.updated;
        console.log(`  ${companyId.toString()}  insert=${result.inserted} update=${result.updated}`);
      }
    }

    console.log('\nSUMMARY');
    console.log(`   companies touched : ${companiesTouched}`);
    console.log(`   nodes to insert   : ${totalInserted}`);
    console.log(`   nodes to update   : ${totalUpdated}`);

    if (!apply) {
      console.log('\nNothing was written. Re-run with --apply to seed.\n');
      return;
    }

    console.log('\nDefault problem list seeded.\n');
  } catch (error) {
    console.error('Problem list seed failed:', error);
    process.exitCode = 1;
  } finally {
    await closeConnection(client);
  }
};

migrate();
